import { BROWSER_USER_AGENT, PROBE_BOTS } from './bots.js'
import { checkBotUserAgent, checkHttpAccess } from './checks/access.js'
import { checkLlmsFull, checkLlmsLinks, checkLlmsTxt, type ParsedLlmsTxt } from './checks/llms-txt.js'
import { checkMarkdown, markdownSiblingUrl } from './checks/markdown.js'
import { checkPageSignals } from './checks/page-signals.js'
import { checkRobots } from './checks/robots.js'
import { checkSitemap, parseSitemapXml } from './checks/sitemap.js'
import { buildReport } from './score.js'
import { safeFetch, type FetchOutcome } from './safe-fetch.js'
import { assertPublicHttpUrl, SsrfError } from './ssrf.js'
import type { AgentReadinessReport } from './types.js'

export interface AuditFetchInit {
  method?: 'GET' | 'HEAD'
  headers?: Record<string, string>
  timeoutMs?: number
  maxBytes?: number
}

export interface AuditFetcher {
  get(url: string, init?: AuditFetchInit): Promise<FetchOutcome>
}

export interface RunAuditOptions {
  fetch?: AuditFetcher
  now?: () => Date
  budgetMs?: number
}

const HTML_MAX = 1_500_000
const TEXT_MAX = 512_000
const PROBE_MAX = 8_192
const LINK_MAX = 2_048
const REQUEST_TIMEOUT_MS = 8_000
const DEFAULT_BUDGET_MS = 25_000

export function createDefaultAuditFetcher(): AuditFetcher {
  return {
    get(url, init) {
      return safeFetch(url, init)
    },
  }
}

function timeoutOutcome(url: string): FetchOutcome {
  return {
    url,
    status: 0,
    headers: {},
    body: '',
    truncated: false,
    redirectChain: [],
    durationMs: 0,
    error: 'timeout',
    errorMessage: '审计时间预算已用完',
  }
}

function contentType(outcome: FetchOutcome): string {
  return outcome.headers['content-type'] ?? ''
}

function looksLikeXml(outcome: FetchOutcome): boolean {
  if (outcome.error || outcome.status !== 200) return false
  if (/text\/html/i.test(contentType(outcome))) return false
  const parsed = parseSitemapXml(outcome.body)
  return parsed.kind !== 'invalid'
}

/**
 * Run every readiness check for one URL.
 * Throws SsrfError when the target (or its redirect) is a private address.
 * Network failures become failed checks, not a thrown error.
 */
