import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { getPrismaClient, resetPrismaClient } from '../src/core/db/client.js'
import { createSessionService } from '../src/core/auth/session.js'
import { createAuditService } from '../src/platform/audit/service.js'
import { createEntitlementService } from '../src/platform/billing/entitlement-service.js'
import { createEntitlementGuard } from '../src/platform/billing/entitlement-guard.js'
import { createUsageMeter } from '../src/platform/billing/usage-meter.js'
import { createQueryLibraryService } from '../src/modules/citation-monitor/query-library.js'
import { createMonitor } from '../src/modules/citation-monitor/monitor.js'
import { createAdapterRegistry } from '../src/modules/citation-monitor/platform-adapters/registry.js'
import { loadTrendPoints } from '../src/modules/citation-monitor/trend-query.js'
import { dayKey } from '../src/modules/citation-monitor/aggregate.js'
import { createRegistrationService, REGISTRATION_CLOSED_MESSAGE } from '../src/platform/identity/registration-service.js'
import type { PlatformAdapter, PlatformResult } from '../src/modules/citation-monitor/platform-adapters/types.js'

// ---------------------------------------------------------------------------
// M2 §3.0 e2e：试用全旅程（CI 跑，需 PostgreSQL）
//
// register（双开关 on）→ 手动加查询 → runs.create(sampleCount=1) → trend 出点，
// 外加两条边界：REGISTRATION 缺省 off 时的关闭文案、试用配额下的 monitorSampleCountMax 硬拒。
//
// ⚠️ 与 tests/e2e-citation-flow.test.ts 同款：beforeAll 会 deleteMany 清理
// citationEvent / citationRun / citationQuery / workspace / subscription / order /
// organization / user —— **DATABASE_URL 只能指向一次性测试库**。
//
// 环境前提：CI 需 REGISTRATION_ENABLED=on 且 BILLING_ENFORCEMENT=on（缺省 off 时
// 首个用例会拿到关闭文案——这是刻意用双开关断言的，不是环境故障）。
// ---------------------------------------------------------------------------

const MASTER_KEY = 'b'.repeat(64)

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

