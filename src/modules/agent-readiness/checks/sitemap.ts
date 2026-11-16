import { asEvidence, tx, type AgentReadinessCheck, type CheckStatus } from '../types.js'
import { CHECK_WEIGHTS } from '../weights.js'

export interface ParsedSitemap {
  kind: 'urlset' | 'index' | 'invalid'
  locs: string[]
}

const LOC_RE = /<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]]+?)\s*(?:\]\]>)?\s*<\/loc>/gi

export function parseSitemapXml(xml: string): ParsedSitemap {
  const locs: string[] = []
  for (const match of xml.matchAll(LOC_RE)) {
    const value = match[1]?.trim()
    if (value) locs.push(value)
  }
  if (/<sitemapindex[\s>]/i.test(xml)) return { kind: 'index', locs }
  if (/<urlset[\s>]/i.test(xml)) return { kind: 'urlset', locs }
  if (locs.length > 0) return { kind: 'urlset', locs }
  return { kind: 'invalid', locs: [] }
}

export interface SitemapCheckInput {
  /** Where the sitemap was found, or null when discovery failed. */
  source: 'robots' | 'sitemap.xml' | 'sitemap_index.xml' | null
  url: string | null
  status: number
  body: string
  contentType?: string
  error?: string
  /** When the document is a sitemap index, the first child that was fetched. */
  childUrlCount?: number | null
  declaredSitemaps?: string[]
}

export function checkSitemap(input: SitemapCheckInput): AgentReadinessCheck {
  if (!input.source || !input.url) {
    return sitemapCheck('fail', tx(
      'No sitemap was discovered. robots.txt has no Sitemap directive, and neither /sitemap.xml nor /sitemap_index.xml returned XML.',
      '没有发现站点地图。robots.txt 里没有 Sitemap 指令，/sitemap.xml 和 /sitemap_index.xml 也没有返回 XML。',
    ), tx(
      'Add `Sitemap: https://<host>/sitemap.xml` to robots.txt and publish a urlset (or a sitemap index) listing canonical URLs.',
      '在 robots.txt 加上 `Sitemap: https://<主机>/sitemap.xml`，并发布列出权威 URL 的 urlset（或 sitemap index）。',
    ), { source: null, declared: input.declaredSitemaps ?? [] })
  }

  if (input.error || input.status !== 200) {
    return sitemapCheck('fail', tx(
      `Sitemap ${input.url} could not be read (${input.error ?? `HTTP ${input.status}`}).`,
      `无法读取站点地图 ${input.url}（${input.error ?? `HTTP ${input.status}`}）。`,
    ), tx(
      'The Sitemap URL must return HTTP 200 and XML. Fix the redirect or the file, and keep the robots.txt directive in sync.',
      'Sitemap URL 必须返回 HTTP 200 和 XML。修好重定向或文件，并让 robots.txt 里的地址与它一致。',
    ), { source: input.source, url: input.url, status: input.status, error: input.error ?? null })
  }

  if (input.contentType && /text\/html/i.test(input.contentType)) {
    return sitemapCheck('fail', tx(
      `Sitemap URL ${input.url} returned HTML, not XML.`,
      `站点地图地址 ${input.url} 返回了 HTML，不是 XML。`,
    ), tx('Serve an XML urlset or sitemapindex at that URL.', '在该 URL 返回 XML urlset 或 sitemapindex。'), { source: input.source, url: input.url })
  }

  const parsed = parseSitemapXml(input.body)
  if (parsed.kind === 'invalid') {
    return sitemapCheck('fail', tx(
      `Sitemap ${input.url} is not a urlset or sitemapindex (no <urlset>, <sitemapindex>, or <loc>).`,
      `站点地图 ${input.url} 不是 urlset 或 sitemapindex（没有 <urlset>、<sitemapindex> 或 <loc>）。`,
    ), tx(
      'Publish valid sitemap XML. A minimal file is a <urlset> with one <url><loc> per canonical page.',
      '发布合法的 sitemap XML。最小形式是 <urlset>，每个权威页面一个 <url><loc>。',
    ), { source: input.source, url: input.url })
  }

  if (parsed.locs.length === 0) {
    return sitemapCheck('warn', tx(
      `Sitemap ${input.url} parsed as ${parsed.kind} but contains zero <loc> entries.`,
      `站点地图 ${input.url} 解析为 ${parsed.kind}，但没有任何 <loc>。`,
    ), tx('Add the canonical page URLs (or child sitemap URLs) as <loc> entries.', '把权威页面 URL（或子站点地图 URL）写成 <loc>。'), {
      source: input.source,
      url: input.url,
      kind: parsed.kind,
      urlCount: 0,
    })
  }

  const status: CheckStatus = 'pass'
  const childNote = parsed.kind === 'index'
    ? tx(
      ` It is a sitemap index with ${parsed.locs.length} child sitemap(s).${input.childUrlCount != null ? ` The first child lists ${input.childUrlCount} URL(s).` : ''}`,
      ` 这是包含 ${parsed.locs.length} 个子站点地图的索引。${input.childUrlCount != null ? `第一个子地图列出 ${input.childUrlCount} 个 URL。` : ''}`,
    )
    : tx(` It lists ${parsed.locs.length} URL(s).`, ` 其中列出 ${parsed.locs.length} 个 URL。`)

  return sitemapCheck(status, tx(
    `Sitemap discovered via ${input.source} at ${input.url}.${childNote.en}`,
    `通过 ${input.source} 发现站点地图 ${input.url}。${childNote.zh}`,
  ), tx('No change required.', '无需修改。'), {
    source: input.source,
    url: input.url,
    kind: parsed.kind,
    urlCount: parsed.locs.length,
    sample: parsed.locs.slice(0, 5),
    childUrlCount: input.childUrlCount ?? null,
  })
}

function sitemapCheck(status: CheckStatus, explanation: ReturnType<typeof tx>, fix: ReturnType<typeof tx>, evidence: object): AgentReadinessCheck {
  return {
    id: 'sitemap',
    category: 'sitemap',
    title: tx('XML sitemap is discoverable', 'XML 站点地图可被发现'),
    status,
    weight: CHECK_WEIGHTS.sitemap,
    applicable: true,
    explanation,
    fix,
    verify: tx(
      'curl -s https://<host>/robots.txt | grep -i sitemap, then curl -s that URL and confirm <loc> entries. Re-run the audit.',
      'curl -s https://<主机>/robots.txt | grep -i sitemap，再 curl -s 该地址并确认有 <loc>。然后重新审计。',
    ),
    evidence: asEvidence(evidence),
  }
}
