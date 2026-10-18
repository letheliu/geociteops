import type { PrismaClient, CitationEvent } from '@prisma/client'
import type { AdapterRegistry } from './platform-adapters/registry.js'
import type { QueryLibraryService } from './query-library.js'
import { analyzeCitation, type Competitor } from './analyzer.js'
import { sanitizeMessage } from '../../core/lib/sanitize-message.js'
import { deriveRunStatus } from './aggregate.js'

/**
 * 监测编排：一次运行 = 一个 CitationRun = N 次采样（规格 §4/§6）。
 *
 * 失败隔离到采样行——单个平台挂起只让那一格变 FAILED，不拖垮整轮。
 * 幂等靠两把钥匙：slotKey（单 slot 单 Run）与 (runId, queryId, platform, sampleIndex) 唯一键（续跑补缺不重不漏）。
 */

/** 单次运行的采集总量上限；N 按 Q×P 反向钳制（规格 §6） */
export const MAX_RUN_UNITS = 400
/** N 的取值范围（规格 §4 Workspace.monitorSampleCount 1..10） */
export const MIN_SAMPLE_COUNT = 1
export const MAX_SAMPLE_COUNT = 10
/** run 内单个平台的并发（规格 §6） */
export const DEFAULT_PLATFORM_CONCURRENCY = 2
/** 采集 deadline 默认 30 分钟，env CITATION_RUN_DEADLINE_MS 可调 */
export const DEFAULT_RUN_DEADLINE_MS = 30 * 60 * 1000
/** 收尾时补齐的缺失采样标记 */
export const MISSING_SAMPLE = 'MISSING_SAMPLE'

/** slotKey 已被占用：同日同工作区已有 Run。调度层捕获它并按「跳过 / 原地续跑」处理 */
export class SlotConflictError extends Error {
  constructor(public readonly slotKey: string, public readonly existingRunId: string) {
    super(`CitationRun slot already taken: ${slotKey} (run ${existingRunId})`)
    this.name = 'SlotConflictError'
  }
}

export interface MonitorDeps {
  prisma: PrismaClient
  registry: AdapterRegistry
  queryLibrary: QueryLibraryService
  competitors: Array<string | Competitor>
  /** 兼容旧字段：未显式给 platformConcurrency 时用它 */
  concurrency?: number
  platformConcurrency?: number
  deadlineMs?: number
  maxRunUnits?: number
  now?: () => Date
  /** 解密 platformConfig（信封）；未注入时回退到库中原值（兼容旧数据/测试） */
  resolveConfig?: (workspaceId: string) => Promise<any>
}

export interface StartScheduledRunInput {
  workspaceId: string
  platforms: string[]
  /** `${workspaceId}:${YYYY-MM-DD Asia/Shanghai}`，由调度层算出 */
  slotKey: string
}

export interface StartManualRunInput {
  workspaceId: string
  platforms: string[]
  /** 可选：指定查询（校验归属 + ACTIVE）；缺省 = 全部 ACTIVE 查询 */
  queryIds?: string[]
  sampleCount?: number
}

export interface StartRunResult {
  runId: string | null
  /** 同 slot 已有非 FAILED Run → 跳过，不新建 */
  skipped: boolean
  /** 已有 FAILED Run 被原地续跑 */
  resumed: boolean
  status: 'RUNNING' | 'COMPLETED' | 'PARTIAL' | 'FAILED' | 'SKIPPED'
}

export interface RunOutcome {
  runId: string
  status: 'COMPLETED' | 'PARTIAL' | 'FAILED'
  completedUnits: number
  failedUnits: number
}

export interface Monitor {
  startScheduledRun(input: StartScheduledRunInput): Promise<StartRunResult>
  startManualRun(input: StartManualRunInput): Promise<StartRunResult>
  /**
   * 只建 Run 行并立刻返回（不等采样跑完）——`citation.runs.create` 用它拿到 runId 后
   * 把执行丢到后台，前端拿 runId 轮询 citation.runStatus（规格 §6 的异步语义）。
   */
  createManualRun(input: StartManualRunInput): Promise<StartRunResult>
  /** 执行一个 RUNNING 态 Run 的全部缺失采样并收尾 */
  executeRunById(runId: string): Promise<RunOutcome | null>
  resumeRun(runId: string): Promise<RunOutcome | null>
  /** 薄封装：跑一轮并回传产生的采样行（兼容旧调用与测试） */
  runOnce(input: { workspaceId: string; platforms: string[] }): Promise<CitationEvent[]>
}