export async function runAgentReadinessAudit(targetUrl: string, options: RunAuditOptions = {}): Promise<AgentReadinessReport> {
  const parsed = assertPublicHttpUrl(targetUrl)
  const normalized = parsed.toString()
  const fetcher = options.fetch ?? createDefaultAuditFetcher()
  const now = options.now ?? (() => new Date())
  const startedAt = now()
  const startedMs = Date.now()
  const deadline = startedMs + (options.budgetMs ?? DEFAULT_BUDGET_MS)

  const get = async (url: string, init?: AuditFetchInit): Promise<FetchOutcome> => {
    const left = deadline - Date.now()
    if (left < 250) return timeoutOutcome(url)
    return fetcher.get(url, {
      ...init,
      timeoutMs: Math.min(init?.timeoutMs ?? REQUEST_TIMEOUT_MS, left),
    })
  }

  const browserHeaders = {
    'user-agent': BROWSER_USER_AGENT,
    accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
  }
  const page = await get(normalized, { headers: browserHeaders, maxBytes: HTML_MAX })
  if (page.error === 'ssrf') throw new SsrfError(page.errorMessage || '目标地址被拒绝')

  const finalUrl = page.url || normalized
  let origin: string
  try {
    origin = new URL(finalUrl).origin
  } catch {
    origin = parsed.origin
  }

  const [robotsRes, llmsRes, llmsFullRes, negotiated, ...botResults] = await Promise.all([
    get(`${origin}/robots.txt`, {
      headers: { 'user-agent': BROWSER_USER_AGENT, accept: 'text/plain,*/*;q=0.1' },
      maxBytes: TEXT_MAX,
    }),
    get(`${origin}/llms.txt`, {
      headers: { 'user-agent': BROWSER_USER_AGENT, accept: 'text/plain, text/markdown, */*;q=0.1' },
      maxBytes: TEXT_MAX,
    }),
    get(`${origin}/llms-full.txt`, {
      headers: { 'user-agent': BROWSER_USER_AGENT, accept: 'text/plain, text/markdown, */*;q=0.1' },
      maxBytes: TEXT_MAX,
    }),
    get(finalUrl, {
      headers: {
        'user-agent': BROWSER_USER_AGENT,
        accept: 'text/markdown, text/plain;q=0.9, */*;q=0.1',
      },
      maxBytes: TEXT_MAX,
    }),
    ...PROBE_BOTS.map((bot) => get(normalized, {
      headers: { 'user-agent': bot.userAgent, accept: 'text/html,*/*;q=0.8' },
      maxBytes: PROBE_MAX,
    })),
  ])

  for (const result of [robotsRes, llmsRes, llmsFullRes, negotiated, ...botResults]) {
    if (result.error === 'ssrf') throw new SsrfError(result.errorMessage || '目标地址被拒绝')
  }

  let path = '/'
  try {
    const u = new URL(finalUrl)
    path = `${u.pathname}${u.search}` || '/'
  } catch {
    path = '/'
  }

  const robots = checkRobots({
    status: robotsRes.status,
    body: robotsRes.body,
    contentType: contentType(robotsRes),
    error: robotsRes.error,
    path,
    truncated: robotsRes.truncated,
  })

  const llms = checkLlmsTxt({
    status: llmsRes.status,
    body: llmsRes.body,
    contentType: contentType(llmsRes),
    error: llmsRes.error,
  })
  const llmsFull = checkLlmsFull({
    status: llmsFullRes.status,
    body: llmsFullRes.body,
    contentType: contentType(llmsFullRes),
    error: llmsFullRes.error,
  })
  const linkCheck = await sampleLlmsLinks(get, llms.parsed, `${origin}/llms.txt`)

  const sitemapCheck = await discoverSitemap(get, origin, robots.sitemaps)

  const pageAvailable = !page.error && page.status === 200
  const pageChecks = checkPageSignals({
    available: pageAvailable,
    url: normalized,
    finalUrl,
    status: page.status,
    headers: page.headers,
    html: page.body,
    error: page.error,
  })

  const dotMdUrl = markdownSiblingUrl(finalUrl)
  const dotMd = dotMdUrl
    ? await get(dotMdUrl, {
      headers: { 'user-agent': BROWSER_USER_AGENT, accept: 'text/markdown, text/plain;q=0.9' },
      maxBytes: TEXT_MAX,
    })
    : null
  const markdown = checkMarkdown(
    {
      url: negotiated.url,
      status: negotiated.status,
      contentType: contentType(negotiated),
      body: negotiated.body,
      error: negotiated.error,
    },
    dotMd
      ? {
        url: dotMd.url,
        status: dotMd.status,
        contentType: contentType(dotMd),
        body: dotMd.body,
        error: dotMd.error,
      }
      : null,
  )

  const browserProbe = {
    status: page.status,
    durationMs: page.durationMs,
    error: page.error,
    finalUrl,
    redirectCount: page.redirectChain.length,
  }
  const httpCheck = checkHttpAccess(browserProbe)
  const botCheck = checkBotUserAgent(browserProbe, PROBE_BOTS.map((bot, i) => ({
    token: bot.token,
    userAgent: bot.userAgent,
    status: botResults[i]?.status ?? 0,
    durationMs: botResults[i]?.durationMs ?? 0,
    error: botResults[i]?.error,
  })))

  const finished = now()
  return buildReport({
    url: normalized,
    finalUrl,
    fetchedAt: startedAt.toISOString(),
    durationMs: finished.getTime() - startedAt.getTime() || Date.now() - startedMs,
    checks: [
      httpCheck,
      botCheck,
      ...robots.checks,
      llms.check,
      llmsFull,
      linkCheck,
      sitemapCheck,
      ...pageChecks,
      markdown,
    ],
  })
}

