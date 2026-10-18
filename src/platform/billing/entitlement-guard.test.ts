import { describe, expect, it, vi, beforeEach } from 'vitest'
import {
  createEntitlementGuard,
  PlatformNotAllowedError,
  QuotaExceededError,
} from './entitlement-guard.js'
import type { UsageMeter } from './usage-meter.js'

// ---------------------------------------------------------------------------
// 测试基建：mock prisma（照 entitlement-service.test.ts 模式）——
// 交互式事务把 prisma 自身作为 tx 传回（委托同源），$queryRaw 回锁行。
// ---------------------------------------------------------------------------

const FIXED_NOW = new Date('2026-10-15T02:00:00+08:00')

const OCTOBER_WINDOW = {
  periodStart: new Date('2026-09-30T16:00:00.000Z'),
  periodEnd: new Date('2026-10-31T16:00:00.000Z'),
}

const ZERO_LIMITS = {
  maxWorkspaces: 0,
  maxQueries: 0,
  maxPages: 0,
  diagnosticRunsPerMonth: 0,
  samplesPerRun: 0,
  optimizationsPerMonth: 0,
  allowedPlatforms: [],
}

function makeLockRow(limits: Record<string, unknown>) {
  return { organizationId: 'org-1', limits: { ...ZERO_LIMITS, ...limits } }
}

function makePrisma(
  opts: {
    /** getLimits 读路径（softCheck/checkPlatforms/checkSamplesPerRun）的 OE 行 */
    oeRow?: Record<string, unknown> | null
    /** FOR UPDATE 锁行返回（含 limits）；缺省 [makeLockRow({})] */
    lockedRows?: Record<string, unknown>[]
    /** 非归档 workspace 计数（hardCheck 用） */
    workspaceCount?: number
  } = {},
) {
  const prisma: any = {
    organizationEntitlement: {
      findUnique: vi.fn(async () => (opts.oeRow === undefined ? null : opts.oeRow)),
      upsert: vi.fn(async () => ({})),
    },
    workspace: {
      count: vi.fn(async () => opts.workspaceCount ?? 0),
    },
    $queryRaw: vi.fn(async () => opts.lockedRows ?? [makeLockRow({})]),
  }
  prisma.$transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma))
  return prisma
}

function makeMeter(monthlyUsage = 0) {
  return {
    record: vi.fn(),
    flush: vi.fn(async () => 0),
    getMonthlyUsage: vi.fn(async () => monthlyUsage),
    pending: vi.fn(() => 0),
  } as unknown as UsageMeter & { getMonthlyUsage: ReturnType<typeof vi.fn>; record: ReturnType<typeof vi.fn> }
}

function makeAudit() {
  return { record: vi.fn(async () => {}), list: vi.fn(async () => ({ items: [], total: 0 })) }
}

function makeGuard(
  prisma = makePrisma(),
  meter = makeMeter(),
  audit = makeAudit(),
  enforcement: () => boolean = () => true,
) {
  const guard = createEntitlementGuard({ prisma, meter, audit, enforcement, now: () => FIXED_NOW })
  return { guard, prisma, meter, audit }
}

// ---------------------------------------------------------------------------
// enforcement off（Ruling 1）：全放行、不做任何查询
// ---------------------------------------------------------------------------

