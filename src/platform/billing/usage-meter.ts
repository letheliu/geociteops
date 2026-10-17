import type { Prisma, PrismaClient } from '@prisma/client'
import { shanghaiMonthWindow } from './entitlement-merge.js'

// ---------------------------------------------------------------------------
// 用量计量（规格 §6.4）：业务检查点 meter.record 进内存缓冲，flush() 批量落
// UsageRecord；月度用量查询走 DB 聚合（上海自然月窗口，同任务 7 窗口函数）。
// enforcement 关闭时 record 仍照记（Ruling 1）——meter 不感知开关。
// ---------------------------------------------------------------------------

/** 业务侧已使用的计量 kind（后续任务（消费账单）扩展新值时在此登记） */
export const USAGE_KINDS = {
  queryAdded: 'QUERY_ADDED',
  diagnosticRun: 'DIAGNOSTIC_RUN',
  pageCreated: 'PAGE_CREATED',
  optimizationCreated: 'OPTIMIZATION_CREATED',
} as const

export type UsageKind = (typeof USAGE_KINDS)[keyof typeof USAGE_KINDS]

/** record 入参（occurredAt 由 meter 在入缓冲时打点，不接受外部注入） */
export interface UsageEntryInput {
  organizationId: string
  workspaceId: string
  kind: UsageKind | (string & {})
  platform?: string
  quantity?: number
  tokens?: number
  costMicros?: bigint
}

/** 缓冲行：入缓冲时已补齐 quantity 缺省与 occurredAt */
interface BufferedUsageEntry {
  organizationId: string
  workspaceId: string
  kind: string
  platform?: string
  quantity: number
  tokens?: number
  costMicros?: bigint
  occurredAt: Date
}

export interface UsageMeter {
  /** 计量一次业务用量：只入内存缓冲（同步、不落库、不抛错） */
  record(entry: UsageEntryInput): void
  /** 缓冲批量落库（createMany）并清空；空缓冲 no-op；失败保留缓冲待重试。返回落库行数 */
  flush(): Promise<number>
  /** 当月（Asia/Shanghai 自然月）该 kind 的 Σquantity（DB 聚合，不含未 flush 缓冲） */
  getMonthlyUsage(organizationId: string, kind: string, now?: Date): Promise<number>
  /** 当前缓冲条数（观测/测试用） */
  pending(): number
}

export interface UsageMeterDeps {
  prisma: PrismaClient
  /** 时钟注入（occurredAt 打点/月度窗口），缺省系统时间 */
  now?: () => Date
}

export function createUsageMeter(deps: UsageMeterDeps): UsageMeter {
  const { prisma } = deps
  const now = deps.now ?? (() => new Date())
  const buffer: BufferedUsageEntry[] = []
  // 并发 flush（定时器 + 优雅关闭手动触发）重入保护：in-flight 期间后续调用直接返回
  let flushing = false

  return {
    record(entry) {
      const row: BufferedUsageEntry = {
        organizationId: entry.organizationId,
        workspaceId: entry.workspaceId,
        kind: entry.kind,
        quantity: entry.quantity ?? 1,
        occurredAt: now(),
      }
      if (entry.platform !== undefined) row.platform = entry.platform
      if (entry.tokens !== undefined) row.tokens = entry.tokens
      if (entry.costMicros !== undefined) row.costMicros = entry.costMicros
      buffer.push(row)
    },

    async flush() {
      if (flushing || buffer.length === 0) return 0
      flushing = true
      try {
        const batch = [...buffer]
        await prisma.usageRecord.createMany({
          data: batch as unknown as Prisma.UsageRecordCreateManyInput[],
        })
        // 落库成功后才移除（失败抛错时缓冲保留，下个 flush 周期重试不丢用量）
        buffer.splice(0, batch.length)
        return batch.length
      } finally {
        flushing = false
      }
    },

    async getMonthlyUsage(organizationId, kind, nowValue) {
      const window = shanghaiMonthWindow(nowValue ?? now())
      const result = await prisma.usageRecord.aggregate({
        _sum: { quantity: true },
        where: {
          organizationId,
          kind,
          occurredAt: { gte: window.periodStart, lt: window.periodEnd },
        },
      })
      return result._sum.quantity ?? 0
    },

    pending() {
      return buffer.length
    },
  }
}
