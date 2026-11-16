import type { Atom } from '../content-optimizer/types.js'
import { createCitabilityEngine } from '../content-optimizer/citability.js'
import { createScoringEngine } from '../content-optimizer/scoring.js'
import { visibleText } from '../agent-readiness/checks/page-signals.js'
import { parseRobotsTxt } from '../agent-readiness/checks/robots.js'
import { parseSitemapXml } from '../agent-readiness/checks/sitemap.js'
import type { FetchOutcome } from '../agent-readiness/safe-fetch.js'
import { tx } from '../agent-readiness/types.js'
import { publicError } from './errors.js'
import { pageComposite } from './score.js'
import type { AtomGap, CitabilityPillar, PageCitability, WeakAtom } from './types.js'
import type { GeoHealthRunInput } from './run-input.js'
import { PAGE_CAP } from './weights.js'

const TEXT_CAP = 6_000
const SITEMAP_LOC_CAP = 200

const KEYWORD: { re: RegExp; score: number }[] = [
  { re: /\/(about|company|team|关于|公司)(\/|$)/i, score: 50 },
  { re: /\/(product|products|features|solutions|platform|产品|方案|功能)(\/|$)/i, score: 48 },
  { re: /\/(pricing|plans|price|价格)(\/|$)/i, score: 40 },
  { re: /\/(docs|doc|blog|faq|help|guide|文档|博客|帮助)(\/|$)/i, score: 30 },
  { re: /\/(contact|联系)(\/|$)/i, score: 10 },
]

export interface CitabilityRunDeps {
  fetchPage(url: string): Promise<FetchOutcome>
  atomize(text: string): Promise<Atom[]>
}

const scoring = createScoringEngine()
const citability = createCitabilityEngine()

export async function runCitability(input: GeoHealthRunInput, deps: CitabilityRunDeps): Promise<CitabilityPillar> {
  let home: URL
  try {
    home = new URL(input.siteUrl)
  } catch (err) {
    return failed(publicError(err), [])
  }

  let locs: string[] = []
  try {
    locs = await discoverLocs(home, deps.fetchPage)
  } catch {
    locs = []
  }
  const urls = selectPageUrls(home.toString(), locs, PAGE_CAP)
  const pages: PageCitability[] = []
  for (const url of urls) {
    pages.push(await scoreUrl(url, deps))
  }
  const scored = pages.filter((page) => page.fetchError == null)
  if (scored.length === 0) {
    return failed(
      pages[0]?.fetchError ?? '没有抓到可评分的页面',
      pages,
    )
  }
  const score = Math.round(scored.reduce((sum, page) => sum + page.composite, 0) / scored.length)
  const weakestPages = [...scored].sort((a, b) => a.composite - b.composite || a.url.localeCompare(b.url)).slice(0, 3)
  const failedFetches = pages.length - scored.length
  return {
    status: 'SUCCEEDED',
    score,
    pages,
    weakestPages,
    note: failedFetches > 0
      ? tx(
        `${scored.length} page(s) scored. ${failedFetches} URL(s) could not be fetched and were left out of the average.`,
        `评了 ${scored.length} 页。${failedFetches} 个地址没有抓到，不计入平均分。`,
      )
      : tx(
        `Scored the homepage and ${Math.max(0, scored.length - 1)} other page(s) from the sitemap (cap ${PAGE_CAP}).`,
        `评了首页，以及站点地图里的另外 ${Math.max(0, scored.length - 1)} 页（上限 ${PAGE_CAP} 页）。`,
      ),
    error: null,
  }
}

function failed(error: string, pages: PageCitability[]): CitabilityPillar {
  return {
    status: 'FAILED',
    score: null,
    pages,
    weakestPages: [],
    note: tx('No page could be scored.', '没有页面可以评分。'),
    error,
  }
}