describe('entitlementGuard（enforcement off）', () => {
  it('hardCheck 直接放行：不开事务不查配额', async () => {
    const { guard, prisma } = makeGuard(makePrisma(), makeMeter(), makeAudit(), () => false)
    await guard.hardCheck('org-1', 'maxWorkspaces')
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it('softCheck 直接返回 allowed，不做用量查询（裁定：off 时不查）', async () => {
    const { guard, meter } = makeGuard(makePrisma(), makeMeter(999), makeAudit(), () => false)
    const result = await guard.softCheck('org-1', 'maxQueries')
    expect(result.allowed).toBe(true)
    expect(meter.getMonthlyUsage).not.toHaveBeenCalled()
  })

  it('checkPlatforms / checkSamplesPerRun 直接放行（违规平台也不抛）', async () => {
    const { guard, prisma } = makeGuard(makePrisma(), makeMeter(), makeAudit(), () => false)
    await guard.checkPlatforms('org-1', ['not-in-plan'])
    await guard.checkSamplesPerRun('org-1', 9999)
    expect(prisma.organizationEntitlement.findUnique).not.toHaveBeenCalled()
  })

  it('acquireWorkspaceQuotaSlot 返回空槽：commit/rollback 均 no-op', async () => {
    const { guard, prisma } = makeGuard(makePrisma(), makeMeter(), makeAudit(), () => false)
    const slot = await guard.acquireWorkspaceQuotaSlot('org-1')
    await slot.commit()
    await slot.rollback()
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// hardCheck / acquireWorkspaceQuotaSlot（maxWorkspaces 硬限）
// ---------------------------------------------------------------------------

describe('entitlementGuard.hardCheck（enforcement on）', () => {
  it('未超限放行：事务内 upsert 锁行 + FOR UPDATE + count 非 ARCHIVED', async () => {
    const prisma = makePrisma({
      lockedRows: [makeLockRow({ maxWorkspaces: 5 })],
      workspaceCount: 4,
    })
    const { guard } = makeGuard(prisma)
    await guard.hardCheck('org-1', 'maxWorkspaces')

    expect(prisma.$transaction).toHaveBeenCalledTimes(1)
    // 调用序：先 upsert 空行（不存在则建），再行锁
    expect(prisma.organizationEntitlement.upsert.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.$queryRaw.mock.invocationCallOrder[0],
    )
    // FOR UPDATE 是 tagged template：calls[0][0] 模板串，calls[0][1] 为参数化 organizationId
    const raw = prisma.$queryRaw.mock.calls[0]
    expect(String(raw[0])).toContain('FOR UPDATE')
    expect(raw[1]).toBe('org-1')
    expect(prisma.workspace.count).toHaveBeenCalledWith({
      where: { organizationId: 'org-1', status: { not: 'ARCHIVED' } },
    })
  })

  it('upsert 缺省行 = 全 0 配额 + 当月窗口（无 OE 行的企业也获得锁锚，且全 0 配额即硬拒）', async () => {
    const prisma = makePrisma({ lockedRows: [makeLockRow({})] })
    const { guard } = makeGuard(prisma)
    await expect(guard.hardCheck('org-1', 'maxWorkspaces')).rejects.toThrow(QuotaExceededError)
    expect(prisma.organizationEntitlement.upsert).toHaveBeenCalledWith({
      where: { organizationId: 'org-1' },
      create: {
        organizationId: 'org-1',
        limits: ZERO_LIMITS,
        periodStart: OCTOBER_WINDOW.periodStart,
        periodEnd: OCTOBER_WINDOW.periodEnd,
      },
      update: {},
    })
  })

  it('count >= maxWorkspaces 抛 QuotaExceededError（含 limit/current 字段）', async () => {
    const prisma = makePrisma({
      lockedRows: [makeLockRow({ maxWorkspaces: 3 })],
      workspaceCount: 3,
    })
    const { guard } = makeGuard(prisma)
    await expect(guard.hardCheck('org-1', 'maxWorkspaces')).rejects.toThrow(QuotaExceededError)
    try {
      await guard.hardCheck('org-1', 'maxWorkspaces')
    } catch (err) {
      const e = err as QuotaExceededError
      expect(e.name).toBe('QUOTA_EXCEEDED')
      expect(e.field).toBe('maxWorkspaces')
      expect(e.limit).toBe(3)
      expect(e.current).toBe(3)
    }
  })

  it('SUSPENDED workspace 计入配额（只排除 ARCHIVED）', async () => {
    const prisma = makePrisma({
      lockedRows: [makeLockRow({ maxWorkspaces: 2 })],
      workspaceCount: 2,
    })
    const { guard } = makeGuard(prisma)
    await expect(guard.hardCheck('org-1', 'maxWorkspaces')).rejects.toThrow(QuotaExceededError)
  })
})

describe('entitlementGuard.acquireWorkspaceQuotaSlot（事务句柄）', () => {
  it('检查通过返回槽；业务创建后 commit 提交事务（释放锁）', async () => {
    const prisma = makePrisma({ lockedRows: [makeLockRow({ maxWorkspaces: 2 })], workspaceCount: 1 })
    const { guard } = makeGuard(prisma)
    const slot = await guard.acquireWorkspaceQuotaSlot('org-1')
    // 业务方在锁持有窗口内完成 workspace 创建（mock：计数 +1 模拟已建）
    prisma.workspace.count.mockResolvedValue(2)
    await slot.commit()
    // 审查 M-2：隔离级别显式钉 READ COMMITTED（串行化论证依赖），不留给部署默认
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      timeout: 15_000,
      isolationLevel: 'ReadCommitted',
    })
  })

  it('commit/rollback 幂等（重复调用 no-op，不重复抛错）', async () => {
    const prisma = makePrisma({ lockedRows: [makeLockRow({ maxWorkspaces: 2 })], workspaceCount: 1 })
    const { guard } = makeGuard(prisma)
    const slot = await guard.acquireWorkspaceQuotaSlot('org-1')
    await slot.commit()
    await slot.commit()
    await slot.rollback()
  })

  it('rollback 回滚检查事务（业务创建失败路径：锁释放、不留悬挂事务）', async () => {
    const prisma = makePrisma({ lockedRows: [makeLockRow({ maxWorkspaces: 2 })], workspaceCount: 1 })
    const { guard } = makeGuard(prisma)
    const slot = await guard.acquireWorkspaceQuotaSlot('org-1')
    await slot.rollback()
  })

  it('串行并发模拟：第一个槽持有期间第二个 acquire 抛 QuotaExceededError（count 已见新创建）', async () => {
    const prisma = makePrisma({ lockedRows: [makeLockRow({ maxWorkspaces: 1 })], workspaceCount: 0 })
    const { guard } = makeGuard(prisma)

    const slot1 = await guard.acquireWorkspaceQuotaSlot('org-1')
    // 第一个业务方在锁窗口内创建了 workspace（mock：FOR UPDATE 阻塞至 commit 后 count 可见）
    prisma.workspace.count.mockResolvedValue(1)
    await slot1.commit()

    // 第二个事务在 commit 后拿到锁：count=1 >= maxWorkspaces=1 → 硬拒
    await expect(guard.acquireWorkspaceQuotaSlot('org-1')).rejects.toThrow(QuotaExceededError)
  })

  it('配额耗尽时 acquire 直接抛（检查阶段失败即拒绝，无需等 commit）', async () => {
    const prisma = makePrisma({ lockedRows: [makeLockRow({ maxWorkspaces: 1 })], workspaceCount: 1 })
    const { guard } = makeGuard(prisma)
    await expect(guard.acquireWorkspaceQuotaSlot('org-1')).rejects.toThrow(QuotaExceededError)
  })
})

// ---------------------------------------------------------------------------
// softCheck（调用量类软限：不拦截、超额 audit 告警）
// ---------------------------------------------------------------------------

describe('entitlementGuard.softCheck（enforcement on）', () => {
  it('未超限：返回 { allowed: true, current, limit }，不告警', async () => {
    const prisma = makePrisma({ oeRow: { organizationId: 'org-1', limits: { ...ZERO_LIMITS, maxQueries: 100 } } })
    const meter = makeMeter(40)
    const { guard, audit } = makeGuard(prisma, meter, makeAudit())
    const result = await guard.softCheck('org-1', 'maxQueries')
    expect(result).toEqual({ allowed: true, current: 40, limit: 100 })
    expect(meter.getMonthlyUsage).toHaveBeenCalledWith('org-1', 'QUERY_ADDED', FIXED_NOW)
    expect(audit.record).not.toHaveBeenCalled()
  })

  it('requested 计入判定：current + requested > limit 即超额', async () => {
    const prisma = makePrisma({
      oeRow: { organizationId: 'org-1', limits: { ...ZERO_LIMITS, maxQueries: 100 } },
    })
    const { guard } = makeGuard(prisma, makeMeter(95))
    const result = await guard.softCheck('org-1', 'maxQueries', 10)
    expect(result.allowed).toBe(false)
    // 不抛错（软限不拦截）
    expect(typeof result).toBe('object')
  })

  it('超额：audit 记 quota.soft_exceeded（actorType=SYSTEM，diff 含 kind/current/limit/organizationId）', async () => {
    const prisma = makePrisma({
      oeRow: { organizationId: 'org-1', limits: { ...ZERO_LIMITS, maxQueries: 100 } },
    })
    const audit = makeAudit()
    const { guard } = makeGuard(prisma, makeMeter(120), audit)
    const result = await guard.softCheck('org-1', 'maxQueries')
    expect(result).toEqual({ allowed: false, current: 120, limit: 100 })
    expect(audit.record).toHaveBeenCalledWith({
      actorType: 'SYSTEM',
      action: 'quota.soft_exceeded',
      organizationId: 'org-1',
      diff: { kind: 'maxQueries', current: 120, limit: 100, organizationId: 'org-1' },
    })
  })

  it('四类软限 key 均映射各自 usage kind（月度窗口聚合）', async () => {
    const prisma = makePrisma({
      oeRow: {
        organizationId: 'org-1',
        limits: { ...ZERO_LIMITS, diagnosticRunsPerMonth: 10, maxPages: 10, optimizationsPerMonth: 10 },
      },
    })
    const meter = makeMeter(0)
    const { guard } = makeGuard(prisma, meter, makeAudit())
    await guard.softCheck('org-1', 'diagnosticRunsPerMonth')
    await guard.softCheck('org-1', 'maxPages')
    await guard.softCheck('org-1', 'optimizationsPerMonth')
    expect(meter.getMonthlyUsage).toHaveBeenNthCalledWith(1, 'org-1', 'DIAGNOSTIC_RUN', FIXED_NOW)
    expect(meter.getMonthlyUsage).toHaveBeenNthCalledWith(2, 'org-1', 'PAGE_CREATED', FIXED_NOW)
    expect(meter.getMonthlyUsage).toHaveBeenNthCalledWith(3, 'org-1', 'OPTIMIZATION_CREATED', FIXED_NOW)
  })

  it('无 OE 行 → 全 0 配额：任何 requested 均超额并告警', async () => {
    const prisma = makePrisma({ oeRow: null })
    const audit = makeAudit()
    const { guard } = makeGuard(prisma, makeMeter(0), audit)
    const result = await guard.softCheck('org-1', 'maxPages', 1)
    expect(result.allowed).toBe(false)
    expect(audit.record).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// checkPlatforms（集合型硬语义）/ checkSamplesPerRun
// ---------------------------------------------------------------------------

describe('entitlementGuard.checkPlatforms（enforcement on）', () => {
  it('allowedPlatforms 空数组 = 全平台放行（迁移宽限语义）', async () => {
    const prisma = makePrisma({ oeRow: { organizationId: 'org-1', limits: { ...ZERO_LIMITS } } })
    const { guard } = makeGuard(prisma)
    await guard.checkPlatforms('org-1', ['deepseek', 'qwen', 'whatever-new'])
  })

  it('平台全在集合内：放行', async () => {
    const prisma = makePrisma({
      oeRow: {
        organizationId: 'org-1',
        limits: { ...ZERO_LIMITS, allowedPlatforms: ['deepseek', 'qwen'] },
      },
    })
    const { guard } = makeGuard(prisma)
    await guard.checkPlatforms('org-1', ['deepseek'])
    await guard.checkPlatforms('org-1', ['deepseek', 'qwen'])
  })

  it('违规平台抛 PlatformNotAllowedError（含违规平台名与允许集合）', async () => {
    const prisma = makePrisma({
      oeRow: {
        organizationId: 'org-1',
        limits: { ...ZERO_LIMITS, allowedPlatforms: ['deepseek', 'qwen'] },
      },
    })
    const { guard } = makeGuard(prisma)
    try {
      await guard.checkPlatforms('org-1', ['deepseek', 'gemini', 'gemini'])
      expect.unreachable('应抛 PlatformNotAllowedError')
    } catch (err) {
      const e = err as PlatformNotAllowedError
      expect(e).toBeInstanceOf(PlatformNotAllowedError)
      expect(e.name).toBe('PLATFORM_NOT_ALLOWED')
      expect(e.platforms).toEqual(['gemini'])
      expect(e.allowed).toEqual(['deepseek', 'qwen'])
      expect(e.message).toContain('gemini')
    }
  })
})

describe('entitlementGuard.checkSamplesPerRun（enforcement on）', () => {
  it('samples == samplesPerRun 放行（边界含等）', async () => {
    const prisma = makePrisma({
      oeRow: { organizationId: 'org-1', limits: { ...ZERO_LIMITS, samplesPerRun: 5 } },
    })
    const { guard } = makeGuard(prisma)
    await guard.checkSamplesPerRun('org-1', 5)
  })

  it('samples > samplesPerRun 抛 QuotaExceededError', async () => {
    const prisma = makePrisma({
      oeRow: { organizationId: 'org-1', limits: { ...ZERO_LIMITS, samplesPerRun: 5 } },
    })
    const { guard } = makeGuard(prisma)
    await expect(guard.checkSamplesPerRun('org-1', 6)).rejects.toThrow(QuotaExceededError)
  })
})

// ---------------------------------------------------------------------------
// monitorSampleCountMax 硬检查（M2 §3.0）：N 是单次运行参数而非月度累计，
// 因此走硬检查（抛错拒绝）而不是 softCheck（只审计）。
// ---------------------------------------------------------------------------

describe('entitlementGuard.checkMonitorSampleCountMax（enforcement on）', () => {
  it('requested == 声明值放行（边界含等）', async () => {
    const prisma = makePrisma({
      oeRow: { organizationId: 'org-1', limits: { ...ZERO_LIMITS, monitorSampleCountMax: 3 } },
    })
    const { guard } = makeGuard(prisma)
    await guard.checkMonitorSampleCountMax('org-1', 3)
  })

  it('requested > 声明值抛 QuotaExceededError（field=monitorSampleCountMax）', async () => {
    const prisma = makePrisma({
      oeRow: { organizationId: 'org-1', limits: { ...ZERO_LIMITS, monitorSampleCountMax: 3 } },
    })
    const { guard } = makeGuard(prisma)
    await expect(guard.checkMonitorSampleCountMax('org-1', 4)).rejects.toThrow(QuotaExceededError)
  })

  it('键缺失 = 不限：任意 N 放行（正式租户未声明 N 上限时不被拦死）', async () => {
    const prisma = makePrisma({
      oeRow: { organizationId: 'org-1', limits: { ...ZERO_LIMITS } },
    })
    const { guard } = makeGuard(prisma)
    await guard.checkMonitorSampleCountMax('org-1', 10)
  })

  it('无 OE 行 = 不限（兜底同零对象语义）', async () => {
    const { guard } = makeGuard(makePrisma({ oeRow: null }))
    await guard.checkMonitorSampleCountMax('org-1', 10)
  })

  it('enforcement off → 全放行且不查 OE 行', async () => {
    const prisma = makePrisma({
      oeRow: { organizationId: 'org-1', limits: { ...ZERO_LIMITS, monitorSampleCountMax: 3 } },
    })
    const { guard } = makeGuard(prisma, makeMeter(), makeAudit(), () => false)
    await guard.checkMonitorSampleCountMax('org-1', 9999)
    expect(prisma.organizationEntitlement.findUnique).not.toHaveBeenCalled()
  })
})