/** querySnapshot 的结构：建 Run 时的查询锚点，续跑与缺样检测都以它为准 */
interface QuerySnapshotItem {
  id: string
  text: string
}

function sampleKey(queryId: string, platform: string, sampleIndex: number): string {
  return `${queryId}::${platform}::${sampleIndex}`
}

function parseSnapshot(raw: unknown): QuerySnapshotItem[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((item: any) => (typeof item === 'object' && item ? { id: String(item.id), text: String(item.text ?? '') } : null))
    .filter((item: QuerySnapshotItem | null): item is QuerySnapshotItem => item !== null && item.id !== 'undefined')
}

/** Prisma 唯一约束冲突（含测试里手写的同构错误） */
function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; message?: string }
  return e?.code === 'P2002' || /unique|duplicate key/i.test(e?.message ?? '')
}

function clampSampleCount(n: number): number {
  if (!Number.isFinite(n)) return MIN_SAMPLE_COUNT
  return Math.min(MAX_SAMPLE_COUNT, Math.max(MIN_SAMPLE_COUNT, Math.trunc(n)))
}

function resolveDeadlineMs(deps: MonitorDeps): number {
  if (deps.deadlineMs !== undefined) return deps.deadlineMs
  const env = process.env.CITATION_RUN_DEADLINE_MS
  const parsed = env ? Number(env) : NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_RUN_DEADLINE_MS
}

/** 简单并发池：per-platform 信号量的实现（规格 §6） */
async function runPool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  const size = Math.max(1, limit)
  let cursor = 0
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++]
      await worker(item)
    }
  })
  await Promise.all(workers)
}