describe('e2e: self-serve 试用全旅程', () => {
  let created: { organizationId: string; workspaceId: string } | null = null

  beforeAll(async () => {
    const prisma = getPrismaClient()
    await prisma.citationEvent.deleteMany()
    await prisma.citationRun.deleteMany()
    await prisma.citationQuery.deleteMany()
    await prisma.workspace.deleteMany()
    await prisma.subscription.deleteMany()
    await prisma.orderItem.deleteMany()
    await prisma.order.deleteMany()
    await prisma.organizationEntitlement.deleteMany()
    await prisma.organization.deleteMany()
    await prisma.session.deleteMany()
    await prisma.user.deleteMany()
  })

  afterAll(() => {
    resetPrismaClient()
  })

  function buildRegistrationService(env: Record<string, string | undefined>) {
    const prisma = getPrismaClient()
    const audit = createAuditService(prisma)
    const meter = createUsageMeter({ prisma })
    const guard = createEntitlementGuard({ prisma, meter, audit })
    return createRegistrationService({
      prisma,
      sessions: createSessionService(prisma),
      audit,
      entitlements: createEntitlementService({ prisma }),
      envelopeKey: MASTER_KEY,
      env,
    })
  }

  it('注册 → 五件套落库（source=TRIAL / $0 单 paidAt=null / 快照内部键）', async () => {
    const service = buildRegistrationService({ REGISTRATION_ENABLED: 'on', BILLING_ENFORCEMENT: 'on' })
    const result = await service.registerTrial({
      username: `trialuser${Date.now().toString(36)}`,
      password: 'Zx9!qwerty',
      email: `trial${Date.now().toString(36)}@example.com`,
      brandName: '试用品牌',
      ip: '203.0.113.9',
    })
    created = { organizationId: result.trial.organizationId, workspaceId: result.trial.workspaceId }

    const prisma = getPrismaClient()
    const org = await prisma.organization.findUnique({ where: { id: result.trial.organizationId } })
    expect(org?.source).toBe('TRIAL')

    const ws = await prisma.workspace.findUnique({ where: { id: result.trial.workspaceId } })
    expect(ws?.monitorSampleCount).toBe(3)
    expect(ws?.monitorSchedule).toBe('DAILY')
    // 明文 '{}' 从不落库
    expect(typeof ws?.platformConfig).toBe('string')
    expect(ws?.platformConfig).not.toBe('{}')

    const order = await prisma.order.findFirst({ where: { organizationId: org!.id } })
    expect(order).toMatchObject({ status: 'COMPLETED', paymentMethod: 'TRIAL', paidAt: null, totalCents: 0 })

    const sub = await prisma.subscription.findFirst({ where: { organizationId: org!.id } })
    expect(sub?.status).toBe('ACTIVE')
    expect(sub?.entitlements).toMatchObject({ _graceDays: 90, _suppressReminder: true, monitorSampleCountMax: 3 })
    // endAt = startAt + 7 天
    expect(sub!.endAt.getTime() - sub!.startAt.getTime()).toBe(7 * 86_400_000)

    // 配额已 recompute 落库（monitorSampleCountMax=3 可被 guard 读到）
    const limits = await prisma.organizationEntitlement.findUnique({ where: { organizationId: org!.id } })
    expect(limits?.limits).toMatchObject({ maxWorkspaces: 1, maxQueries: 10, monitorSampleCountMax: 3 })
  })

  it('试用生成入口被拒（平台 LLM 成本归零）', async () => {
    const prisma = getPrismaClient()
    const queryLib = createQueryLibraryService(prisma, { name: 'x', chat: vi.fn(), embed: vi.fn(), embedBatch: vi.fn() } as any)
    await expect(
      queryLib.generateQueries({ workspaceId: created!.workspaceId, topic: 'AI', count: 3 }),
    ).rejects.toMatchObject({ name: 'TRIAL_GENERATION_DISABLED' })
  })

  it('手动加查询 → runs.create(sampleCount=1) → trend 出点（试用全旅程闭环）', async () => {
    const prisma = getPrismaClient()
    const queryLib = createQueryLibraryService(prisma)
    const query = await queryLib.addQuery({
      workspaceId: created!.workspaceId,
      queryText: 'AI设计工具哪个好',
      source: 'MANUAL',
    })
    expect(query.id).toBeTruthy()

    const registry = createAdapterRegistry()
    registry.register(new FakeAdapter())
    const monitor = createMonitor({ prisma, registry, queryLibrary: queryLib, competitors: ['figma'] })

    const run = await monitor.createManualRun({
      workspaceId: created!.workspaceId,
      platforms: ['openai'],
      queryIds: [query.id],
      sampleCount: 1,
    })
    expect(run.runId).not.toBeNull()
    await monitor.executeRunById(run.runId!)

    const runRow = await prisma.citationRun.findUnique({ where: { id: run.runId! } })
    expect(runRow?.sampleCount).toBe(1)
    expect(runRow?.status).toBe('COMPLETED')

    const fromDay = dayKey(new Date(Date.now() - 2 * 86_400_000))
    const toDay = dayKey(new Date())
    const points = await loadTrendPoints(prisma, {
      workspaceId: created!.workspaceId,
      fromDay,
      toDay,
    })
    expect(points.length).toBeGreaterThanOrEqual(1)
    expect(points.some((p) => p.brandMentionRate > 0)).toBe(true)
  })

  it('monitorSampleCountMax 硬检查：TRIAL org 传 sampleCount=10 被拒，传 3 放行', async () => {
    const prisma = getPrismaClient()
    const audit = createAuditService(prisma)
    const guard = createEntitlementGuard({ prisma, meter: createUsageMeter({ prisma }), audit })

    await expect(
      guard.checkMonitorSampleCountMax(created!.organizationId, 10),
    ).rejects.toMatchObject({ field: 'monitorSampleCountMax', limit: 3 })
    await expect(guard.checkMonitorSampleCountMax(created!.organizationId, 3)).resolves.toBeUndefined()
  })

  it('REGISTRATION 缺省 off → 注册被拒并返回关闭文案（fail-closed）', async () => {
    const service = buildRegistrationService({ REGISTRATION_ENABLED: 'off', BILLING_ENFORCEMENT: 'on' })
    await expect(
      service.registerTrial({ username: 'closeduser', password: 'Zx9!qwerty', ip: '198.51.100.7' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: REGISTRATION_CLOSED_MESSAGE })
    expect(service.isEnabled()).toBe(false)
  })

  it('ENFORCEMENT off（即便 REGISTRATION=on）→ 注册同样被拒（双开关联动）', async () => {
    const service = buildRegistrationService({ REGISTRATION_ENABLED: 'on', BILLING_ENFORCEMENT: 'off' })
    await expect(
      service.registerTrial({ username: 'enfoffuser', password: 'Zx9!qwerty', ip: '198.51.100.8' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: REGISTRATION_CLOSED_MESSAGE })
  })
})
