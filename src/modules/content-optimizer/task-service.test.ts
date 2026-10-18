import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createTaskService } from './task-service.js'
import {
  createEntitlementGuard,
  OptimizationsNotAllowedError,
} from '../../platform/billing/entitlement-guard.js'
import { createUsageMeter } from '../../platform/billing/usage-meter.js'

/** TRIAL 形态 OE 行：内部 marker 关闭优化 + 配额 0（门禁判定源） */
const LIMITS_TRIAL = {
  maxWorkspaces: 1,
  maxQueries: 10,
  maxPages: 5,
  diagnosticRunsPerMonth: 0,
  samplesPerRun: 1,
  optimizationsPerMonth: 0,
  allowedPlatforms: [],
  _optimizationsDisabled: true,
}

function mockPrisma() {
  return {
    optimizationTask: {
      create: vi.fn().mockImplementation(async (args: any) => ({
        id: 'task-1',
        ...args.data,
      })),
      findMany: vi.fn().mockResolvedValue([
        { id: 'task-1', status: 'PENDING', workspaceId: 'w1' },
      ]),
      findUnique: vi.fn().mockImplementation(async (args: any) => ({
        id: args.where.id,
        status: 'PENDING',
        workspaceId: 'w1',
        pageId: 'page-1',
      })),
      update: vi.fn().mockImplementation(async (args: any) => ({
        id: args.where.id,
        ...args.data,
      })),
    },
    contentPage: {
      update: vi.fn().mockResolvedValue({}),
    },
  } as any
}

