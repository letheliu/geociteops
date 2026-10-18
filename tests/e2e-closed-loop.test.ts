import { describe, it, expect, beforeAll, vi } from 'vitest'
import { getPrismaClient } from '../src/core/db/client.js'
import { createQueryLibraryService } from '../src/modules/citation-monitor/query-library.js'
import { createMonitor } from '../src/modules/citation-monitor/monitor.js'
import { createAdapterRegistry } from '../src/modules/citation-monitor/platform-adapters/registry.js'
import { createTaskService } from '../src/modules/content-optimizer/task-service.js'
import { createClosedLoopService } from '../src/modules/citation-monitor/closed-loop-service.js'
import { createAtomizer } from '../src/modules/content-optimizer/atomizer.js'
import { createCitabilityEngine } from '../src/modules/content-optimizer/citability.js'
import { loadWeakPoints } from '../src/modules/citation-monitor/weak-points.js'
import { dayKey } from '../src/modules/citation-monitor/aggregate.js'
import type { PlatformAdapter, PlatformResult } from '../src/modules/citation-monitor/platform-adapters/types.js'

/**
 * e2e：闭环全旅程（M2 §3.3 规格 §9）。
 *
 * 证明的是**链路**：run1 低 SOV → 一键优化（mock 建议稿）→ 审核发布（页面 currentContent
 * 变为建议稿 + optimizedContent 置 null + 任务 AWAITING_VERIFICATION）→ run2 高 SOV →
 * 回填 VERIFIED 且 Δ > 0。**不证明因果效应**——Δ 只是发布后首个有效 run 的观测值。
 *
 * 需要活的 PostgreSQL（CI 提供）；本机无 DB 时整组跳过。
 */

/** 可切换答案的假 adapter：run1 低 SOV（不提及品牌），run2 高 SOV（提及品牌） */
class ToggleAdapter implements PlatformAdapter {
  name = 'openai'
  mentionBrand = false

  async query(): Promise<PlatformResult> {
    const answer = this.mentionBrand
      ? '强烈推荐 zoomer AI，它是一款优秀的设计工具。参考 https://zoomer.top'
      : '推荐 Figma，它是一款设计工具。参考 https://figma.com'
    return {
      answer,
      sourceCitations: [{ url: 'https://zoomer.top', position: 1, sourceType: 'api_citation' }],
      groundingSources: [],
      answerMentions: [],
    }
  }
}

