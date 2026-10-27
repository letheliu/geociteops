import { describe, it, expect, vi } from 'vitest'
import { loadCoverage, normalizeUrl, hostOf, attribute } from './coverage.js'

describe('normalizeUrl / hostOf', () => {
  it('协议、www、host 大小写、尾斜杠、fragment 不敏感', () => {
    expect(normalizeUrl('https://WWW.Example.com/A/')).toBe('example.com/A')
    expect(normalizeUrl('http://example.com/a#frag')).toBe('example.com/a')
    expect(normalizeUrl('example.com/a')).toBe('example.com/a')
    expect(normalizeUrl('https://example.com')).toBe('example.com/')
  })

  it('路径与查询串敏感(utm 变体不视为同页)', () => {
    expect(normalizeUrl('https://example.com/a?x=1')).toBe('example.com/a?x=1')
    expect(normalizeUrl('https://example.com/a')).not.toBe(normalizeUrl('https://example.com/a?x=1'))
  })

  it('不可解析返回 null', () => {
    expect(normalizeUrl('http://')).toBeNull()
    expect(hostOf('http://')).toBeNull()
  })

  it('hostOf 去www小写', () => {
    expect(hostOf('https://WWW.Example.com/a/b?x=1')).toBe('example.com')
  })
})

describe('attribute 三档归因', () => {
  const page = { url: 'https://example.com/a', norm: normalizeUrl('https://example.com/a'), host: 'example.com' }

  it('EXACT 逐字节相等', () => {
    expect(attribute('https://example.com/a', page)).toBe('EXACT')
  })

  it('NORMALIZED 规范化相等(尾斜杠/协议变体)', () => {
    expect(attribute('http://example.com/a/', page)).toBe('NORMALIZED')
  })

  it('DOMAIN 仅 host 一致', () => {
    expect(attribute('https://example.com/other', page)).toBe('DOMAIN')
  })

  it('无证据 null', () => {
    expect(attribute('https://other.com/a', page)).toBeNull()
  })
})

const day = (d: string) => new Date(`${d}T12:00:00+08:00`)

function makeDb(seed: { pages?: any[]; events?: any[]; queries?: any[] }) {
  return {
    contentPage: {
      findMany: vi.fn(async ({ where }: any) =>
        (seed.pages ?? []).filter((p) => p.workspaceId === where.workspaceId && p.status === where.status),
      ),
    },
    citationEvent: {
      findMany: vi.fn(async ({ where }: any) =>
        (seed.events ?? [])
          .filter((e) => e.workspaceId === where.workspaceId)
          .filter((e) => (where.status ? e.status === where.status : true))
          .filter((e) => e.capturedAt >= where.capturedAt.gte && e.capturedAt < where.capturedAt.lt),
      ),
    },
    citationQuery: {
      findMany: vi.fn(async ({ where }: any) =>
        (seed.queries ?? [])
          .filter((q) => q.workspaceId === where.workspaceId && q.status === where.status)
          .filter((q) => (where.mappedPageUrl?.not === null ? q.mappedPageUrl !== null : true)),
      ),
    },
  } as any
}