async function sampleLlmsLinks(
  get: (url: string, init?: AuditFetchInit) => Promise<FetchOutcome>,
  parsed: ParsedLlmsTxt | null,
  base: string,
) {
  if (!parsed || parsed.links.length === 0) return checkLlmsLinks(parsed, [])
  const urls: string[] = []
  const seen = new Set<string>()
  for (const link of parsed.links) {
    try {
      const url = new URL(link.url, base)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') continue
      const value = url.toString()
      if (seen.has(value)) continue
      seen.add(value)
      urls.push(value)
    } catch {
      // ignore unresolvable links; they will not be in the sample
    }
    if (urls.length >= 5) break
  }
  const probes = []
  for (const url of urls) {
    let result = await get(url, { method: 'HEAD', maxBytes: LINK_MAX, headers: { 'user-agent': BROWSER_USER_AGENT } })
    if (result.status === 405 || result.status === 501) {
      result = await get(url, { method: 'GET', maxBytes: LINK_MAX, headers: { 'user-agent': BROWSER_USER_AGENT } })
    }
    probes.push({
      url,
      status: result.status,
      error: result.error === 'ssrf' ? (result.errorMessage || 'blocked') : result.error,
    })
  }
  return checkLlmsLinks(parsed, probes)
}

async function discoverSitemap(
  get: (url: string, init?: AuditFetchInit) => Promise<FetchOutcome>,
  origin: string,
  declared: string[],
) {
  const candidates: { source: 'robots' | 'sitemap.xml' | 'sitemap_index.xml'; url: string }[] = []
  for (const raw of declared) {
    try {
      const url = new URL(raw, `${origin}/`)
      if (url.protocol === 'http:' || url.protocol === 'https:') {
        candidates.push({ source: 'robots', url: url.toString() })
      }
    } catch {
      // skip malformed Sitemap directives
    }
  }
  candidates.push({ source: 'sitemap.xml', url: `${origin}/sitemap.xml` })
  candidates.push({ source: 'sitemap_index.xml', url: `${origin}/sitemap_index.xml` })

  let lastError: FetchOutcome | null = null
  for (const candidate of candidates) {
    const result = await get(candidate.url, {
      headers: { 'user-agent': BROWSER_USER_AGENT, accept: 'application/xml, text/xml, */*;q=0.1' },
      maxBytes: TEXT_MAX,
    })
    if (result.error === 'ssrf' || !looksLikeXml(result)) {
      lastError = result
      continue
    }
    const parsed = parseSitemapXml(result.body)
    let childUrlCount: number | null = null
    if (parsed.kind === 'index' && parsed.locs[0]) {
      const child = await get(parsed.locs[0], {
        headers: { 'user-agent': BROWSER_USER_AGENT, accept: 'application/xml, text/xml, */*;q=0.1' },
        maxBytes: TEXT_MAX,
      })
      if (!child.error && child.status === 200) childUrlCount = parseSitemapXml(child.body).locs.length
    }
    return checkSitemap({
      source: candidate.source,
      url: result.url || candidate.url,
      status: result.status,
      body: result.body,
      contentType: contentType(result),
      declaredSitemaps: declared,
      childUrlCount,
    })
  }

  return checkSitemap({
    source: null,
    url: null,
    status: lastError?.status ?? 0,
    body: '',
    error: lastError?.error,
    declaredSitemaps: declared,
  })
}
