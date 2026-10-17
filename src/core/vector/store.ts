/**
 * 向量存储抽象接口。
 *
 * 业务代码只依赖此接口，不直接 import 任何具体向量库实现（@zvec/zvec 等），
 * 便于单元测试 mock，也便于未来替换底层向量引擎。
 *
 * score 语义统一为「相似度」：越大越相似（取值通常在 0~1 之间）。
 * 具体实现负责把底层引擎的距离/原始分数转换为相似度。
 */

/** 一条待写入的向量记录。metadata 中的标量字段可用于检索时过滤。 */
export interface VectorRecord {
  /** 业务 ID（如 queryId / entityId / atomId），作为向量库主键 */
  id: string
  /** 向量；维度由具体 collection 决定（本项目统一 1024 维） */
  vector: number[]
  /** 标量元数据，用于检索过滤（如 workspaceId 做工作区隔离） */
  metadata: Record<string, string | number | boolean>
}

/** 检索命中结果。score 为相似度，越大越相似。 */
export interface SearchHit {
  id: string
  /** 相似度，越大越相似（0~1） */
  score: number
  metadata: Record<string, unknown>
}

/** 检索过滤条件。key=字段名，value=期望等值匹配的标量。实现负责拼成底层 filter 表达式。 */
export type SearchFilter = Record<string, string | number | boolean>

export interface VectorStore {
  /** 预定义的 collection 名，业务侧用这些常量引用，避免拼写错误 */
  readonly COLLECTIONS: Readonly<{
    queries: 'queries'
    entities: 'entities'
    atoms: 'atoms'
  }>

  /** 按 ID 批量写入（已存在则覆盖）。records 为空时直接返回。 */
  upsert(collection: string, records: VectorRecord[]): Promise<void>

  /**
   * 相似度检索：返回与 query 最相似的 topK 条记录，按相似度降序。
   * filter 用于按 metadata 字段过滤（如 { workspaceId } 做工作区隔离）。
   */
  search(
    collection: string,
    query: number[],
    topK: number,
    filter?: SearchFilter,
  ): Promise<SearchHit[]>

  /** 按 ID 批量删除。ids 为空时直接返回。 */
  delete(collection: string, ids: string[]): Promise<void>

  /** 关闭并释放所有已打开的 collection（优雅停机 / 测试重置用）。
   *  纯内存 / 无状态实现可保留为空实现。 */
  closeAll(): void
}
