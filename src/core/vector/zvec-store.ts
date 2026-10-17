import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  ZVecCreateAndOpen,
  ZVecOpen,
  ZVecCollectionSchema,
  ZVecDataType,
  ZVecIndexType,
  ZVecMetricType,
  ZVecCollection,
  isZVecError,
} from '@zvec/zvec'
import type {
  VectorRecord,
  SearchHit,
  SearchFilter,
  VectorStore,
} from './store.js'

/**
 * Zvec 向量库实现。
 *
 * 关键行为（基于 Phase 0 实测的真实 API）：
 * - ZVecCreateAndOpen 要求路径尚不存在；已存在则用 ZVecOpen 打开。
 * - cosine 的 score 是「距离」语义（0 = 完全相同，越大越远）；
 *   本实现统一转换为「相似度」= 1 - distance，对业务暴露「越大越相似」。
 * - filter 为字符串 DSL，形如 "workspaceId = 'ws-a' AND type = 'PRODUCT'"。
 *
 * 线程模型：Zvec 是进程内嵌入式库，同步写入（upsertSync/querySync）会阻塞事件循环。
 * 当前数据规模小、写入均为低频后台任务，可接受；规模增长后可改用异步变体或 worker。
 */

const EMBEDDING_DIM = Number(process.env.ZVEC_DIM || 1024)
const DATA_ROOT = process.env.ZVEC_DATA_PATH || './data/zvec'

type ScalarValue = string | number | boolean

/** 三个业务 collection 的 schema 定义（公共标量字段 + 各自向量字段）。 */
function buildSchema(name: string): ZVecCollectionSchema {
  return new ZVecCollectionSchema({
    name,
    vectors: {
      name: 'embedding',
      dataType: ZVecDataType.VECTOR_FP32,
      dimension: EMBEDDING_DIM,
      indexParams: {
        indexType: ZVecIndexType.HNSW,
        metricType: ZVecMetricType.COSINE,
        m: 16,
        efConstruction: 200,
      },
    },
    // workspaceId 建倒排索引以加速过滤；其余标量仅存储。
    // name（kg-repo indexEntity 写入）与 cluster（query-library 聚类标记写入，
    // 可选）此前不在 schema：写入方各自 catch 吞掉 Field not found，KG 实体
    // 索引与查询聚类的向量写入一直在静默失败（lc compose 验收的确定性向量
    // 步骤暴露）。存量 zvec 目录按旧建库 schema 固化，需删除后重建。
    fields: [
      { name: 'workspaceId', dataType: ZVecDataType.STRING, indexParams: { indexType: ZVecIndexType.INVERT } },
      { name: 'sourceType', dataType: ZVecDataType.STRING },
      { name: 'name', dataType: ZVecDataType.STRING, nullable: true },
      { name: 'cluster', dataType: ZVecDataType.STRING, nullable: true },
    ],
  })
}

/** 打开或创建某个 collection（路径存在则 open，否则 create）。
 *  existsSync 与 create 之间存在 TOCTOU 窗口：若并发/竞态导致目录被其他进程抢先创建，
 *  ZVecCreateAndOpen 会失败，此时回退为 ZVecOpen。 */
function openOrCreate(name: string): ZVecCollection {
  const path = join(DATA_ROOT, name)
  if (existsSync(path)) {
    return ZVecOpen(path)
  }
  try {
    return ZVecCreateAndOpen(path, buildSchema(name))
  } catch (e) {
    if (isZVecError(e) && existsSync(path)) {
      return ZVecOpen(path)
    }
    throw e
  }
}

/** 把 SearchFilter 对象拼成 Zvec 的字符串 filter DSL。 */
function toFilterExpr(filter?: SearchFilter): string | undefined {
  if (!filter || Object.keys(filter).length === 0) return undefined
  return Object.entries(filter)
    .map(([k, v]) => (typeof v === 'string' ? `${k} = '${v.replace(/'/g, "\\'")}'` : `${k} = ${v}`))
    .join(' AND ')
}

/** 把 ZVecDoc 的 fields 平铺成 metadata。 */
function toMetadata(fields: Record<string, unknown>): Record<string, unknown> {
  return { ...fields }
}

export class ZvecStore implements VectorStore {
  readonly COLLECTIONS = { queries: 'queries', entities: 'entities', atoms: 'atoms' } as const
  private collections = new Map<string, ZVecCollection>()

  /** 获取（惰性打开）指定 collection 的句柄。 */
  private collection(name: string): ZVecCollection {
    let col = this.collections.get(name)
    if (!col) {
      col = openOrCreate(name)
      this.collections.set(name, col)
    }
    return col
  }

  async upsert(collection: string, records: VectorRecord[]): Promise<void> {
    if (records.length === 0) return
    const col = this.collection(collection)
    col.upsertSync(
      records.map((r) => ({
        id: r.id,
        vectors: { embedding: r.vector },
        fields: r.metadata as Record<string, ScalarValue>,
      })),
    )
  }

  async search(
    collection: string,
    query: number[],
    topK: number,
    filter?: SearchFilter,
  ): Promise<SearchHit[]> {
    const col = this.collection(collection)
    const docs = col.querySync({
      fieldName: 'embedding',
      vector: query,
      topk: topK,
      filter: toFilterExpr(filter),
      includeVector: false,
    })
    // cosine 距离 → 相似度（1 - distance）。距离为 0 时相似度 1。
    return docs.map((d) => ({ id: d.id, score: 1 - d.score, metadata: toMetadata(d.fields) }))
  }

  async delete(collection: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return
    this.collection(collection).deleteSync(ids)
  }

  /** 关闭并释放所有已打开的 collection（优雅停机 / 测试重置用）。 */
  closeAll(): void {
    for (const col of this.collections.values()) {
      try {
        col.closeSync()
      } catch (e) {
        if (!isZVecError(e)) throw e
      }
    }
    this.collections.clear()
  }
}
