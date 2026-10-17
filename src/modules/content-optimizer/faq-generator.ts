import type { PrismaClient } from '@prisma/client'
import type { LlmProvider } from '../../core/llm/types.js'
import type { VectorStore } from '../../core/vector/store.js'
import type { Atom, FaqPair } from './types.js'

export interface GenerateFaqInput {
  atoms: Atom[]
  workspaceId?: string
  queries?: Array<{ id: string; queryText: string }>
  count?: number
}

export interface FaqGeneratorService {
  generate(input: GenerateFaqInput): Promise<FaqPair[]>
}

export function createFaqGenerator(
  llm: LlmProvider,
  prisma?: PrismaClient,
  vector?: VectorStore,
): FaqGeneratorService {
  return {
    async generate(input) {
      const count = input.count ?? 5

      // 确定是否有 query 来源
      let queries: Array<{ id: string; queryText: string }> | undefined

      if (input.queries && input.queries.length > 0) {
        queries = input.queries
      } else if (prisma && input.workspaceId) {
        queries = await prisma.citationQuery.findMany({
          where: { workspaceId: input.workspaceId, status: 'ACTIVE' },
        })
      }

      const hasQueries = queries && queries.length > 0

      if (hasQueries) {
        // 向量召回：按与内容的相关性选 query，而非盲取前 N 条
        const selected = await selectRelevantQueries(llm, vector, input.atoms, queries!, count, input.workspaceId)
        return generateFromQueries(llm, input.atoms, selected, count)
      }
      return generateFromAtoms(llm, input.atoms, count)
    },
  }
}

/**
 * 按与内容语义相关性筛选 query。
 * 有向量库时：用内容 embedding 在 query 库里召回 topK；失败或无向量库时回退为取前 N 条。
 */
async function selectRelevantQueries(
  llm: LlmProvider,
  vector: VectorStore | undefined,
  atoms: Atom[],
  queries: Array<{ id: string; queryText: string }>,
  count: number,
  workspaceId?: string,
): Promise<Array<{ id: string; queryText: string }>> {
  if (!vector || !workspaceId) return queries.slice(0, count)
  try {
    const contentText = atoms.map((a) => a.text).join('\n')
    const contentVec = await llm.embed(contentText)
    const hits = await vector.search(vector.COLLECTIONS.queries, contentVec, count, { workspaceId })
    // 用召回的 id 回填 queryText（向量库只存了 metadata，不含 queryText）
    const byId = new Map(queries.map((q) => [q.id, q]))
    const recalled = hits
      .map((h) => byId.get(h.id))
      .filter((q): q is { id: string; queryText: string } => !!q)
    // 召回不足时回补，保证最终有 count 条
    if (recalled.length < count) {
      const have = new Set(recalled.map((q) => q.id))
      for (const q of queries) {
        if (recalled.length >= count) break
        if (!have.has(q.id)) recalled.push(q)
      }
    }
    return recalled.slice(0, count)
  } catch (e) {
    console.warn('[faq-generator] 向量召回失败，回退 slice:', (e as Error).message)
    return queries.slice(0, count)
  }
}

async function generateFromQueries(
  llm: LlmProvider,
  atoms: Atom[],
  queries: Array<{ id: string; queryText: string }>,
  count: number,
): Promise<FaqPair[]> {
  const selectedQueries = queries.slice(0, count)
  const contentContext = atoms.map((a) => a.text).join('\n')

  const prompt = `基于以下内容和用户高频问题，生成问答对。

内容：
${contentContext}

用户问题：
${selectedQueries.map((q, i) => `${i + 1}. ${q.queryText}`).join('\n')}

为每个问题生成简洁准确的答案。只输出 JSON：{ "faqs": [{ "question": "...", "answer": "...", "matchedQueryId": "..." }] }`

  const res = await llm.chat(
    [{ role: 'user', content: prompt }],
    { temperature: 0.3 },
  )

  return parseFaqs(res.text, 'citation_query')
}

async function generateFromAtoms(
  llm: LlmProvider,
  atoms: Atom[],
  count: number,
): Promise<FaqPair[]> {
  const contentContext = atoms.map((a) => a.text).join('\n')

  const prompt = `基于以下内容，从 5W1H（What/Who/When/Where/Why/How）角度生成 ${count} 个问答对。

内容：
${contentContext}

只输出 JSON：{ "faqs": [{ "question": "...", "answer": "..." }] }`

  const res = await llm.chat(
    [{ role: 'user', content: prompt }],
    { temperature: 0.5 },
  )

  return parseFaqs(res.text, 'llm_generated')
}

function parseFaqs(
  raw: string,
  source: 'citation_query' | 'llm_generated',
): FaqPair[] {
  try {
    const parsed = JSON.parse(raw)
    if (parsed && Array.isArray(parsed.faqs)) {
      return parsed.faqs.map((f: any) => ({
        question: String(f.question || ''),
        answer: String(f.answer || ''),
        matchedQueryId: f.matchedQueryId ? String(f.matchedQueryId) : undefined,
        source,
      }))
    }
  } catch {
    // 兜底
  }
  return []
}
