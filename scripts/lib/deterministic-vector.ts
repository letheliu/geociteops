import { createHash } from 'node:crypto'

/**
 * 确定性伪 embedding 生成器（M1 Phase C）。
 *
 * 背景：zvec 是进程内嵌入式向量库，真实向量写入依赖 LLM 调用（embedding）。
 * 演示站每日重置要在**零 LLM 依赖**的前提下让种子 KgEntity 在 zvec 里可被检索，
 * 于是用「entityId → sha256 → 字节流 → [-1,1] 映射 → L2 归一化」造伪向量。
 *
 * 性质：
 * - 确定性：同一 id 在任何机器、任何进程、任何时间都得到同一向量（重置幂等的前提）；
 * - 维度对齐：默认取 ZVEC_DIM，与 ZvecStore 建集合时的 dimension 一致；
 * - 已归一化：集合 metric 为 COSINE（zvec-store.ts buildSchema），单位向量才能
 *   让「距离 → 相似度」的换算在 upsert 与 query 两侧口径一致。
 *
 * 注意：这不是真 embedding，语义上无意义，**仅用于演示站验收与相似实体视图非空**。
 * 真实业务向量仍由 LLM embedding 通道写入，不要拿它替换生产链路。
 */

/** ZvecStore 使用的默认维度（zvec-store.ts: EMBEDDING_DIM = ZVEC_DIM || 1024） */
export const DEFAULT_VECTOR_DIM = 1024

/** 单次 sha256 产出的字节数 */
const HASH_BYTES = 32

/**
 * 解析向量维度：读 ZVEC_DIM，非法值回落默认。
 *
 * 刻意对脏值宽容（空串/非数字/0/负数→默认）而不是抛错：
 * 这里是运维脚本的入口，维度算错会在建 collection 时才炸，不如就地兜底。
 */
export function resolveVectorDim(env: Record<string, string | undefined> = process.env): number {
  const raw = env.ZVEC_DIM
  if (raw === undefined || raw === null || String(raw).trim() === '') return DEFAULT_VECTOR_DIM
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed <= 0) return DEFAULT_VECTOR_DIM
  return parsed
}

/**
 * 由 id 派生的确定性字节流（sha256 计数器扩展，可产出任意长度）。
 *
 * 用 sha256(id || ":" || counter) 而不是简单重复哈希单个摘要：
 * 重复同一摘要会让向量出现明显周期结构，计数器扩展后各分量近似独立。
 */
function idByteStream(id: string, length: number): Uint8Array {
  const out = new Uint8Array(length)
  let offset = 0
  let counter = 0
  while (offset < length) {
    const digest = createHash('sha256').update(`${id}#${counter}`).digest()
    const take = Math.min(HASH_BYTES, length - offset)
    out.set(digest.subarray(0, take), offset)
    offset += take
    counter += 1
  }
  return out
}

/**
 * 生成 id 的确定性单位向量。
 *
 * @param id   实体 id（KgEntity.id）
 * @param dim  维度，缺省读 ZVEC_DIM（默认 1024）
 */
export function deterministicVector(id: string, dim: number = resolveVectorDim()): number[] {
  const dimension = Number.isInteger(dim) && dim > 0 ? dim : DEFAULT_VECTOR_DIM

  // 字节 → [-1, 1)：把 0..255 平移到以 0 为中心，负值可避免所有分量同号。
  const bytes = idByteStream(id, dimension)
  const raw = new Array<number>(dimension)
  let sumSquares = 0
  for (let i = 0; i < dimension; i++) {
    const v = (bytes[i]! / 255) * 2 - 1
    raw[i] = v
    sumSquares += v * v
  }

  // L2 归一化（COSINE 集合要求单位向量）
  const magnitude = Math.sqrt(sumSquares)
  if (magnitude === 0) {
    // sha256 输出全 0 字节的概率可忽略；真发生则退化为首分量为 1 的单位基向量，
    // 宁可退化也要保证模长为 1，不让 NaN 流进 zvec。
    const fallback = new Array<number>(dimension).fill(0)
    fallback[0] = 1
    return fallback
  }
  return raw.map((v) => v / magnitude)
}