describe('e2e: 闭环全旅程（M2 §3.3）', () => {
  let workspaceId: string
  let queryId: string
  let pageId: string
  let adapter: ToggleAdapter
  let taskService: ReturnType<typeof createTaskService>

  beforeAll(async () => {
    const prisma = getPrismaClient()
    // 清理（测试库）。顺序同 e2e-citation-flow：事件 → Run → 任务 → 查询 → 页面 → 工作区
    await prisma.citationEvent.deleteMany()
    await prisma.citationRun.deleteMany()
    await prisma.optimizationTask.deleteMany()
    await prisma.contentPage.deleteMany()
    await prisma.citationQuery.deleteMany()
    await prisma.workspace.deleteMany()

    const org = await prisma.organization.create({ data: { name: 'closed-loop-e2e' } })
    const workspace = await prisma.workspace.create({
      data: {
        name: 'closed-loop',
        defaultBrandName: 'zoomer AI',
        organizationId: org.id,
        monitorSampleCount: 1,
      },
    })
    workspaceId = workspace.id

    const page = await prisma.contentPage.create({
      data: {
        workspaceId,
        url: 'https://zoomer.top/best-tools',
        pageType: 'landing',
        currentContent: '这是我们页面的原始正文，讲了一些很泛的内容，没有具体数据。',
        optimizedContent: '{"legacy":true}',
        status: 'DRAFT',
      },
    })
    pageId = page.id

    const queryLib = createQueryLibraryService(prisma)
    const query = await queryLib.addQuery({
      workspaceId,
      queryText: 'AI设计工具哪个好',
      source: 'MANUAL',
      mappedPageUrl: page.url,
    })
    queryId = query.id

    // 建议稿由 mock LLM 产生（不烧真实调用）：rewriteForQuery 与 atomizer 共用同一假 provider
    const llm: any = {
      name: 'mock',
      chat: vi.fn(async (messages: any[]) => {
        const userPrompt = messages.map((m) => m.content).join('\n')
        if (userPrompt.includes('整页')) {
          return { text: 'zoomer AI 是一款 AI 设计工具，2026 年服务 50 万设计师，支持 Figma 全流程对接。' }
        }
        return {
          text: JSON.stringify({
            atoms: [
              {
                text: userPrompt.includes('zoomer AI 是一款') ? 'zoomer AI 是一款 AI 设计工具，2026 年服务 50 万设计师。' : '这是我们页面的原始正文，讲了一些很泛的内容。',
                subject: 'zoomer AI',
                predicate: '是',
                object: 'AI 设计工具',
                anchors: ['2026', '50 万'],
              },
            ],
          }),
        }
      }),
      embed: vi.fn(),
    }

    adapter = new ToggleAdapter()
    const registry = createAdapterRegistry()
    registry.register(adapter)

    const rewriter = {
      rewriteForQuery: (pageContent: string, queryText: string, brand: string) =>
        llm.chat([
          { role: 'system', content: '整页改写' },
          { role: 'user', content: `${brand}\n${queryText}\n${pageContent}` },
        ]).then((r: any) => r.text),
      rewrite: vi.fn(),
      rewriteBatch: vi.fn(),
    }

    taskService = createTaskService({ prisma })
    const closedLoop = createClosedLoopService({
      prisma,
      taskService,
      rewriter: rewriter as any,
      atomizer: createAtomizer(llm),
      citability: createCitabilityEngine(),
    })
    ;(globalThis as any).__closedLoop = closedLoop
  })

  it('run1 低 SOV → 一键优化 → 审核发布 → run2 高 SOV → VERIFIED 且 Δ>0', async () => {
    const prisma = getPrismaClient()
    const closedLoop = (globalThis as any).__closedLoop
    const queryLib = createQueryLibraryService(prisma)
    const registry = createAdapterRegistry()
    registry.register(adapter)
    const monitor = createMonitor({ prisma, registry, queryLibrary: queryLib, competitors: ['Figma'] })

    // ---- run1：低 SOV（不提及品牌）----
    adapter.mentionBrand = false
    const run1 = await monitor.startManualRun({
      workspaceId,
      platforms: ['openai'],
      queryIds: [queryId],
      sampleCount: 1,
    })
    expect(run1.status).toBe('COMPLETED')

    const weakPoints = await loadWeakPoints(prisma, {
      workspaceId,
      fromDay: dayKey(new Date(Date.now() - 2 * 86400000)),
      toDay: dayKey(new Date()),
    })
    const weak = weakPoints.find((w) => w.queryId === queryId)
    expect(weak).toBeDefined()
    expect(weak!.brandMentionRate).toBe(0)
    expect(weak!.topCompetitor).toBe('Figma')

    // ---- 一键优化：生成建议稿任务 ----
    const created = await closedLoop.optimizeFromWeakPoint({
      workspaceId,
      queryId,
      brand: 'zoomer AI',
    })
    expect(created.suggestion).toContain('zoomer AI 是一款 AI 设计工具')
    expect(created.task.status).toBe('PENDING')
    const taskId = created.task.id

    // ---- 审核发布：建议稿写回页面，任务直迁 AWAITING_VERIFICATION ----
    await taskService.review(taskId, true)
    const published = await taskService.publish(taskId)
    expect(published.status).toBe('AWAITING_VERIFICATION')

    const pageAfter = await prisma.contentPage.findUnique({ where: { id: pageId } })
    expect(pageAfter!.currentContent).toBe(created.suggestion)
    expect(pageAfter!.publishedContent).toBe(created.suggestion)
    expect(pageAfter!.optimizedContent).toBeNull()
    expect(pageAfter!.status).toBe('PUBLISHED')

    const taskAfter = await prisma.optimizationTask.findUnique({ where: { id: taskId } })
    const result = taskAfter!.result as Record<string, any>
    expect(result.originalContent).toContain('原始正文')
    expect(taskAfter!.baselineSovMean).not.toBeNull()

    // ---- run2：高 SOV（提及品牌）→ 回填 VERIFIED 且 Δ>0 ----
    adapter.mentionBrand = true
    const run2 = await monitor.startManualRun({
      workspaceId,
      platforms: ['openai'],
      queryIds: [queryId],
      sampleCount: 1,
    })
    expect(run2.status).toBe('COMPLETED')

    const verified = await prisma.optimizationTask.findUnique({ where: { id: taskId } })
    expect(verified!.status).toBe('VERIFIED')
    expect(verified!.verifiedRunId).toBe(run2.runId)
    expect(verified!.verifiedSovMean).toBeGreaterThan(verified!.baselineSovMean!)
    expect(verified!.verifiedMentionRate).toBe(1)
    expect(verified!.verifiedAt).not.toBeNull()
  })
})
