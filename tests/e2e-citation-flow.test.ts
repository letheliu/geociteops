import { describe, it, expect, beforeAll } from 'vitest'
import { getPrismaClient, resetPrismaClient } from '../src/core/db/client.js'
import { createQueryLibraryService } from '../src/modules/citation-monitor/query-library.js'
import { createMonitor } from '../src/modules/citation-monitor/monitor.js'
import { createAdapterRegistry } from '../src/modules/citation-monitor/platform-adapters/registry.js'
import { loadTrendPoints } from '../src/modules/citation-monitor/trend-query.js'
import { dayKey, dayStart } from '../src/modules/citation-monitor/aggregate.js'
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
    // 清理（开发库）。Cascade 语义下顺序确定：采样行 → 运行行 → 查询 → 工作区。
    await prisma.citationEvent.deleteMany()
    await prisma.citationRun.deleteMany()
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
        // M2 §3.1：N=2 让采样级链路在 e2e 里真实成立（Run 行 + 2 行采样）
        monitorSampleCount: 2,
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
    // N=2 × 1 查询 × 1 平台 = 2 个采样行
    expect(events).toHaveLength(2)
    expect(events[0].brandMentioned).toBe(true)

    // 验证报告查询
    const reportEvents = await prisma.citationEvent.findMany({
      where: { workspaceId },
    })
    expect(reportEvents).toHaveLength(2)
    expect(reportEvents[0].sovScore).toBeGreaterThan(0)
  })

  // M2 §3.1：Run 维度全链（Run 行 → N 采样行 → trend 出点 → runs.list 合成 legacy 行）
  it('Run 全链：建 Run → N 采样行 → trend 出点 → runs.list 含 legacy 合成行', async () => {
    const prisma = getPrismaClient()

    // 上一个用例已建好 query，直接跑一次定时 Run（slotKey 走 Asia/Shanghai 日界）
    const today = dayKey(new Date())
    const registry = createAdapterRegistry()
    registry.register(new FakeAdapter())
    const queryLib = createQueryLibraryService(prisma)
    const monitor = createMonitor({
      prisma,
      registry,
      queryLibrary: queryLib,
      competitors: ['figma'],
    })

    const created = await monitor.startScheduledRun({
      workspaceId,
      platforms: ['openai'],
      slotKey: `${workspaceId}:${today}`,
    })
    expect(created.runId).not.toBeNull()
    expect(created.status).toBe('COMPLETED')

    // Run 行：N=2、plannedUnits = 2×1×1
    const run = await prisma.citationRun.findUnique({ where: { id: created.runId! } })
    expect(run).not.toBeNull()
    expect(run!.sampleCount).toBe(2)
    expect(run!.plannedUnits).toBe(2)
    expect(run!.completedUnits).toBe(2)
    expect(run!.failedUnits).toBe(0)
    expect(run!.slotKey).toBe(`${workspaceId}:${today}`)

    // 采样行：sampleIndex 1..2
    const samples = await prisma.citationEvent.findMany({
      where: { runId: created.runId! },
      orderBy: { sampleIndex: 'asc' },
    })
    expect(samples).toHaveLength(2)
    expect(samples.map((s) => s.sampleIndex)).toEqual([1, 2])
    expect(samples.every((s) => s.status === 'OK')).toBe(true)

    // 造一条 legacy 事件（runId=null）→ runs.list 应合成为 legacy:<date> 行
    const legacyDay = dayStart(dayKey(new Date(Date.now() - 2 * 86400000)))
    await prisma.citationEvent.create({
      data: {
        workspaceId,
        queryId: samples[0].queryId,
        platform: 'deepseek',
        brandMentioned: true,
        brandSourceCited: false,
        rawAnswer: '历史事件',
        sovScore: 0.5,
        capturedAt: legacyDay,
        runId: null,
      },
    })

    const fromDay = dayKey(new Date(Date.now() - 6 * 86400000))
    const toDay = dayKey(new Date())

    // trend 端点底层：物理 Run 点 + legacy 日桶点
    const points = await loadTrendPoints(prisma, { workspaceId, fromDay, toDay })
    const physical = points.filter((p) => !p.legacy)
    const legacyPoints = points.filter((p) => p.legacy)
    expect(physical.length).toBeGreaterThanOrEqual(1)
    expect(legacyPoints).toHaveLength(1)
    expect(legacyPoints[0].id).toBe(`legacy:${dayKey(legacyDay)}`)
    expect(legacyPoints[0].slotKey).toBeNull()
    // 聚合口径：物理 Run 的 2 个采样都被提及
    expect(physical[0].brandMentionRate).toBe(1)
  })
})
