import type { PrismaClient } from '@prisma/client'
import { dayStart, okEventsWhere } from './aggregate.js'

/**
 * 引用覆盖(可引用性覆盖矩阵)——见 docs/specs/引用覆盖-设计.md。
 *
 * 归因证据分层(沿 analyzer.ts 品牌 exact/fuzzy/domain 分层思想推广到页面):
 * - EXACT:citedUrl 与 page.url 逐字节相等
 * - NORMALIZED:协议/host 大小写/www/尾斜杠/fragment 不敏感,路径与查询串敏感
 * - DOMAIN:仅 host 一致——域级证据,**不计入页面覆盖**,仅单独披露
 *
 * 口径钉死(与 docs/METRICS.md 同源):
 * - 页面全集 = PUBLISHED;被引 ⟺ 窗口内存在 EXACT|NORMALIZED 证据
 * - 事件窗口 = OK 事件 capturedAt ∈ [dayStart(fromDay), dayStart(toDay)+24h)(Asia/Shanghai)
 * - 平台列 = 窗口内事件出现过的 platform;无事件的平台不渲染(证据不存在 ≠ 覆盖为零)
 */

/** 归因证据档位 */
export type AttributionTier = 'EXACT' | 'NORMALIZED' | 'DOMAIN'

const TIER_RANK: Record<AttributionTier, number> = { DOMAIN: 1, NORMALIZED: 2, EXACT: 3 }

export type CoverageDb = Pick<PrismaClient, 'contentPage' | 'citationEvent' | 'citationQuery'>

export interface CoverageInput {
  workspaceId: string
  fromDay: string
  toDay: string
}

export interface PlatformCell {
  /** T1/T2(EXACT|NORMALIZED)被引次数 */
  cites: number
  /** 窗口内最高证据档;DOMAIN 表示仅域级证据(不计入覆盖) */
  tier: AttributionTier
  lastCitedAt: string
}

export interface CoverageRow {
  pageId: string
  url: string
  citabilityScore: number | null
  /** 平台 → 单元格;无任何证据(含 DOMAIN)的平台无键 */
  perPlatform: Record<string, PlatformCell>
  totalCites: number
  coveredPlatforms: number
  /** 窗口内 T1/T2 计数为 0 → 盲区页 */
  blindSpot: boolean
  /** 只有 DOMAIN 证据、从未 T1/T2 被引 */
  domainOnly: boolean
}

export interface IntentRow {
  queryId: string
  queryText: string
  mappedPageUrl: string
  /** 映射页在窗口内被本查询事件引用的 T1/T2 次数 */
  cites: number
  lastCitedAt: string | null
  /** cites === 0 → 意图落空(目标页从未被引) */
  miss: boolean
}

export interface CoverageResult {
  platforms: string[]
  rows: CoverageRow[]
  summary: {
    totalPages: number
    coveredPages: number
    coverageRate: number | null
    blindSpotCount: number
    domainOnlyCount: number
    perPlatform: Record<string, { covered: number; total: number; rate: number | null }>
    eventsScanned: number
    /** citedUrls 里非字符串条目数——守门计数,不参与任何分子 */
    unparsedCitedUrls: number
    windowDays: number
  }
  intentRows: IntentRow[]
}

/**
 * URL 规范化(NORMALIZED 档):协议忽略、host 小写、去 www.、去尾斜杠(根 / 保留)、
 * 去 fragment;路径与查询串原样保留(utm 变体保守不视为同页,见 METRICS 限制节)。
 * 不可解析返回 null。
 */