/** Homepage first, then same-host sitemap URLs that look like key pages. */
export function selectPageUrls(homeUrl: string, locs: string[], cap = PAGE_CAP): string[] {
  const home = new URL(homeUrl)
  const originHost = home.hostname.replace(/^www\./i, '')
  const chosen = [home.toString()]
  const seen = new Set([normalizeUrl(home.toString())])
  const ranked: { url: string; score: number }[] = []
  for (const loc of locs.slice(0, SITEMAP_LOC_CAP)) {
    let url: URL
    try {
      url = new URL(loc, home)
    } catch {
      continue
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') continue
    if (url.hostname.replace(/^www\./i, '') !== originHost) continue
    if (/\.(xml|jpg|jpeg|png|gif|webp|pdf|zip|css|js|svg)$/i.test(url.pathname)) continue
    const key = normalizeUrl(url.toString())
    if (seen.has(key)) continue
    let score = 1
    for (const rule of KEYWORD) {
      if (rule.re.test(decodeURIComponent(url.pathname))) score = Math.max(score, rule.score)
    }
    score += Math.max(0, 8 - url.pathname.split('/').filter(Boolean).length)
    ranked.push({ url: url.toString(), score })
    seen.add(key)
  }
  ranked.sort((a, b) => b.score - a.score || a.url.localeCompare(b.url))
  for (const item of ranked) {
    if (chosen.length >= cap) break
    chosen.push(item.url)
  }
  return chosen
}

async function discoverLocs(home: URL, fetchPage: CitabilityRunDeps['fetchPage']): Promise<string[]> {
  const origin = home.origin
  const robots = await fetchPage(`${origin}/robots.txt`)
  const declared = !robots.error && robots.status === 200 ? parseRobotsTxt(robots.body).sitemaps : []
  const candidates = [...declared, `${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`]
  const seen = new Set<string>()
  for (const raw of candidates) {
    let url: string
    try {
      url = new URL(raw, `${origin}/`).toString()
    } catch {
      continue
    }
    if (seen.has(url)) continue
    seen.add(url)
    const doc = await fetchPage(url)
    if (doc.error || doc.status !== 200) continue
    const parsed = parseSitemapXml(doc.body)
    if (parsed.kind === 'invalid' || parsed.locs.length === 0) continue
    if (parsed.kind === 'index') {
      const child = parsed.locs[0]
      if (!child) continue
      const childDoc = await fetchPage(child)
      if (!childDoc.error && childDoc.status === 200) {
        const childParsed = parseSitemapXml(childDoc.body)
        if (childParsed.locs.length > 0) return childParsed.locs
      }
      continue
    }
    return parsed.locs
  }
  return []
}

async function scoreUrl(url: string, deps: CitabilityRunDeps): Promise<PageCitability> {
  let outcome: FetchOutcome
  try {
    outcome = await deps.fetchPage(url)
  } catch (err) {
    return blank(url, publicError(err))
  }
  if (outcome.error || outcome.status !== 200) {
    return blank(url, outcome.errorMessage || outcome.error || `HTTP ${outcome.status}`)
  }
  const title = pageTitle(outcome.body, url)
  const text = visibleText(outcome.body).slice(0, TEXT_CAP)
  if (text.length < 40) {
    return {
      url,
      title,
      atomScore: 0,
      citabilityScore: 0,
      composite: 0,
      weakestAtoms: [],
      fetchError: null,
    }
  }
  let atoms: Atom[]
  try {
    atoms = await deps.atomize(text)
  } catch {
    atoms = fallbackAtoms(text)
  }
  if (atoms.length === 0) atoms = fallbackAtoms(text)
  const scored = scoring.scoreAtoms(atoms)
  const atomScore = scoring.scorePage(scored)
  const passages = passageInputs(text)
  const passage = citability.scorePassages(passages)
  const weakestAtoms = [...scored]
    .sort((a, b) => a.score.total - b.score.total || a.text.localeCompare(b.text))
    .slice(0, 3)
    .map((atom): WeakAtom => ({
      text: atom.text.replace(/\s+/g, ' ').trim().slice(0, 180),
      score: atom.score.total,
      missing: gaps(atom.score),
    }))
  return {
    url,
    title,
    atomScore,
    citabilityScore: passage.average,
    composite: pageComposite(atomScore, passage.average),
    weakestAtoms,
    fetchError: null,
  }
}

function blank(url: string, fetchError: string): PageCitability {
  return {
    url,
    title: url,
    atomScore: 0,
    citabilityScore: 0,
    composite: 0,
    weakestAtoms: [],
    fetchError,
  }
}

function gaps(score: { hasNumericAnchor: boolean; hasEntityAnchor: boolean; isSelfContained: boolean; hasDefinition: boolean }): AtomGap[] {
  const missing: AtomGap[] = []
  if (!score.hasNumericAnchor) missing.push('numeric')
  if (!score.hasEntityAnchor) missing.push('entity')
  if (!score.isSelfContained) missing.push('selfContained')
  if (!score.hasDefinition) missing.push('definition')
  return missing
}

function fallbackAtoms(text: string): Atom[] {
  const parts = text.split(/(?<=[。！？.!?])\s+/).map((part) => part.trim()).filter((part) => part.length > 40)
  const used = (parts.length > 0 ? parts : [text]).slice(0, 6)
  return used.map((part) => ({
    text: part,
    subject: '',
    predicate: '',
    object: '',
    anchors: [],
  }))
}

function passageInputs(text: string) {
  const parts = text.split(/(?<=[。！？.!?])\s+/).map((part) => part.trim()).filter(Boolean)
  const chunks: string[] = []
  let buffer = ''
  for (const part of parts.length > 0 ? parts : [text]) {
    if ((buffer + part).length > 500 && buffer) {
      chunks.push(buffer.trim())
      buffer = part
    } else {
      buffer = buffer ? `${buffer} ${part}` : part
    }
  }
  if (buffer.trim()) chunks.push(buffer.trim())
  const used = chunks.slice(0, 8)
  return used.map((chunk, index) => ({
    text: chunk,
    positionRatio: used.length <= 1 ? 0 : index / (used.length - 1),
    hasAttribution: /来源|据《|according to|source:/i.test(chunk),
    hasUniqueData: /\d/.test(chunk),
  }))
}

function pageTitle(html: string, fallback: string): string {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  const title = match?.[1]?.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() ?? ''
  return title.slice(0, 120) || fallback
}

function normalizeUrl(value: string): string {
  try {
    const url = new URL(value)
    url.hash = ''
    if (url.pathname.length > 1 && url.pathname.endsWith('/')) url.pathname = url.pathname.slice(0, -1)
    return url.toString()
  } catch {
    return value
  }
}