export function createMonitor(deps: MonitorDeps): Monitor {
  const now = deps.now ?? (() => new Date())
  const deadlineMs = resolveDeadlineMs(deps)
  const platformConcurrency = deps.platformConcurrency ?? deps.concurrency ?? DEFAULT_PLATFORM_CONCURRENCY
  const maxRunUnits = deps.maxRunUnits ?? MAX_RUN_UNITS

  async function loadConfig(workspaceId: string) {
    const workspace = await deps.prisma.workspace.findUnique({ where: { id: workspaceId } })
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)
    const cfg = deps.resolveConfig ? await deps.resolveConfig(workspaceId) : (workspace.platformConfig as any) || {}
    const workspaceCompetitors: Array<string | Competitor> = Array.isArray(cfg.competitors) ? cfg.competitors : []
    return {
      workspace,
      cfg,
      competitors: [...new Set([...deps.competitors, ...workspaceCompetitors])],
    }
  }

  /**
   * 有效 N = min(请求 N, floor(unitCap / (Q×P)))，下限 1。
   * 钳制不静默：Run.sampleCount 记钳制后值，failureReason 记 `N clamped 10→5: unit cap 400`。
   */
  function effectiveSampleCount(requested: number, queryCount: number, platformCount: number): { n: number; clampedFrom: number | null } {
    const wanted = clampSampleCount(requested)
    const cap = Math.floor(maxRunUnits / Math.max(1, queryCount * platformCount))
    const n = Math.max(MIN_SAMPLE_COUNT, Math.min(wanted, cap))
    return { n, clampedFrom: n === wanted ? null : wanted }
  }

  function clampFailureReason(from: number, to: number): string {
    return `N clamped ${from}→${to}: unit cap ${maxRunUnits}`
  }

  /** 采样落行：唯一键 upsert——at-least-once 重试不会重写已有样本 */
  async function upsertSample(input: {
    runId: string
    workspaceId: string
    queryId: string
    platform: string
    sampleIndex: number
    data: Record<string, unknown>
  }) {
    const key = {
      runId_queryId_platform_sampleIndex: {
        runId: input.runId,
        queryId: input.queryId,
        platform: input.platform,
        sampleIndex: input.sampleIndex,
      },
    }
    const payload = {
      workspaceId: input.workspaceId,
      queryId: input.queryId,
      platform: input.platform,
      sampleIndex: input.sampleIndex,
      ...input.data,
    }
    // 载荷由 analyzer 结果动态拼装（analysis/citations 等 JSON 列），无法静态满足 Prisma 输入类型，
    // 与仓库内既有的 JSON 列写法一致，这里显式 cast
    return deps.prisma.citationEvent.upsert({
      where: key,
      create: { ...payload, runId: input.runId } as any,
      update: payload as any,
    })
  }

  /** 执行一个 RUNNING 态 Run 的全部缺失采样，然后收尾 */
  async function executeRun(runId: string): Promise<RunOutcome | null> {
    const run = await deps.prisma.citationRun.findUnique({ where: { id: runId } })
    if (!run) return null
    // 终态不重复执行（at-least-once 投递的幂等保证）
    if (run.status !== 'RUNNING') return null

    const { workspace, cfg, competitors } = await loadConfig(run.workspaceId)
    const platforms = Array.isArray(run.platforms) ? (run.platforms as string[]) : []
    const snapshot = parseSnapshot(run.querySnapshot)
    const N = run.sampleCount
    const deadlineAt = new Date(run.startedAt.getTime() + deadlineMs)

    // 已经落过的采样直接跳过——续跑只补缺
    const existing = await deps.prisma.citationEvent.findMany({
      where: { runId },
      select: { queryId: true, platform: true, sampleIndex: true },
    })
    const present = new Set(existing.map((e) => sampleKey(e.queryId, e.platform, e.sampleIndex)))

    let timedOut = false
    // 用 >= 而非 >：恰好落在 deadline 上的那一刻即视为超期，否则同一毫秒内仍会漏发一个采样
    const pastDeadline = () => now().getTime() >= deadlineAt.getTime()

    for (const platform of platforms) {
      const adapter = deps.registry.get(platform)
      const credentials = cfg?.[platform] || {}

      const pending: Array<{ query: QuerySnapshotItem; sampleIndex: number }> = []
      for (const query of snapshot) {
        for (let s = 1; s <= N; s++) {
          if (present.has(sampleKey(query.id, platform, s))) continue
          pending.push({ query, sampleIndex: s })
        }
      }

      await runPool(pending, platformConcurrency, async ({ query, sampleIndex }) => {
        // deadline 在采样间隙检查：超时后不再发起新采样，已有样本保留
        if (pastDeadline()) {
          timedOut = true
          return
        }
        const base = { runId, workspaceId: run.workspaceId, queryId: query.id, platform, sampleIndex }

        if (!adapter) {
          await upsertSample({
            ...base,
            data: failedSampleData(sanitizeMessage(`adapter not registered: ${platform}`)),
          })
          return
        }

        try {
          const platformResult = await adapter.query(query.text, credentials)
          const brandDomains = [workspace.domain].filter(Boolean) as string[]
          const analysis = analyzeCitation({
            platformResult,
            brand: workspace.defaultBrandName,
            brandDomains,
            competitors,
          })
          await upsertSample({
            ...base,
            data: {
              brandMentioned: analysis.brandMentioned,
              brandSourceCited: analysis.brandSourceCited,
              rankInAnswer: analysis.rankInAnswer,
              sourceRank: analysis.sourceRank,
              citedUrls: platformResult.sourceCitations as any,
              sourceCitations: platformResult.sourceCitations as any,
              groundingSources: platformResult.groundingSources as any,
              analysis: analysis as any,
              competitors: analysis.competitors as any,
              rawAnswer: platformResult.answer,
              sovScore: analysis.sovScore,
              status: 'OK',
              failureReason: null,
            },
          })
        } catch (err) {
          // 失败隔离到这一格：脱敏后落 FAILED 行，不中断整轮
          const reason = sanitizeMessage(err)
          await upsertSample({ ...base, data: failedSampleData(reason) })
        }
      })
    }

    return finalizeRun(runId, timedOut)
  }

  /** FAILED 采样行的占位值（规格 §4/D2）——"未提及"与"失败"只靠 status 区分 */
  function failedSampleData(reason: string): Record<string, unknown> {
    return {
      brandMentioned: false,
      brandSourceCited: false,
      rankInAnswer: null,
      sourceRank: null,
      citedUrls: [],
      sourceCitations: [],
      groundingSources: [],
      competitors: [],
      rawAnswer: '',
      sovScore: null,
      status: 'FAILED',
      // 错误对象整体经脱敏，避免平台原文里的凭证落库
      analysis: { error: reason },
      failureReason: reason,
    }
  }

  /**
   * 收尾：补缺失采样 → 算终态 → 幂等更新 → 刷 lastRunAt。
   * 缺失采样以 querySnapshot 为锚（崩溃 / 查询中途被删都能补上）。
   */
  async function finalizeRun(runId: string, timedOut = false): Promise<RunOutcome | null> {
    const run = await deps.prisma.citationRun.findUnique({ where: { id: runId } })
    if (!run) return null
    if (run.status !== 'RUNNING') return null // 重复收尾无副作用

    const platforms = Array.isArray(run.platforms) ? (run.platforms as string[]) : []
    const snapshot = parseSnapshot(run.querySnapshot)
    const N = run.sampleCount

    const rows = await deps.prisma.citationEvent.findMany({
      where: { runId },
      select: { queryId: true, platform: true, sampleIndex: true, status: true },
    })
    const present = new Set(rows.map((e) => sampleKey(e.queryId, e.platform, e.sampleIndex)))

    for (const query of snapshot) {
      for (const platform of platforms) {
        for (let s = 1; s <= N; s++) {
          if (present.has(sampleKey(query.id, platform, s))) continue
          await upsertSample({
            runId,
            workspaceId: run.workspaceId,
            queryId: query.id,
            platform,
            sampleIndex: s,
            data: failedSampleData(MISSING_SAMPLE),
          })
        }
      }
    }

    const finalRows = await deps.prisma.citationEvent.findMany({
      where: { runId },
      select: { status: true },
    })
    const completedUnits = finalRows.filter((e) => e.status === 'OK').length
    const failedUnits = finalRows.filter((e) => e.status === 'FAILED').length
    const status = deriveRunStatus(completedUnits, failedUnits) as 'COMPLETED' | 'PARTIAL' | 'FAILED'

    // 钳制说明不能被超时说明覆盖，拼接保留
    const priorReason = typeof run.failureReason === 'string' && run.failureReason ? run.failureReason : null
    const reasons = [priorReason, timedOut ? 'deadline exceeded' : null].filter(Boolean) as string[]
    const failureReason = reasons.length > 0 ? reasons.join(' | ') : null

    // 幂等终态：只有仍在 RUNNING 才改（参考诊断 finalizer）
    await deps.prisma.citationRun.updateMany({
      where: { id: runId, status: 'RUNNING' },
      data: {
        status,
        completedUnits,
        failedUnits,
        failureReason,
        finishedAt: now(),
        updatedAt: now(),
      },
    })

    // 参与查询以 querySnapshot 为锚刷新（查询中途被删时静默跳过）
    if (snapshot.length > 0) {
      await deps.prisma.citationQuery.updateMany({
        where: { id: { in: snapshot.map((q) => q.id) } },
        data: { lastRunAt: now() },
      })
    }

    return { runId, status, completedUnits, failedUnits }
  }

  /** 建 Run 行；slotKey 冲突时按「FAILED 续跑 / 其他跳过」处理 */
  async function createRun(input: {
    workspaceId: string
    trigger: 'SCHEDULED' | 'MANUAL'
    platforms: string[]
    snapshot: QuerySnapshotItem[]
    sampleCount: number
    clampedFrom: number | null
    slotKey?: string | null
  }): Promise<StartRunResult> {
    const plannedUnits = input.sampleCount * input.snapshot.length * input.platforms.length
    const failureReason = input.clampedFrom !== null ? clampFailureReason(input.clampedFrom, input.sampleCount) : null

    try {
      const run = await deps.prisma.citationRun.create({
        data: {
          workspaceId: input.workspaceId,
          trigger: input.trigger,
          sampleCount: input.sampleCount,
          platforms: input.platforms as any,
          querySnapshot: input.snapshot.map((q) => ({ id: q.id, text: q.text })) as any,
          plannedUnits,
          status: 'RUNNING',
          failureReason,
          slotKey: input.slotKey ?? null,
        },
      })
      return { runId: run.id, skipped: false, resumed: false, status: 'RUNNING' }
    } catch (err) {
      if (!input.slotKey || !isUniqueViolation(err)) throw err
      const existing = await deps.prisma.citationRun.findUnique({ where: { slotKey: input.slotKey } })
      if (!existing) throw err
      // 冲突却查不到已有 Run → 不是幂等冲突，是真异常，抛回去
      if (existing.status === 'FAILED') {
        // 同日重触发 = 原地续跑：置 RUNNING，按唯一键补缺失采样，不新建 Run
        await deps.prisma.citationRun.updateMany({
          where: { id: existing.id, status: 'FAILED' },
          data: { status: 'RUNNING', failureReason: existing.failureReason, finishedAt: null, updatedAt: now() },
        })
        return { runId: existing.id, skipped: false, resumed: true, status: 'RUNNING' }
      }
      return { runId: existing.id, skipped: true, resumed: false, status: existing.status as StartRunResult['status'] }
    }
  }

  // 显式标注类型：否则对象字面量会把 status 推断成宽泛的 string，与接口对不上
  const api: Monitor = {
    async startScheduledRun(input) {
      const { workspace } = await loadConfig(input.workspaceId)
      const queries = await deps.prisma.citationQuery.findMany({
        where: { workspaceId: input.workspaceId, status: 'ACTIVE', scheduled: true },
        orderBy: { priority: 'asc' },
      })
      // 0 查询或 0 平台直接跳过，不建 Run（规格 §6）
      if (queries.length === 0 || input.platforms.length === 0) {
        return { runId: null, skipped: true, resumed: false, status: 'SKIPPED' }
      }

      const { n, clampedFrom } = effectiveSampleCount(workspace.monitorSampleCount, queries.length, input.platforms.length)
      const created = await createRun({
        workspaceId: input.workspaceId,
        trigger: 'SCHEDULED',
        platforms: input.platforms,
        snapshot: queries.map((q) => ({ id: q.id, text: q.queryText })),
        sampleCount: n,
        clampedFrom,
        slotKey: input.slotKey,
      })
      if (created.skipped || created.runId === null) return created

      const outcome = await executeRun(created.runId)
      return {
        runId: created.runId,
        skipped: false,
        resumed: created.resumed,
        status: outcome?.status ?? 'RUNNING',
      }
    },

    async createManualRun(input) {
      await loadConfig(input.workspaceId)
      let queries
      let defaultN = MIN_SAMPLE_COUNT
      if (input.queryIds && input.queryIds.length > 0) {
        // 校验归属 + ACTIVE：跨工作区或 PAUSED 一律拒绝，不静默丢弃
        const found = await deps.prisma.citationQuery.findMany({
          where: { id: { in: input.queryIds }, workspaceId: input.workspaceId },
        })
        if (found.length !== input.queryIds.length) {
          throw new Error('queryIds 含不存在或不属于当前工作区的查询')
        }
        const notActive = found.filter((q) => q.status !== 'ACTIVE')
        if (notActive.length > 0) {
          throw new Error('queryIds 含非 ACTIVE 查询（PAUSED 不参与任何运行）')
        }
        queries = found
      } else {
        queries = await deps.prisma.citationQuery.findMany({
          where: { workspaceId: input.workspaceId, status: 'ACTIVE' },
          orderBy: { priority: 'asc' },
        })
        // 未指定 N 时取工作区配置
        const ws = await deps.prisma.workspace.findUnique({ where: { id: input.workspaceId } })
        defaultN = ws?.monitorSampleCount ?? MIN_SAMPLE_COUNT
      }
      if (queries.length === 0 || input.platforms.length === 0) {
        return { runId: null, skipped: true, resumed: false, status: 'SKIPPED' }
      }

      const { n, clampedFrom } = effectiveSampleCount(input.sampleCount ?? defaultN, queries.length, input.platforms.length)
      return createRun({
        workspaceId: input.workspaceId,
        trigger: 'MANUAL',
        platforms: input.platforms,
        snapshot: queries.map((q) => ({ id: q.id, text: q.queryText })),
        sampleCount: n,
        clampedFrom,
        slotKey: null, // MANUAL 不占 slot，同一天可以跑多次
      })
    },

    async executeRunById(runId) {
      return executeRun(runId)
    },

    async startManualRun(input) {
      const created = await api.createManualRun(input)
      if (created.runId === null) return created
      const outcome = await executeRun(created.runId)
      return {
        runId: created.runId,
        skipped: false,
        resumed: false,
        status: outcome?.status ?? 'RUNNING',
      }
    },

    async resumeRun(runId) {
      const run = await deps.prisma.citationRun.findUnique({ where: { id: runId } })
      if (!run) return null
      if (run.status !== 'FAILED') return null // 只有 FAILED 才值得续跑
      await deps.prisma.citationRun.updateMany({
        where: { id: runId, status: 'FAILED' },
        data: { status: 'RUNNING', finishedAt: null, updatedAt: now() },
      })
      return executeRun(runId)
    },

    /** 薄封装：跑一轮并回传本次 Run 的 OK 采样行（兼容旧调用与测试） */
    async runOnce(input) {
      // 走 api 而不是 this：方法被解构调用时 this 会丢
      const result = await api.startManualRun({ workspaceId: input.workspaceId, platforms: input.platforms })
      if (result.runId === null) return []
      return deps.prisma.citationEvent.findMany({
        where: { runId: result.runId, status: 'OK' },
        orderBy: { capturedAt: 'asc' },
      })
    },
  }

  return api
}