export function normalizeUrl(raw: string): string | null {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`
  try {
    const u = new URL(withScheme)
    let host = u.host.toLowerCase()
    if (host.startsWith('www.')) host = host.slice(4)
    let path = u.pathname
    if (path.length > 1 && path.endsWith('/')) path = path.replace(/\/+$/, '') || '/'
    return host + path + u.search
  } catch {
    return null
  }
}

/** 仅取 host(小写、去 www.);不可解析返回 null */
export function hostOf(raw: string): string | null {
  const norm = normalizeUrl(raw)
  return norm === null ? null : norm.split('/')[0]
}

/** 三档归因:EXACT > NORMALIZED > DOMAIN;null = 无任何证据 */
export function attribute(
  cited: string,
  page: { url: string; norm: string | null; host: string | null },
): AttributionTier | null {
  if (cited === page.url) return 'EXACT'
  if (page.norm !== null && normalizeUrl(cited) === page.norm) return 'NORMALIZED'
  if (page.host !== null && hostOf(cited) === page.host) return 'DOMAIN'
  return null
}

interface PageIndex {
  id: string
  url: string
  citabilityScore: number | null
  norm: string | null
  host: string | null
  /** platform → (platform, cell) */
  cells: Map<string, PlatformCell>
  totalCites: number
}

export async function loadCoverage(db: CoverageDb, input: CoverageInput): Promise<CoverageResult> {
  const { workspaceId, fromDay, toDay } = input
  const from = dayStart(fromDay)
  const toExclusive = new Date(dayStart(toDay).getTime() + 24 * 60 * 60 * 1000)

  const [pages, events, queries] = await Promise.all([
    db.contentPage.findMany({
      where: { workspaceId, status: 'PUBLISHED' },
      select: { id: true, url: true, citabilityScore: true },
      orderBy: { url: 'asc' },
    }),
    db.citationEvent.findMany({
      where: { workspaceId, ...okEventsWhere(), capturedAt: { gte: from, lt: toExclusive } },
      select: { platform: true, queryId: true, citedUrls: true, capturedAt: true },
      orderBy: { capturedAt: 'asc' },
    }),
    db.citationQuery.findMany({
      where: { workspaceId, status: 'ACTIVE', mappedPageUrl: { not: null } },
      select: { id: true, queryText: true, mappedPageUrl: true },
      orderBy: { queryText: 'asc' },
    }),
  ])

  const index = new Map<string, PageIndex>()
  const byExact = new Map<string, PageIndex[]>()
  const byNorm = new Map<string, PageIndex[]>()
  const byHost = new Map<string, PageIndex[]>()
  for (const p of pages) {
    const norm = normalizeUrl(p.url)
    const host = norm === null ? null : norm.split('/')[0]
    const entry: PageIndex = { id: p.id, url: p.url, citabilityScore: p.citabilityScore, norm, host, cells: new Map(), totalCites: 0 }
    index.set(p.id, entry)
    const push = (m: Map<string, PageIndex[]>, k: string) => {
      const list = m.get(k) ?? []
      list.push(entry)
      m.set(k, list)
    }
    push(byExact, p.url)
    if (norm !== null) push(byNorm, norm)
    if (host !== null) push(byHost, host)
  }

  const platforms = new Set<string>()
  const bump = (page: PageIndex, platform: string, tier: AttributionTier, at: Date) => {
    let cell = page.cells.get(platform)
    if (cell === undefined) {
      cell = { cites: 0, tier: 'DOMAIN', lastCitedAt: at.toISOString() }
      page.cells.set(platform, cell)
    }
    if (at.toISOString() > cell.lastCitedAt) cell.lastCitedAt = at.toISOString()
    if (TIER_RANK[tier] > TIER_RANK[cell.tier]) cell.tier = tier
    if (tier !== 'DOMAIN') {
      cell.cites += 1
      page.totalCites += 1
    }
  }

  /** 意图计数:queryId → [cites, lastCitedAt] */
  const intentCounts = new Map<string, { cites: number; lastCitedAt: string | null }>()

  let unparsedCitedUrls = 0
  for (const ev of events) {
    platforms.add(ev.platform)
    const citedUrls = Array.isArray(ev.citedUrls) ? (ev.citedUrls as unknown[]) : []

    // 意图命中判定要"本查询"的口径,先算
    const query = queries.find((q) => q.id === ev.queryId)
    const mappedNorm = query ? normalizeUrl(query.mappedPageUrl ?? '') : null
    let mappedHit = false

    for (const c of citedUrls) {
      if (typeof c !== 'string' || c.length === 0) {
        unparsedCitedUrls += 1
        continue
      }
      const citedNorm = normalizeUrl(c)
      const citedHost = citedNorm === null ? null : citedNorm.split('/')[0]
      const hits = new Set<PageIndex>([
        ...(byExact.get(c) ?? []),
        ...(citedNorm !== null ? (byNorm.get(citedNorm) ?? []) : []),
        ...(citedHost !== null ? (byHost.get(citedHost) ?? []) : []),
      ])
      for (const page of hits) {
        const tier = attribute(c, page)
        if (tier !== null) bump(page, ev.platform, tier, ev.capturedAt)
      }
      if (query !== undefined && mappedNorm !== null && (c === query.mappedPageUrl || citedNorm === mappedNorm)) {
        mappedHit = true
      }
    }

    if (query !== undefined && mappedHit) {
      const agg = intentCounts.get(query.id) ?? { cites: 0, lastCitedAt: null }
      agg.cites += 1
      const at = ev.capturedAt.toISOString()
      if (agg.lastCitedAt === null || at > agg.lastCitedAt) agg.lastCitedAt = at
      intentCounts.set(query.id, agg)
    }
  }

  const rows: CoverageRow[] = [...index.values()].map((page) => {
    const perPlatform: Record<string, PlatformCell> = {}
    for (const [platform, cell] of page.cells) perPlatform[platform] = { cites: cell.cites, tier: cell.tier, lastCitedAt: cell.lastCitedAt }
    const coveredPlatforms = [...page.cells.values()].filter((c) => c.cites > 0).length
    const hasDomainEvidence = page.cells.size > 0
    return {
      pageId: page.id,
      url: page.url,
      citabilityScore: page.citabilityScore,
      perPlatform,
      totalCites: page.totalCites,
      coveredPlatforms,
      blindSpot: page.totalCites === 0,
      domainOnly: page.totalCites === 0 && hasDomainEvidence,
    }
  })

  const platformsList = [...platforms].sort()
  const totalPages = rows.length
  const coveredPages = rows.filter((r) => !r.blindSpot).length
  const perPlatform: Record<string, { covered: number; total: number; rate: number | null }> = {}
  for (const p of platformsList) {
    const covered = rows.filter((r) => (r.perPlatform[p]?.cites ?? 0) > 0).length
    perPlatform[p] = { covered, total: totalPages, rate: totalPages === 0 ? null : covered / totalPages }
  }

  const windowDays = Math.round((toExclusive.getTime() - from.getTime()) / (24 * 60 * 60 * 1000))

  return {
    platforms: platformsList,
    rows,
    summary: {
      totalPages,
      coveredPages,
      coverageRate: totalPages === 0 ? null : coveredPages / totalPages,
      blindSpotCount: rows.filter((r) => r.blindSpot).length,
      domainOnlyCount: rows.filter((r) => r.domainOnly).length,
      perPlatform,
      eventsScanned: events.length,
      unparsedCitedUrls,
      windowDays,
    },
    intentRows: queries.map((q) => {
      const agg = intentCounts.get(q.id)
      return {
        queryId: q.id,
        queryText: q.queryText,
        mappedPageUrl: q.mappedPageUrl ?? '',
        cites: agg?.cites ?? 0,
        lastCitedAt: agg?.lastCitedAt ?? null,
        miss: (agg?.cites ?? 0) === 0,
      }
    }),
  }
}
