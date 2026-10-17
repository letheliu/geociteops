import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createUsageMeter } from './usage-meter.js'

const FIXED_NOW = new Date('2026-10-15T02:00:00+08:00') // = 2026-10-14T18:00:00Z

function makePrisma() {
  const prisma: any = {
    usageRecord: {
      createMany: vi.fn(async () => ({ count: 0 })),
      aggregate: vi.fn(async () => ({ _sum: { quantity: null } })),
    },
  }
  return prisma
}

function makeMeter(prisma = makePrisma(), now: () => Date = () => FIXED_NOW) {
  return createUsageMeter({ prisma, now })
}

describe('usageMeter.record（内存缓冲）', () => {
  it('record 只入缓冲不落库（无 prisma 调用），字段原样保留', () => {
    const prisma = makePrisma()
    const meter = makeMeter(prisma)
    meter.record({
      organizationId: 'org-1',
      workspaceId: 'ws-1',
      kind: 'QUERY_ADDED',
      quantity: 3,
      platform: 'deepseek',
      tokens: 1200,
      costMicros: 45_000n,
    })
    expect(prisma.usageRecord.createMany).not.toHaveBeenCalled()
    expect(meter.pending()).toBe(1)

    meter.record({ organizationId: 'org-1', workspaceId: 'ws-1', kind: 'DIAGNOSTIC_RUN' })
    expect(meter.pending()).toBe(2)
  })

  it('record 发生时间在入缓冲时打点（occurredAt = now()，非 flush 时点）', async () => {
    const prisma = makePrisma()
    const meter = makeMeter(prisma)
    meter.record({ organizationId: 'org-1', workspaceId: 'ws-1', kind: 'PAGE_CREATED' })
    await meter.flush()
    const rows = prisma.usageRecord.createMany.mock.calls[0][0].data
    expect(rows[0].occurredAt).toEqual(FIXED_NOW)
  })
})

describe('usageMeter.flush', () => {
  it('空缓冲 no-op：不触 prisma', async () => {
    const prisma = makePrisma()
    const meter = makeMeter(prisma)
    const written = await meter.flush()
    expect(written).toBe(0)
    expect(prisma.usageRecord.createMany).not.toHaveBeenCalled()
  })

  it('非空缓冲 createMany 批量落库并清空；quantity 缺省 1', async () => {
    const prisma = makePrisma()
    prisma.usageRecord.createMany.mockResolvedValue({ count: 2 })
    const meter = makeMeter(prisma)
    meter.record({ organizationId: 'org-1', workspaceId: 'ws-1', kind: 'QUERY_ADDED', quantity: 5 })
    meter.record({ organizationId: 'org-2', workspaceId: 'ws-2', kind: 'DIAGNOSTIC_RUN' })

    const written = await meter.flush()
    expect(written).toBe(2)
    const arg = prisma.usageRecord.createMany.mock.calls[0][0]
    expect(arg.data).toHaveLength(2)
    expect(arg.data[0]).toMatchObject({
      organizationId: 'org-1',
      workspaceId: 'ws-1',
      kind: 'QUERY_ADDED',
      quantity: 5,
      occurredAt: FIXED_NOW,
    })
    expect(arg.data[1]).toMatchObject({
      organizationId: 'org-2',
      kind: 'DIAGNOSTIC_RUN',
      quantity: 1,
    })
    expect(meter.pending()).toBe(0)
  })

  it('flush 后缓冲已清：再次 flush 为 no-op（不重复落库）', async () => {
    const prisma = makePrisma()
    const meter = makeMeter(prisma)
    meter.record({ organizationId: 'org-1', workspaceId: 'ws-1', kind: 'QUERY_ADDED' })
    await meter.flush()
    await meter.flush()
    expect(prisma.usageRecord.createMany).toHaveBeenCalledTimes(1)
  })

  it('createMany 失败缓冲保留（下个周期重试，不丢用量）', async () => {
    const prisma = makePrisma()
    prisma.usageRecord.createMany.mockRejectedValue(new Error('db down'))
    const meter = makeMeter(prisma)
    meter.record({ organizationId: 'org-1', workspaceId: 'ws-1', kind: 'QUERY_ADDED' })
    await expect(meter.flush()).rejects.toThrow('db down')
    expect(meter.pending()).toBe(1)
  })
})

describe('usageMeter.getMonthlyUsage', () => {
  it('聚合当月（Asia/Shanghai 自然月）Σquantity，窗口 [当月起, 次月起)', async () => {
    const prisma = makePrisma()
    prisma.usageRecord.aggregate.mockResolvedValue({ _sum: { quantity: 42 } })
    const meter = makeMeter(prisma)

    const usage = await meter.getMonthlyUsage('org-1', 'QUERY_ADDED')
    expect(usage).toBe(42)
    expect(prisma.usageRecord.aggregate).toHaveBeenCalledWith({
      _sum: { quantity: true },
      where: {
        organizationId: 'org-1',
        kind: 'QUERY_ADDED',
        occurredAt: {
          gte: new Date('2026-09-30T16:00:00.000Z'),
          lt: new Date('2026-10-31T16:00:00.000Z'),
        },
      },
    })
  })

  it('now 参数覆盖缺省时钟；Σ为 null（无记录）按 0', async () => {
    const prisma = makePrisma()
    const meter = makeMeter(prisma)

    const usage = await meter.getMonthlyUsage('org-1', 'PAGE_CREATED', new Date('2026-11-01T00:00:00+08:00'))
    expect(usage).toBe(0)
    const where = prisma.usageRecord.aggregate.mock.calls[0][0].where
    expect(where.occurredAt.gte).toEqual(new Date('2026-10-31T16:00:00.000Z'))
    expect(where.occurredAt.lt).toEqual(new Date('2026-11-30T16:00:00.000Z'))
  })
})