describe('loadCoverage', () => {
  const WS = 'ws-1'
  const base = {
    pages: [
      { id: 'p1', workspaceId: WS, url: 'https://ex.com/p1', citabilityScore: 0.8, status: 'PUBLISHED' },
      { id: 'p2', workspaceId: WS, url: 'https://ex.com/p2', citabilityScore: 0.6, status: 'PUBLISHED' },
      { id: 'p3', workspaceId: WS, url: 'https://ex.com/p3', citabilityScore: null, status: 'PUBLISHED' },
      { id: 'p4', workspaceId: WS, url: 'https://ex.com/p4', citabilityScore: 0.9, status: 'PUBLISHED' },
      // DRAFT 不进全集
      { id: 'p5', workspaceId: WS, url: 'https://ex.com/p5', citabilityScore: 1, status: 'DRAFT' },
    ],
    events: [
      // EXACT:p1 @ doubao
      { id: 'e1', workspaceId: WS, queryId: 'q1', platform: 'doubao', status: 'OK', capturedAt: day('2026-10-10'), citedUrls: ['https://ex.com/p1', 42] },
      // NORMALIZED:p2 @ openai(协议+www+尾斜杠变体)
      { id: 'e2', workspaceId: WS, queryId: 'q1', platform: 'openai', status: 'OK', capturedAt: day('2026-10-11'), citedUrls: ['http://WWW.ex.com/p2/'] },
      // DOMAIN:p3 @ qwen(同域不同路径)——不算覆盖
      { id: 'e3', workspaceId: WS, queryId: 'q2', platform: 'qwen', status: 'OK', capturedAt: day('2026-10-12'), citedUrls: ['https://ex.com/other-path'] },
      // FAILED 事件不进窗口(platform gemini 不该出现)
      { id: 'e4', workspaceId: WS, queryId: 'q1', platform: 'gemini', status: 'FAILED', capturedAt: day('2026-10-12'), citedUrls: ['https://ex.com/p1'] },
      // 窗口外事件不计
      { id: 'e5', workspaceId: WS, queryId: 'q1', platform: 'doubao', status: 'OK', capturedAt: day('2026-11-01'), citedUrls: ['https://ex.com/p4'] },
    ],
    queries: [
      { id: 'q1', workspaceId: WS, queryText: '品牌词', mappedPageUrl: 'https://ex.com/p1', status: 'ACTIVE' },
      { id: 'q2', workspaceId: WS, queryText: '品类词', mappedPageUrl: 'https://ex.com/p4', status: 'ACTIVE' },
      // 无映射查询不进意图清单
      { id: 'q3', workspaceId: WS, queryText: '裸查询', mappedPageUrl: null, status: 'ACTIVE' },
    ],
  }

  it('矩阵/汇总口径:EXACT+NORMALIZED 计覆盖,DOMAIN 不计,DRAFT 不进全集,FAILED/窗外事件不计', async () => {
    const result = await loadCoverage(makeDb(base), { workspaceId: WS, fromDay: '2026-10-01', toDay: '2026-10-31' })

    expect(result.platforms).toEqual(['doubao', 'openai', 'qwen'])
    expect(result.summary.totalPages).toBe(4)
    expect(result.summary.coveredPages).toBe(2)
    expect(result.summary.coverageRate).toBeCloseTo(0.5)
    expect(result.summary.blindSpotCount).toBe(2)
    // p3 与 p4:域被引(同域任何引用都构成域级证据)但从未定位到本页
    expect(result.summary.domainOnlyCount).toBe(2)
    expect(result.summary.eventsScanned).toBe(3)
    expect(result.summary.unparsedCitedUrls).toBe(1)

    const byId = new Map(result.rows.map((r) => [r.pageId, r]))
    expect(byId.get('p1')!.perPlatform.doubao).toMatchObject({ cites: 1, tier: 'EXACT' })
    expect(byId.get('p1')!.blindSpot).toBe(false)
    expect(byId.get('p2')!.perPlatform.openai).toMatchObject({ cites: 1, tier: 'NORMALIZED' })
    // 域级证据:qwen 列有 DOMAIN 单元格但 cites=0 → 盲区 + domainOnly
    expect(byId.get('p3')!.perPlatform.qwen).toMatchObject({ cites: 0, tier: 'DOMAIN' })
    expect(byId.get('p3')!.blindSpot).toBe(true)
    expect(byId.get('p3')!.domainOnly).toBe(true)
    // p4 窗外被引不算 T1/T2,但同域引用构成域级证据 → 纯 domainOnly 盲区
    expect(byId.get('p4')!.perPlatform.doubao).toMatchObject({ cites: 0, tier: 'DOMAIN' })
    expect(byId.get('p4')!.totalCites).toBe(0)
    expect(byId.get('p4')!.domainOnly).toBe(true)

    expect(result.summary.perPlatform.qwen).toMatchObject({ covered: 0, total: 4, rate: 0 })
    expect(result.summary.perPlatform.doubao).toMatchObject({ covered: 1, total: 4 })
  })

  it('意图清单:命中不计 miss;映射页从未被引 → miss', async () => {
    const result = await loadCoverage(makeDb(base), { workspaceId: WS, fromDay: '2026-10-01', toDay: '2026-10-31' })
    const byQuery = new Map(result.intentRows.map((r) => [r.queryId, r]))

    expect(byQuery.has('q3')).toBe(false)
    expect(byQuery.get('q1')).toMatchObject({ mappedPageUrl: 'https://ex.com/p1', cites: 1, miss: false })
    // q2 的 e3 只引了同域其他路径(DOMAIN)——意图口径只认 T1/T2
    expect(byQuery.get('q2')).toMatchObject({ cites: 0, miss: true })
  })

  it('无已发布页:rate 为 null 而非 0(证据不存在 ≠ 覆盖为零)', async () => {
    const result = await loadCoverage(makeDb({ events: base.events }), { workspaceId: WS, fromDay: '2026-10-01', toDay: '2026-10-31' })
    expect(result.summary.totalPages).toBe(0)
    expect(result.summary.coverageRate).toBeNull()
    expect(result.rows).toEqual([])
  })
})
