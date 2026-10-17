import type { PrismaClient, CitationQuery, QuerySource } from '@prisma/client'
import type { LlmProvider } from '../../core/llm/types.js'
import type { VectorStore, SearchHit } from '../../core/vector/store.js'
import {
  resolveWorkspaceOrganization,
  type BillingCheckpoints,
} from '../../platform/billing/entitlement-guard.js'

export interface AddQueryInput {
  workspaceId: string
  queryText: string
  source: QuerySource
  intent?: Record<string, unknown>
  intentType?: string
  cluster?: string
  mappedPageUrl?: string
  priority?: number
}

export interface GenerateQueriesInput {
  workspaceId: string
  topic: string
  count: number
}

export interface GeneratedQueryDraft {
  queryText: string
  intentType: string
  cluster?: string
  mappedPageUrl?: string
  priority: number
}

export interface QueryLibraryService {
  addQuery(input: AddQueryInput): Promise<CitationQuery>
  listActive(workspaceId: string): Promise<CitationQuery[]>
  pauseQuery(id: string): Promise<CitationQuery>
  resumeQuery(id: string): Promise<CitationQuery>
  deleteQuery(id: string): Promise<void>
  generateQueries(input: GenerateQueriesInput): Promise<CitationQuery[]>
  /** 语义检索：返回与 queryText 最相似的 query（用于聚类去重 / FAQ 召回）。 */
  findSimilarQueries(workspaceId: string, queryText: string, topK?: number): Promise<SearchHit[]>
}

function normalizeQueryDraft(raw: any): GeneratedQueryDraft {
  if (typeof raw === 'string') {
    return {
      queryText: raw,
      intentType: 'other',
      priority: 3,
    }
  }
  return {
    queryText: raw.queryText || String(raw),
    intentType: raw.intentType || 'other',
    cluster: raw.cluster,
    mappedPageUrl: raw.mappedPageUrl,
    priority: raw.priority || 3,
  }
}

