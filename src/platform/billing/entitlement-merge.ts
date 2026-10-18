import type { ProductKind, SubscriptionStatus } from '@prisma/client'

// ---------------------------------------------------------------------------
// 规格 §6.4 合并规则表：企业配额 = 各有效订阅/加购的 entitlements 逐字段合并。
// 纯函数文件：不依赖 prisma（recompute、任务 8 开通 worker、任务 16 计量消费）。
// ---------------------------------------------------------------------------

/** 容量型字段清单（裁定）：多个有效订阅取 max，有效 ADDON 在基数上求和叠加 */
export const CAPACITY_FIELDS = [
  'maxWorkspaces',
  'maxQueries',
  'maxPages',
  'diagnosticRunsPerMonth',
  'samplesPerRun',
  'optimizationsPerMonth',
] as const

export type CapacityField = (typeof CAPACITY_FIELDS)[number]

/**
 * 可选容量键（M2 §3.0 monitorSampleCountMax）：**未声明 = 不限**（键不存在），
 * 与必填容量键的"缺失按 0"语义相反——N 上限缺失若按 0 处理，会把没有声明该键的
 * 正式租户全部拦死。因此它不进 CAPACITY_FIELDS 的 0 基线合并，走存在性合并。
 */
export const OPTIONAL_CAPACITY_FIELDS = ['monitorSampleCountMax'] as const

export type OptionalCapacityField = (typeof OPTIONAL_CAPACITY_FIELDS)[number]

/** 容量键全集（必填 ∪ 可选），供下游遍历型消费方（如 billing-router 配额投影）使用 */
export type CapacityKey = CapacityField | OptionalCapacityField

/** 下划线内部键前缀：_graceDays / _suppressReminder 等策略键，原样透传不参与合并 */
const INTERNAL_KEY_PREFIX = '_'

/** 集合型字段（裁定）：平台集合仅来自有效订阅的并集，ADDON 不扩 */
export const SET_FIELDS = ['allowedPlatforms'] as const

export type SetField = (typeof SET_FIELDS)[number]

/** mergeEntitlements 的订阅入参：planKind 已由调用方 join plan→product 取得 */
export interface MergeSubscriptionInput {
  planKind: ProductKind
  /** 套餐配额快照（Subscription.entitlements / ProductPlan.entitlements） */
  entitlements: Record<string, unknown>
  status: SubscriptionStatus
  endAt: Date
}

/** 合并结果（OrganizationEntitlement.limits 的结构形状） */
export interface MergedEntitlements {
  maxWorkspaces: number
  maxQueries: number
  maxPages: number
  diagnosticRunsPerMonth: number
  samplesPerRun: number
  optimizationsPerMonth: number
  allowedPlatforms: string[]
  /** 单次运行采样数 N 上限；键缺失 = 不限（区别于必填容量键的 0） */
  monitorSampleCountMax?: number
  /**
   * 下划线内部键（_graceDays / _suppressReminder 等）原样透传。
   * 它们是策略快照而非配额，不参与 §6.4 合并规则，但也不该在投影时被丢弃——
   * 订阅快照写了什么，企业级快照就留什么。
   */
  [internalKey: `_${string}`]: unknown
}

/** 全 0 默认对象（无任何有效项 / 新建 OE 行 / getLimits 无行兜底共用） */
export function zeroEntitlements(): MergedEntitlements {
  // 注意：不含 monitorSampleCountMax——该键"缺失 = 不限"，写 0 会把未声明 N 上限的
  // 租户全部拦死（且 zeroEntitlements 同时是新 OE 行的建行值，扩散面更大）
  return {
    maxWorkspaces: 0,
    maxQueries: 0,
    maxPages: 0,
    diagnosticRunsPerMonth: 0,
    samplesPerRun: 0,
    optimizationsPerMonth: 0,
    allowedPlatforms: [],
  }
}

/**
 * 数值字段容错读取（裁定）：非有限 number（脏数据/NaN/Infinity）按 0 处理并 console.warn；
 * 字段缺失（undefined）不算脏数据，静默按 0（区别于显式脏值）。
 * 负值防御（遗留 A2）：配额无负语义，脏数据负数（尤其 ADDON 增量求和处）
 * 会把 final 拉低甚至拉负（final = max(订阅) + Σ ADDON）——按 0 处理并 warn，
 * 与非法数值同型容错（订阅基数侧因 reduce 起点 0 + Math.max 本就不受负值影响）。
 */
function readNumber(value: unknown, field: string, source: string): number {
  if (value === undefined) return 0
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value < 0) {
      console.warn(
        `[entitlement-merge] 配额字段 ${field} 为负数（${source}），按 0 处理：${value}`,
      )
      return 0
    }
    return value
  }
  console.warn(
    `[entitlement-merge] 配额字段 ${field} 非法数值（${source}），按 0 处理：${String(value)}`,
  )
  return 0
}

/** 平台集合容错读取：非数组忽略；数组内非字符串项过滤 */
function readPlatforms(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

/** 抽出以 _ 开头的内部键（策略键），非下划线未知键按原裁定忽略 */
function pickInternalKeys(source: Record<string, unknown>): Record<string, unknown> {
  const picked: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(source)) {
    if (key.startsWith(INTERNAL_KEY_PREFIX)) picked[key] = value
  }
  return picked
}

/** 订阅在 now 时刻是否有效：status ACTIVE/GRACE 且 endAt > now（带周期加购随 endAt 失效） */
export function isEffectiveSubscription(sub: MergeSubscriptionInput, now: Date): boolean {
  return (sub.status === 'ACTIVE' || sub.status === 'GRACE') && sub.endAt > now
}

