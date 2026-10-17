import { describe, it, expect, vi } from 'vitest'
import { createFaqGenerator } from './faq-generator.js'
import type { LlmProvider } from '../../core/llm/types.js'
import type { Atom } from './types.js'

function mockLlm(responseText: string): LlmProvider {
  return {
    name: 'mock',
    chat: vi.fn().mockResolvedValue({ text: responseText }),
    embed: vi.fn(),
  }
}

function mockPrisma(queryResult: any[] = []) {
  return {
    citationQuery: {
      findMany: vi.fn().mockResolvedValue(queryResult),
    },
  } as any
}

const sampleAtoms: Atom[] = [
  {
    text: 'zoomer AI 是一款 AI 设计工具',
    subject: 'zoomer AI',
    predicate: '是',
    object: 'AI 设计工具',
    anchors: ['zoomer AI'],
    definition: 'zoomer AI 是一款 AI 设计工具',
  },
]

describe('FaqGenerator', () => {
  it('有 CitationQuery 库时，基于真实 query 生成 FAQ', async () => {
    const queries = [
      { id: 'q1', queryText: 'AI设计工具哪个好' },
      { id: 'q2', queryText: 'zoomer AI 怎么样' },
    ]
    const faqJson = JSON.stringify({
      faqs: [
        { question: 'AI设计工具哪个好？', answer: 'zoomer AI 是一款优秀的 AI 设计工具', matchedQueryId: 'q1' },
        { question: 'zoomer AI 怎么样？', answer: 'zoomer AI 功能强大', matchedQueryId: 'q2' },
      ],
    })
    const llm = mockLlm(faqJson)
    const prisma = mockPrisma(queries)
    const generator = createFaqGenerator(llm, prisma)

    const faqs = await generator.generate({ atoms: sampleAtoms, workspaceId: 'w1', count: 2 })

    expect(faqs).toHaveLength(2)
    expect(faqs[0].source).toBe('citation_query')
    expect(faqs[0].matchedQueryId).toBe('q1')
    expect(prisma.citationQuery.findMany).toHaveBeenCalledWith({
      where: { workspaceId: 'w1', status: 'ACTIVE' },
    })
  })

  it('传入 queries 参数时直接使用，不查数据库', async () => {
    const queries = [{ id: 'q1', queryText: '什么是 zoomer AI' }]
    const faqJson = JSON.stringify({
      faqs: [
        { question: '什么是 zoomer AI？', answer: 'zoomer AI 是设计工具', matchedQueryId: 'q1' },
      ],
    })
    const llm = mockLlm(faqJson)
    const prisma = mockPrisma()
    const generator = createFaqGenerator(llm, prisma)

    const faqs = await generator.generate({ atoms: sampleAtoms, queries: queries as any })

    expect(faqs).toHaveLength(1)
    expect(prisma.citationQuery.findMany).not.toHaveBeenCalled()
  })

  it('无 query 库时，LLM 独立生成 5W1H 问题', async () => {
    const faqJson = JSON.stringify({
      faqs: [
        { question: '什么是 zoomer AI？', answer: 'zoomer AI 是一款 AI 设计工具' },
        { question: '谁适合使用 zoomer AI？', answer: '设计师' },
      ],
    })
    const llm = mockLlm(faqJson)
    const generator = createFaqGenerator(llm)

    const faqs = await generator.generate({ atoms: sampleAtoms })

    expect(faqs).toHaveLength(2)
    expect(faqs[0].source).toBe('llm_generated')
    expect(faqs[0].matchedQueryId).toBeUndefined()
  })

  it('无 query 且无 prisma 时 LLM 独立生成', async () => {
    const faqJson = JSON.stringify({
      faqs: [{ question: 'Q?', answer: 'A' }],
    })
    const llm = mockLlm(faqJson)
    const generator = createFaqGenerator(llm)

    const faqs = await generator.generate({ atoms: sampleAtoms, count: 1 })

    expect(faqs).toHaveLength(1)
    expect(faqs[0].source).toBe('llm_generated')
  })

  it('LLM 返回非 JSON 时返回空数组', async () => {
    const llm = mockLlm('不是 JSON')
    const generator = createFaqGenerator(llm)

    const faqs = await generator.generate({ atoms: sampleAtoms })
    expect(faqs).toHaveLength(0)
  })
})
