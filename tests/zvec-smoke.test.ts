import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ZVecCreateAndOpen,
  ZVecOpen,
  ZVecCollectionSchema,
  ZVecDataType,
  ZVecIndexType,
  ZVecMetricType,
  isZVecError,
} from '@zvec/zvec'

/**
 * Phase 0 smoke test: 锁定 Zvec Node SDK 真实 API 形态。
 * 验证端到端链路：create(dim=1024,cosine,HNSW) → upsert 带 metadata →
 * query topK + filter → reopen。跑通才说明接入可行。
 */
describe('zvec smoke (real native binding)', () => {
  let dirs: string[] = []

  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true })
    dirs = []
  })

  // ZVecCreateAndOpen 要求 collection 路径尚不存在，故在临时父目录下取一个不存在的子路径。
  const newDir = () => {
    const parent = mkdtempSync(join(tmpdir(), 'zvec-smoke-'))
    dirs.push(parent)
    return join(parent, 'col')
  }

  it('builds 1024-dim cosine HNSW collection and round-trips vectors', () => {
    const path = newDir()
    const schema = new ZVecCollectionSchema({
      name: 'queries',
      vectors: {
        name: 'embedding',
        dataType: ZVecDataType.VECTOR_FP32,
        dimension: 1024,
        indexParams: {
          indexType: ZVecIndexType.HNSW,
          metricType: ZVecMetricType.COSINE,
          m: 16,
          efConstruction: 200,
        },
      },
      fields: [
        { name: 'workspaceId', dataType: ZVecDataType.STRING },
      ],
    })

    const col = ZVecCreateAndOpen(path, schema)
    expect(col.path).toBe(path)

    // 近似 1024 维向量（自相似，便于断言召回顺序）
    const mk = (seed: number) => Array.from({ length: 1024 }, (_, i) => (i === seed ? 1 : 0))

    col.upsertSync([
      { id: 'q1', vectors: { embedding: mk(0) }, fields: { workspaceId: 'ws-a' } },
      { id: 'q2', vectors: { embedding: mk(1) }, fields: { workspaceId: 'ws-a' } },
      { id: 'q3', vectors: { embedding: mk(2) }, fields: { workspaceId: 'ws-b' } },
    ])

    const hits = col.querySync({
      fieldName: 'embedding',
      vector: mk(0),
      topk: 2,
      includeVector: false,
    })
    expect(hits.length).toBe(2)
    expect(hits[0].id).toBe('q1')
    // cosine 下 score 是"距离"语义（0 = 完全相同，越大越远），故最近邻 score 最小
    expect(hits[0].score).toBeLessThanOrEqual(hits[1].score)
  })

  it('filters results by scalar field (workspace isolation)', () => {
    const path = newDir()
    const schema = new ZVecCollectionSchema({
      name: 'entities',
      vectors: {
        name: 'embedding',
        dataType: ZVecDataType.VECTOR_FP32,
        dimension: 1024,
        indexParams: { indexType: ZVecIndexType.HNSW, metricType: ZVecMetricType.COSINE },
      },
      fields: [{ name: 'workspaceId', dataType: ZVecDataType.STRING }],
    })
    const col = ZVecCreateAndOpen(path, schema)
    const mk = (seed: number) => Array.from({ length: 1024 }, (_, i) => (i === seed ? 1 : 0))

    col.upsertSync([
      { id: 'e1', vectors: { embedding: mk(5) }, fields: { workspaceId: 'ws-a' } },
      { id: 'e2', vectors: { embedding: mk(5) }, fields: { workspaceId: 'ws-b' } },
    ])

    // filter DSL 形态验证：字符串表达式
    const hits = col.querySync({
      fieldName: 'embedding',
      vector: mk(5),
      topk: 5,
      filter: "workspaceId = 'ws-a'",
    })
    expect(hits.every((h) => h.fields.workspaceId === 'ws-a')).toBe(true)
  })

  it('persists to disk and reopens via ZVecOpen', () => {
    const path = newDir()
    const schema = new ZVecCollectionSchema({
      name: 'atoms',
      vectors: {
        name: 'embedding',
        dataType: ZVecDataType.VECTOR_FP32,
        dimension: 1024,
        indexParams: { indexType: ZVecIndexType.HNSW, metricType: ZVecMetricType.COSINE },
      },
      fields: [{ name: 'workspaceId', dataType: ZVecDataType.STRING }],
    })

    const col = ZVecCreateAndOpen(path, schema)
    const v = Array.from({ length: 1024 }, () => 0.1)
    col.upsertSync([{ id: 'a1', vectors: { embedding: v }, fields: { workspaceId: 'ws-a' } }])
    col.optimizeSync()
    col.closeSync()

    expect(existsSync(path)).toBe(true)

    const reopened = ZVecOpen(path)
    const hits = reopened.querySync({ fieldName: 'embedding', vector: v, topk: 1 })
    expect(hits[0].id).toBe('a1')
  })

  it('classifies errors via isZVecError', () => {
    const path = newDir()
    const schema = new ZVecCollectionSchema({
      name: 'dup',
      vectors: {
        name: 'embedding',
        dataType: ZVecDataType.VECTOR_FP32,
        dimension: 1024,
      },
    })
    ZVecCreateAndOpen(path, schema)

    // 二次 create 同路径应抛 ZVecError（实测为 INVALID_ARGUMENT，路径已存在）
    try {
      ZVecCreateAndOpen(path, schema)
      throw new Error('should have thrown')
    } catch (e) {
      expect(isZVecError(e)).toBe(true)
      if (isZVecError(e)) expect(e.code).toBe('ZVEC_INVALID_ARGUMENT')
    }
  })
})