/**
 * 配额合并（规格 §6.4 逐字段）：
 * - 容量型：final = max(有效 SUBSCRIPTION 同字段) + Σ(有效 ADDON 同字段)；
 * - 集合型 allowedPlatforms：有效 SUBSCRIPTION 并集（ADDON 不扩平台集合——
 *   平台集合仅来自订阅，规格"集合型|有效订阅取并集"原文）；
 * - 无任何有效项 → 全 0 / 空集；SERVICE 类型不参与合并；
 * - entitlements 中的未知字段忽略（不合并、不报错）。
 */
export function mergeEntitlements(
  subs: readonly MergeSubscriptionInput[],
  now: Date,
): MergedEntitlements {
  const effective = subs.filter((sub) => isEffectiveSubscription(sub, now))
  const effectivePlans = effective.filter((sub) => sub.planKind === 'SUBSCRIPTION')
  const effectiveAddons = effective.filter((sub) => sub.planKind === 'ADDON')

  const merged = zeroEntitlements()
  for (const field of CAPACITY_FIELDS) {
    const base = effectivePlans.reduce(
      (max, sub) =>
        Math.max(max, readNumber(sub.entitlements[field], field, `订阅 ${sub.status} entitlements`)),
      0,
    )
    const addonSum = effectiveAddons.reduce(
      (sum, sub) => sum + readNumber(sub.entitlements[field], field, `加购 ${sub.status} entitlements`),
      0,
    )
    merged[field] = base + addonSum
  }

  const platforms = new Set<string>()
  for (const sub of effectivePlans) {
    for (const platform of readPlatforms(sub.entitlements.allowedPlatforms)) {
      platforms.add(platform)
    }
  }
  merged.allowedPlatforms = [...platforms].sort()

  // 可选容量键：存在性 + 与必填容量键同规则（订阅 max + ADDON 求和），
  // **无任何有效项声明则键不存在**（= 不限）
  for (const field of OPTIONAL_CAPACITY_FIELDS) {
    const base = effectivePlans.reduce((max, sub) => {
      if (sub.entitlements[field] === undefined) return max
      const value = readNumber(sub.entitlements[field], field, '订阅 entitlements')
      return max === undefined ? value : Math.max(max, value)
    }, undefined as number | undefined)
    const addonSum = effectiveAddons.reduce(
      (sum, sub) => sum + (sub.entitlements[field] === undefined
        ? 0
        : readNumber(sub.entitlements[field], field, '加购 entitlements')),
      0,
    )
    const addonDeclared = effectiveAddons.some((sub) => sub.entitlements[field] !== undefined)
    if (base !== undefined || addonDeclared) merged[field] = (base ?? 0) + addonSum
  }

  // 内部键原样透传：首个声明者胜出（策略键无可加性，取值与遍历顺序强相关，
  // 因此固定"先到先得"而非叠加，避免多订阅场景下 TTL 宽限天数值漂移）
  for (const sub of effective) {
    const internal = pickInternalKeys(sub.entitlements)
    for (const [key, value] of Object.entries(internal)) {
      if (!(key in merged)) merged[key as `_${string}`] = value
    }
  }

  return merged
}

/**
 * 存储值 → MergedEntitlements 的同规容错投影（getLimits 读 OrganizationEntitlement.limits）：
 * 脏数值按 0（warn），平台集合非数组忽略，未知字段丢弃。
 */
export function normalizeEntitlements(raw: unknown): MergedEntitlements {
  const merged = zeroEntitlements()
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return merged
  const record = raw as Record<string, unknown>
  for (const field of CAPACITY_FIELDS) {
    merged[field] = readNumber(record[field], field, 'OrganizationEntitlement.limits')
  }
  for (const field of OPTIONAL_CAPACITY_FIELDS) {
    if (record[field] === undefined) continue
    merged[field] = readNumber(record[field], field, 'OrganizationEntitlement.limits')
  }
  merged.allowedPlatforms = [...new Set(readPlatforms(record.allowedPlatforms))].sort()
  Object.assign(merged, pickInternalKeys(record))
  return merged
}

// ---------------------------------------------------------------------------
// Asia/Shanghai 自然月窗口：当月 1 日 00:00+08:00 ~ 次月 1 日 00:00+08:00。
// 以 Date（UTC 瞬间）存储：如 now=2026-10-15T02:00+08 →
// [2026-09-30T16:00:00.000Z, 2026-10-31T16:00:00.000Z]。
// ---------------------------------------------------------------------------

/** 上海固定时差（中国无夏令时，全年 +08:00） */
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000

export interface MonthlyWindow {
  periodStart: Date
  periodEnd: Date
}

/** now 所在的上海自然月窗口（periodStart 闭区间锚，periodEnd = 次月 1 日） */
export function shanghaiMonthWindow(now: Date): MonthlyWindow {
  // 上海墙上时刻 = UTC + 8h（无 DST，平移精确）；取其年月后构造该月/次月 1 日 00:00 上海时刻
  const shifted = new Date(now.getTime() + SHANGHAI_OFFSET_MS)
  const year = shifted.getUTCFullYear()
  const month = shifted.getUTCMonth()
  const periodStart = new Date(Date.UTC(year, month, 1) - SHANGHAI_OFFSET_MS)
  const periodEnd = new Date(Date.UTC(year, month + 1, 1) - SHANGHAI_OFFSET_MS)
  return { periodStart, periodEnd }
}