export function createQueryLibraryService(
  prisma: PrismaClient,
  llm?: LlmProvider,
  vector?: VectorStore,
  /** 计费检查点（任务 9，可选注入）：新增词 → maxQueries 软限 + QUERY_ADDED 计量 */
  billing?: BillingCheckpoints,
): QueryLibraryService {
  /**
   * 新增词检查点（先检查后计量，软限不拦截）：softCheck 按 requested 预检
   * （超额 audit 告警由 guard 记录、仍继续创建）；返回计量闭包——创建成功后
   * 以实际入库量计量（LLM 生成可能少于请求量）。
   */
  async function checkpointMaxQueries(
    workspaceId: string,
    requested: number,
  ): Promise<((actual: number) => void) | null> {
    if (!billing) return null
    const organizationId = await resolveWorkspaceOrganization(prisma, workspaceId)
    if (!organizationId) return null
    await billing.guard.softCheck(organizationId, 'maxQueries', requested)
    return (actual) =>
      billing.meter.record({
        organizationId,
        workspaceId,
        kind: 'QUERY_ADDED',
        quantity: actual,
      })
  }

  /** 把已入库 query 写入向量库。容错：失败不阻塞业务主流程（query 已落 PG）。 */
  async function indexQuery(row: CitationQuery): Promise<void> {
    if (!llm || !vector) return
    try {
      const v = await llm.embed(row.queryText)
      await vector.upsert(vector.COLLECTIONS.queries, [
        {
          id: row.id,
          vector: v,
          metadata: {
            workspaceId: row.workspaceId,
            sourceType: row.source,
            ...(row.cluster ? { cluster: row.cluster } : {}),
          },
        },
      ])
    } catch (e) {
      console.warn(`[query-library] indexQuery 失败 queryId=${row.id}:`, (e as Error).message)
    }
  }

  return {
    async addQuery(input) {
      const meterQuery = await checkpointMaxQueries(input.workspaceId, 1)
      const row = await prisma.citationQuery.create({
        data: {
          workspaceId: input.workspaceId,
          queryText: input.queryText,
          source: input.source,
          intent: (input.intent as any) || {},
          intentType: input.intentType,
          cluster: input.cluster,
          mappedPageUrl: input.mappedPageUrl,
          priority: input.priority ?? 3,
          status: 'ACTIVE',
        },
      })
      meterQuery?.(1)
      await indexQuery(row)
      return row
    },

    async listActive(workspaceId) {
      return prisma.citationQuery.findMany({
        where: { workspaceId, status: 'ACTIVE' },
      })
    },

    async pauseQuery(id) {
      return prisma.citationQuery.update({
        where: { id },
        data: { status: 'PAUSED' },
      })
    },

    async resumeQuery(id) {
      return prisma.citationQuery.update({
        where: { id },
        data: { status: 'ACTIVE' },
      })
    },

    async deleteQuery(id) {
      await prisma.citationQuery.delete({ where: { id } })
      // 同步删除向量；容错
      if (vector) {
        try {
          await vector.delete(vector.COLLECTIONS.queries, [id])
        } catch (e) {
          console.warn(`[query-library] delete vector 失败 queryId=${id}:`, (e as Error).message)
        }
      }
    },

    async generateQueries(input) {
      if (!llm) throw new Error('LLM provider required for generateQueries')
      const prompt = `为主题"${input.topic}"生成 ${input.count} 个用户可能在 AI 搜索引擎中提问的 query。
输出 JSON 数组，每个元素可以是字符串或包含以下字段的对象：
- queryText: 查询文本（必需）
- intentType: 意图类型，可选 comparison/alternative/how_to/definition/pricing/integration/other
- cluster: 查询聚类标签
- mappedPageUrl: 关联页面 URL
- priority: 优先级 1-5

示例：["query1", {"queryText":"query2","intentType":"comparison","cluster":"ai-tools","priority":1}]`

      const res = await llm.chat([{ role: 'user', content: prompt }], { temperature: 0.7 })
      let rawQueries: any[]
      try {
        const text = res.text.trim()
        const jsonMatch = text.match(/\[[\s\S]*\]/)
        if (jsonMatch) {
          rawQueries = JSON.parse(jsonMatch[0])
        } else {
          throw new Error('No JSON array found')
        }
      } catch {
        rawQueries = res.text
          .split('\n')
          .map((s) => s.trim().replace(/^["'\d]+\.?\s*/, '').replace(/["']$/, ''))
          .filter((s) => s && s.length > 2 && !s.startsWith('[') && !s.startsWith(']'))
      }

      // 任务 9：批量生成按请求量先检查（软限），实际入库量计量
      const meterQuery = await checkpointMaxQueries(input.workspaceId, input.count)
      const drafts = rawQueries.slice(0, input.count).map(normalizeQueryDraft)
      const created: CitationQuery[] = []
      for (const draft of drafts) {
        const row = await prisma.citationQuery.create({
          data: {
            workspaceId: input.workspaceId,
            queryText: draft.queryText,
            source: 'LLM_GENERATED',
            status: 'ACTIVE',
            intentType: draft.intentType,
            cluster: draft.cluster,
            mappedPageUrl: draft.mappedPageUrl,
            priority: draft.priority,
          },
        })
        created.push(row)
      }
      meterQuery?.(created.length)

      // 批量向量化：一次 embedBatch + 一次 upsert，避免 N 次串行网络往返
      if (vector && created.length > 0) {
        try {
          const vectors = await llm.embedBatch(created.map((r) => r.queryText))
          await vector.upsert(
            vector.COLLECTIONS.queries,
            created.map((r, i) => ({
              id: r.id,
              vector: vectors[i],
              metadata: {
                workspaceId: r.workspaceId,
                sourceType: r.source,
                ...(r.cluster ? { cluster: r.cluster } : {}),
              },
            })),
          )
        } catch (e) {
          console.warn(`[query-library] generateQueries 批量索引失败:`, (e as Error).message)
        }
      }
      return created
    },

    async findSimilarQueries(workspaceId, queryText, topK = 10) {
      if (!llm || !vector) throw new Error('LLM and vector store required for findSimilarQueries')
      const v = await llm.embed(queryText)
      return vector.search(vector.COLLECTIONS.queries, v, topK, { workspaceId })
    },
  }
}
