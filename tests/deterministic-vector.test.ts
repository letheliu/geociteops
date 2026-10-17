import { describe, expect, it } from 'vitest'
import {
  DEFAULT_VECTOR_DIM,
  deterministicVector,
  resolveVectorDim,
} from '../scripts/lib/deterministic-vector.js'

/**
 * 确定性向量生成器（M1 Phase C）
 *
 * 用途：演示站每日重置时，为种子 KgEntity 向 zvec upsert 伪 embedding，
 * 让「向量库非空」这件事可被真实验收，且零 LLM 依赖。
 *
 * 硬约束（错一条就静默检索不命中）：
 * - 维度必须等于 ZVEC_DIM（默认 1024），与 collection schema 一致；
 * - 必须 L2 归一化（集合 metric 是 COSINE，见 zvec-store.ts buildSchema）。
 */

function norm(v: number[]): number {
  return Math.sqrt(v.reduce((s, x) => s + x * x, 0))
}

describe('deterministicVector', () => {
  it('同一 id 恒定返回完全相同的向量（跨进程可复现）', () => {
    const a = deterministicVector('kg-entity-abc', 1024)
    const b = deterministicVector('kg-entity-abc', 1024)
    expect(a).toEqual(b)
  })

  it('不同 id 返回不同向量', () => {
    const a = deterministicVector('kg-entity-abc', 1024)
    const b = deterministicVector('kg-entity-xyz', 1024)
    expect(a).not.toEqual(b)
  })

  it('维度等于传入值，默认 1024', () => {
    expect(deterministicVector('x').length).toBe(DEFAULT_VECTOR_DIM)
    expect(deterministicVector('x', 1024).length).toBe(1024)
    expect(deterministicVector('x', 128).length).toBe(128)
  })

  it('L2 归一化：模长恒为 1（COSINE metric 要求）', () => {
    expect(norm(deterministicVector('kg-entity-abc', 1024))).toBeCloseTo(1, 10)
    expect(norm(deterministicVector('kg-entity-xyz', 256))).toBeCloseTo(1, 10)
  })

  it('归一化在任意维度下都成立（含小维度）', () => {
    for (const dim of [2, 4, 16, 512, 1024]) {
      expect(norm(deterministicVector('kg-entity-abc', dim))).toBeCloseTo(1, 10)
    }
  })

  it('分量全部是有限数，无 NaN / Infinity', () => {
    const v = deterministicVector('kg-entity-abc', 1024)
    expect(v.every(Number.isFinite)).toBe(true)
  })

  it('不同分量不全相同（避免退化成常量向量导致余弦恒等）', () => {
    const v = deterministicVector('kg-entity-abc', 1024)
    expect(new Set(v).size).toBeGreaterThan(1)
  })
})

describe('resolveVectorDim', () => {
  it('未配置 ZVEC_DIM 时回落 1024', () => {
    expect(resolveVectorDim({})).toBe(1024)
  })

  it('读取 ZVEC_DIM 并转为数字', () => {
    expect(resolveVectorDim({ ZVEC_DIM: '1536' })).toBe(1536)
  })

  it('非法值（空串/非数字/非正数）回落默认，避免建出坏 collection', () => {
    expect(resolveVectorDim({ ZVEC_DIM: '' })).toBe(1024)
    expect(resolveVectorDim({ ZVEC_DIM: 'abc' })).toBe(1024)
    expect(resolveVectorDim({ ZVEC_DIM: '0' })).toBe(1024)
    expect(resolveVectorDim({ ZVEC_DIM: '-8' })).toBe(1024)
  })
})