describe('OptimizationTaskService', () => {
  let prisma: ReturnType<typeof mockPrisma>

  beforeEach(() => {
    prisma = mockPrisma()
  })

  it('create 创建任务', async () => {
    const svc = createTaskService({ prisma })
    const task = await svc.create({
      workspaceId: 'w1',
      type: 'REWRITE_CONTENT',
      pageId: 'page-1',
      beforeScore: 40,
      afterScore: 85,
    })
    expect(task.id).toBe('task-1')
    expect(prisma.optimizationTask.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: 'w1',
        type: 'REWRITE_CONTENT',
        status: 'PENDING',
      }),
    })
  })

  it('list 按 workspace 查询任务', async () => {
    const svc = createTaskService({ prisma })
    const tasks = await svc.list('w1')
    expect(tasks).toHaveLength(1)
    expect(prisma.optimizationTask.findMany).toHaveBeenCalledWith({
      where: { workspaceId: 'w1' },
    })
  })

  it('list 按 workspace + status 过滤', async () => {
    const svc = createTaskService({ prisma })
    await svc.list('w1', 'PENDING')
    expect(prisma.optimizationTask.findMany).toHaveBeenCalledWith({
      where: { workspaceId: 'w1', status: 'PENDING' },
    })
  })

  it('getById 查询单个任务', async () => {
    const svc = createTaskService({ prisma })
    const task = await svc.getById('task-1')
    expect(task?.id).toBe('task-1')
  })

  it('review approve 时 status 变为 REVIEWED，同时更新 ContentPage', async () => {
    const svc = createTaskService({ prisma })
    const task = await svc.review('task-1', true)
    expect(task.status).toBe('REVIEWED')
    expect(prisma.optimizationTask.update).toHaveBeenCalledWith({
      where: { id: 'task-1' },
      data: { status: 'REVIEWED' },
    })
    expect(prisma.contentPage.update).toHaveBeenCalled()
  })

  it('review reject 时 status 退回 PENDING 并记录 reviewNote', async () => {
    const svc = createTaskService({ prisma })
    const task = await svc.review('task-1', false, '内容不准确')
    expect(task.status).toBe('PENDING')
    expect(prisma.optimizationTask.update).toHaveBeenCalledWith({
      where: { id: 'task-1' },
      data: { status: 'PENDING', reviewNote: '内容不准确' },
    })
  })

  it('publish 将 REVIEWED 任务变为 PUBLISHED', async () => {
    prisma.optimizationTask.findUnique = vi.fn().mockResolvedValue({
      id: 'task-1',
      status: 'REVIEWED',
      pageId: 'page-1',
    })
    const svc = createTaskService({ prisma })
    const task = await svc.publish('task-1')
    expect(task.status).toBe('PUBLISHED')
    expect(prisma.optimizationTask.update).toHaveBeenCalledWith({
      where: { id: 'task-1' },
      data: { status: 'PUBLISHED' },
    })
  })

  it('publish 非 REVIEWED 任务时报错', async () => {
    prisma.optimizationTask.findUnique = vi.fn().mockResolvedValue({
      id: 'task-1',
      status: 'PENDING',
    })
    const svc = createTaskService({ prisma })
    await expect(svc.publish('task-1')).rejects.toThrow()
  })

  it('publish 触发 onPublished 回调，传入更新后的任务', async () => {
    prisma.optimizationTask.findUnique = vi.fn().mockResolvedValue({
      id: 'task-1',
      status: 'REVIEWED',
      pageId: 'page-1',
      workspaceId: 'w1',
    })
    const onPublished = vi.fn()
    const svc = createTaskService({ prisma, onPublished })
    await svc.publish('task-1')
    expect(onPublished).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'task-1', status: 'PUBLISHED' }),
    )
  })

  it('publish 未提供 onPublished 时正常更新状态', async () => {
    prisma.optimizationTask.findUnique = vi.fn().mockResolvedValue({
      id: 'task-1',
      status: 'REVIEWED',
      pageId: 'page-1',
    })
    const svc = createTaskService({ prisma })
    const task = await svc.publish('task-1')
    expect(task.status).toBe('PUBLISHED')
  })

  it('publish 回调抛错被捕获，不影响状态更新（仅记录日志）', async () => {
    prisma.optimizationTask.findUnique = vi.fn().mockResolvedValue({
      id: 'task-1',
      status: 'REVIEWED',
      pageId: 'page-1',
    })
    const onPublished = vi.fn().mockRejectedValue(new Error('回调失败'))
    const svc = createTaskService({ prisma, onPublished })
    const task = await svc.publish('task-1')
    expect(task.status).toBe('PUBLISHED')
    expect(onPublished).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// M2 §3.3 任务 1：review 状态守卫（双向）
//
// 闭环引入 AWAITING_VERIFICATION/VERIFIED 两态后，review 若仍无守卫，会留下
// "FAILED 任务经 API 审核复活/退回"的洞：FAILED 是建议生成失败的终态（规格 §6.2），
// 应由用户拒绝后重建，而非原地复活。仅 PENDING/IN_PROGRESS 可被审核。
// ---------------------------------------------------------------------------

describe('taskService.review 状态守卫（M2 §3.3）', () => {
  function svcWithStatus(status: string) {
    const prisma = mockPrisma() as any
    prisma.optimizationTask.findUnique = vi.fn().mockResolvedValue({
      id: 'task-1',
      status,
      workspaceId: 'w1',
      pageId: 'page-1',
    })
    return { prisma, svc: createTaskService({ prisma }) }
  }

  it('approve：FAILED 任务抛错（不得复活为 REVIEWED）', async () => {
    const { prisma, svc } = svcWithStatus('FAILED')
    await expect(svc.review('task-1', true)).rejects.toThrow(/FAILED/)
    expect(prisma.optimizationTask.update).not.toHaveBeenCalled()
  })

  it('reject：FAILED 任务抛错（不得被退回为 PENDING）', async () => {
    const { prisma, svc } = svcWithStatus('FAILED')
    await expect(svc.review('task-1', false, '内容不准确')).rejects.toThrow(/FAILED/)
    expect(prisma.optimizationTask.update).not.toHaveBeenCalled()
  })

  it('approve：AWAITING_VERIFICATION（已发布待验证）不可再审核', async () => {
    const { prisma, svc } = svcWithStatus('AWAITING_VERIFICATION')
    await expect(svc.review('task-1', true)).rejects.toThrow()
    expect(prisma.optimizationTask.update).not.toHaveBeenCalled()
  })

  it('approve：VERIFIED（闭环终态）不可再审核', async () => {
    const { prisma, svc } = svcWithStatus('VERIFIED')
    await expect(svc.review('task-1', true)).rejects.toThrow()
    expect(prisma.optimizationTask.update).not.toHaveBeenCalled()
  })

  it('PENDING 任务 approve/reject 均正常（守卫不误伤主流程）', async () => {
    const approve = svcWithStatus('PENDING')
    await expect(approve.svc.review('task-1', true)).resolves.toMatchObject({ status: 'REVIEWED' })

    const reject = svcWithStatus('PENDING')
    await expect(reject.svc.review('task-1', false, '改')).resolves.toMatchObject({ status: 'PENDING' })
  })

  it('IN_PROGRESS 任务 approve/reject 均正常', async () => {
    const approve = svcWithStatus('IN_PROGRESS')
    await expect(approve.svc.review('task-1', true)).resolves.toMatchObject({ status: 'REVIEWED' })

    const reject = svcWithStatus('IN_PROGRESS')
    await expect(reject.svc.review('task-1', false)).resolves.toMatchObject({ status: 'PENDING' })
  })

  it('REVIEWED 任务不可再次审核（防止重复 approve 幂等外溢）', async () => {
    const { prisma, svc } = svcWithStatus('REVIEWED')
    await expect(svc.review('task-1', true)).rejects.toThrow()
    expect(prisma.optimizationTask.update).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// M2 §3.3 优化门禁兜底：绕过 router 直调 create（KG extractor 保留直连、SDK 内部调用）
// 仍必须在写库之前拒绝，且软限/计量一并跳过——拒绝即零副作用。
// ---------------------------------------------------------------------------

describe('taskService.create 优化门禁兜底（M2 §3.3）', () => {
  function assemble(allowed: boolean) {
    const prisma = mockPrisma() as any
    prisma.workspace = {
      findUnique: vi.fn(async () => ({ id: 'w1', organizationId: 'org-trial' })),
    }
    // 放行形态：正式租户（无 marker，配额为正）；拒绝形态：TRIAL（marker + 0）
    const limits = allowed
      ? { ...LIMITS_TRIAL, _optimizationsDisabled: undefined, optimizationsPerMonth: 20 }
      : LIMITS_TRIAL
    if (allowed) delete (limits as Record<string, unknown>)._optimizationsDisabled
    prisma.organizationEntitlement = {
      findUnique: vi.fn(async () => ({ organizationId: 'org-trial', limits })),
    }
    const meterPrisma: any = { usageRecord: { createMany: vi.fn(), aggregate: vi.fn(async () => ({ _sum: { quantity: 0 } })) } }
    const audit = { record: vi.fn(async () => {}) }
    const meter = createUsageMeter({ prisma: meterPrisma })
    const guard = createEntitlementGuard({
      prisma,
      meter,
      audit: audit as any,
      enforcement: () => true,
    })
    const svc = createTaskService({ prisma, billing: { guard, meter } })
    return { prisma, svc }
  }

  it('被拒：零写库（create 未被调用）', async () => {
    const { prisma, svc } = assemble(false)
    await expect(
      svc.create({ workspaceId: 'w1', type: 'REWRITE_CONTENT', pageId: 'page-1' }),
    ).rejects.toThrow()
    expect(prisma.optimizationTask.create).not.toHaveBeenCalled()
  })

  it('被拒：错误可被入口层识别为优化门禁（OptimizationsNotAllowedError）', async () => {
    const { svc } = assemble(false)
    await expect(
      svc.create({ workspaceId: 'w1', type: 'REWRITE_CONTENT' }),
    ).rejects.toBeInstanceOf(OptimizationsNotAllowedError)
  })

  it('放行：正常建任务（正式租户回归）', async () => {
    const { prisma, svc } = assemble(true)
    const task = await svc.create({ workspaceId: 'w1', type: 'REWRITE_CONTENT' })
    expect(task.id).toBe('task-1')
    expect(prisma.optimizationTask.create).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// 任务 9：计费检查点——优化任务创建 optimizationsPerMonth 软限 + 计量
// ---------------------------------------------------------------------------

describe('OptimizationTaskService 计费检查点（任务 9）', () => {
  const LIMITS = { maxWorkspaces: 10, optimizationsPerMonth: 20 }

  function assemble(opts: { enforcement: () => boolean; monthlyUsage?: number }) {
    const prisma = mockPrisma() as any
    prisma.workspace = {
      findUnique: vi.fn(async () => ({ id: 'w1', organizationId: 'org-1' })),
    }
    prisma.organizationEntitlement = {
      findUnique: vi.fn(async () => ({ organizationId: 'org-1', limits: LIMITS })),
    }
    const meterPrisma: any = {
      usageRecord: {
        createMany: vi.fn(async () => ({ count: 0 })),
        aggregate: vi.fn(async () => ({ _sum: { quantity: opts.monthlyUsage ?? 0 } })),
      },
    }
    const meterAudit = { record: vi.fn(async () => {}), list: vi.fn(async () => ({ items: [], total: 0 })) }
    const meter = createUsageMeter({ prisma: meterPrisma })
    const guard = createEntitlementGuard({
      prisma,
      meter,
      audit: meterAudit as any,
      enforcement: opts.enforcement,
    })
    const svc = createTaskService({ prisma, billing: { guard, meter } })
    return { prisma, svc, meter, meterAudit, meterPrisma }
  }

  it('enforcement on 月度超额：软限不拦截——任务照常创建 + audit 告警 + meter 计量', async () => {
    const { prisma, svc, meter, meterAudit } = assemble({ enforcement: () => true, monthlyUsage: 20 })
    const task = await svc.create({ workspaceId: 'w1', type: 'REWRITE_CONTENT', pageId: 'page-1' })
    expect(task.id).toBe('task-1')
    expect(prisma.optimizationTask.create).toHaveBeenCalledTimes(1)
    expect(meterAudit.record).toHaveBeenCalledWith({
      actorType: 'SYSTEM',
      action: 'quota.soft_exceeded',
      organizationId: 'org-1',
      diff: { kind: 'optimizationsPerMonth', current: 20, limit: 20, organizationId: 'org-1' },
    })
    expect(meter.pending()).toBe(1)
  })

  it('enforcement on 未超额：不告警，照常计量 OPTIMIZATION_CREATED', async () => {
    const { svc, meter, meterAudit, meterPrisma } = assemble({ enforcement: () => true, monthlyUsage: 3 })
    await svc.create({ workspaceId: 'w1', type: 'REWRITE_CONTENT' })
    expect(meterAudit.record).not.toHaveBeenCalled()
    await meter.flush()
    const rows = meterPrisma.usageRecord.createMany.mock.calls[0][0].data
    expect(rows[0]).toMatchObject({
      organizationId: 'org-1',
      workspaceId: 'w1',
      kind: 'OPTIMIZATION_CREATED',
      quantity: 1,
    })
  })

  it('enforcement off：不查配额，计量照记（Ruling 1）；未注入 billing 则零检查', async () => {
    const { prisma, svc, meter, meterAudit } = assemble({ enforcement: () => false })
    await svc.create({ workspaceId: 'w1', type: 'REWRITE_CONTENT' })
    expect(prisma.organizationEntitlement.findUnique).not.toHaveBeenCalled()
    expect(meterAudit.record).not.toHaveBeenCalled()
    expect(meter.pending()).toBe(1)

    const bare = createTaskService({ prisma })
    await expect(bare.create({ workspaceId: 'w1', type: 'REWRITE_CONTENT' })).resolves.toMatchObject({ id: 'task-1' })
  })
})
