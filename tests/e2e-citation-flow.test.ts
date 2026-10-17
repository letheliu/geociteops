import { describe, it, expect, beforeAll } from 'vitest'
import { getPrismaClient, resetPrismaClient } from '../src/core/db/client.js'
import { createQueryLibraryService } from '../src/modules/citation-monitor/query-library.js'
import { createMonitor } from '../src/modules/citation-monitor/monitor.js'
import { createAdapterRegistry } from '../src/modules/citation-monitor/platform-adapters/registry.js'
import type { PlatformAdapter, PlatformResult } from '../src/modules/citation-monitor/platform-adapters/types.js'

// 内嵌假 adapter，避免真实 API 调用
// 任务 17 验收修复：返回 2026-06 起的 PlatformResult 新契约（sourceCitations/groundingSources/answerMentions）。
// 旧字段 citations/mentionedBrands 使 analyzer 遍历 sourceCitations 时抛 TypeError → runOnce 全部吞为 null → 0 events。
class FakeAdapter implements PlatformAdapter {
  name = 'openai'
  async query(): Promise<PlatformResult> {
    return {
      answer: '推荐 zoomer AI，它是一款设计工具。参考 https://zoomer.top',
      sourceCitations: [{ url: 'https://zoomer.top', position: 1, sourceType: 'api_citation' }],
      groundingSources: [],
      answerMentions: [],
    }
  }
}

describe('e2e: citation flow', () => {
  let workspaceId: string

  beforeAll(async () => {
    const prisma = getPrismaClient()
    // 清理（开发库）
    await prisma.citationEvent.deleteMany()
    await prisma.citationQuery.deleteMany()
    await prisma.workspace.deleteMany()

    // 任务 4 起 organizationId 必填且 apiKeyHash 下线，注册通道（svc.create）为抛错占位，
    // fixture 直接经 prisma 建 Organization + Workspace（schema 一致即可，真实注册在任务 9/11 重写）
    const org = await prisma.organization.create({ data: { name: 'test-org' } })
    const workspace = await prisma.workspace.create({
      data: {
        name: 'test',
        defaultBrandName: 'zoomer AI',
        organizationId: org.id,
      },
    })
    workspaceId = workspace.id
  })

  it('注册 → 录入 query → 监测 → 报告', async () => {
    const prisma = getPrismaClient()
    const queryLib = createQueryLibraryService(prisma)
    await queryLib.addQuery({
      workspaceId,
      queryText: 'AI设计工具哪个好',
      source: 'MANUAL',
    })

    const registry = createAdapterRegistry()
    registry.register(new FakeAdapter())
    const monitor = createMonitor({
      prisma,
      registry,
      queryLibrary: queryLib,
      competitors: ['figma'],
    })

    const events = await monitor.runOnce({ workspaceId, platforms: ['openai'] })
    expect(events).toHaveLength(1)
    expect(events[0].brandMentioned).toBe(true)

    // 验证报告查询
    const reportEvents = await prisma.citationEvent.findMany({
      where: { workspaceId },
    })
    expect(reportEvents).toHaveLength(1)
    expect(reportEvents[0].sovScore).toBeGreaterThan(0)
  })
})
