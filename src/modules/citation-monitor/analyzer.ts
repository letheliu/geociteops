import fuzzysort from 'fuzzysort'
import type { PlatformResult } from './platform-adapters/types.js'

export interface Competitor {
  name: string
  domain?: string
  aliases?: string[]
}

export interface CompetitorMention {
  brand: string
  mentioned: boolean
  rank: number | null
  matchType?: 'exact' | 'fuzzy' | 'domain'
  matchedVia?: string
}

export interface CitationAnalysis {
  brandMentioned: boolean
  brandSourceCited: boolean
  rankInAnswer: number | null
  sourceRank: number | null
  sovScore: number
  sourceCitationRate: number
  competitors: CompetitorMention[]
}

export interface AnalyzeInput {
  platformResult: PlatformResult
  brand: string | Competitor
  brandDomains?: string[]
  competitors: Array<string | Competitor>
}

const FUZZY_THRESHOLD = Number(process.env.FUZZY_MATCH_THRESHOLD || -50)

/** 把 string | Competitor 统一成 Competitor（兼容旧字符串格式）。 */
function normalizeCompetitor(c: string | Competitor): Competitor {
  return typeof c === 'string' ? { name: c } : c
}

function normalizeStr(s: string): string {
  return s.toLowerCase().replace(/^www\./, '').trim()
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** ① 精确包含：归一化后判断 name/alias 是否出现在 text 中。返回命中的候选词或 null。 */
function matchExact(text: string, c: Competitor): string | null {
  const normalizedText = normalizeStr(text)
  const candidates = [c.name, ...(c.aliases ?? [])]
  for (const candidate of candidates) {
    if (normalizedText.includes(normalizeStr(candidate))) return candidate
  }
  return null
}

/** ② fuzzy 模糊：typo 容错。返回命中的候选词或 null。 */
function matchFuzzy(text: string, c: Competitor): string | null {
  const candidates = [c.name, ...(c.aliases ?? [])]
  for (const candidate of candidates) {
    const result = fuzzysort.go(normalizeStr(candidate), [normalizeStr(text)], {
      threshold: FUZZY_THRESHOLD,
    })
    if (result.total > 0) return candidate
  }
  return null
}

function urlMatchesDomains(url: string, domains: string[]): boolean {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '')
    return domains.some((d) => host === d || host.endsWith(`.${d}`))
  } catch {
    return false
  }
}

/** 计算某词在 text 中的出现次数（精确，用于 SOV 统计）。 */
function countOccurrences(text: string, term: string): number {
  const re = new RegExp(escapeRegex(term), 'gi')
  return [...text.matchAll(re)].length
}

function firstIndex(text: string, term: string): number {
  return text.toLowerCase().indexOf(term.toLowerCase())
}

interface MatchOutcome {
  mentioned: boolean
  matchType?: 'exact' | 'fuzzy' | 'domain'
  matchedVia?: string
}

/** 三级匹配：精确包含 → fuzzy → domain。返回命中级别。 */
function matchCompetitor(
  c: Competitor,
  answer: string,
  allSources: { url: string }[],
): MatchOutcome {
  // ① 精确包含
  const exactHit = matchExact(answer, c)
  if (exactHit) return { mentioned: true, matchType: 'exact', matchedVia: exactHit }

  // ② fuzzy 模糊
  const fuzzyHit = matchFuzzy(answer, c)
  if (fuzzyHit) return { mentioned: true, matchType: 'fuzzy', matchedVia: fuzzyHit }

  // ③ domain 匹配（引用来源归属）
  if (c.domain) {
    const domainHit = allSources.some((s) => urlMatchesDomains(s.url, [c.domain!]))
    if (domainHit) return { mentioned: true, matchType: 'domain', matchedVia: c.domain }
  }

  return { mentioned: false }
}

export function analyzeCitation(input: AnalyzeInput): CitationAnalysis {
  const { platformResult } = input
  const answer = platformResult.answer
  const brandComp = normalizeCompetitor(input.brand)
  const competitors = input.competitors.map(normalizeCompetitor)
  const brandDomains = input.brandDomains ?? []

  const allSources = [...platformResult.sourceCitations, ...platformResult.groundingSources]

  // 收集所有品牌（主品牌 + 竞品）的匹配结果
  const brandMatch = matchCompetitor(brandComp, answer, allSources)
  const competitorMatches = competitors.map((c) => ({ comp: c, ...matchCompetitor(c, answer, allSources) }))

  // 按首次精确出现位置排序计算 rank（仍用精确名计数定位）
  const all = [brandComp, ...competitors]
  const positioned = all
    .map((c) => ({
      name: c.name,
      idx: firstIndex(answer, c.name),
    }))
    .filter((s) => s.idx >= 0)
    .sort((a, b) => a.idx - b.idx)

  // 主品牌
  const brandMentioned = brandMatch.mentioned
  const rankInAnswer = brandMentioned
    ? positioned.findIndex((s) => s.name === brandComp.name) + 1
    : null
  // 若主品牌是 alias/domain 命中但 name 不在 positioned 里，rank 记为最后
  const rankInAnswerFinal = rankInAnswer === 0 ? positioned.length + 1 : rankInAnswer

  // SOV = 主品牌提及次数 / 所有品牌提及总次数（仍用精确计数，保证可比性）
  const counts = all.map((c) => countOccurrences(answer, c.name))
  const totalMentions = counts.reduce((sum, n) => sum + n, 0)
  const brandCount = counts[0]
  const sovScore = totalMentions > 0 ? brandCount / totalMentions : 0

  // 竞品
  const competitorResult: CompetitorMention[] = competitorMatches.map((m) => {
    if (!m.mentioned) return { brand: m.comp.name, mentioned: false, rank: null }
    const rank = positioned.findIndex((s) => s.name === m.comp.name)
    return {
      brand: m.comp.name,
      mentioned: true,
      rank: rank >= 0 ? rank + 1 : positioned.length + 1,
      matchType: m.matchType,
      matchedVia: m.matchedVia,
    }
  })

  // Source citation 分析（brand domain）
  const brandSourceCited = allSources.some((s) => urlMatchesDomains(s.url, brandDomains))
  const sourceRank = brandSourceCited
    ? allSources.find((s) => urlMatchesDomains(s.url, brandDomains))?.position ?? null
    : null
  const sourceCitationRate =
    allSources.length > 0
      ? allSources.filter((s) => urlMatchesDomains(s.url, brandDomains)).length / allSources.length
      : 0

  return {
    brandMentioned,
    brandSourceCited,
    rankInAnswer: rankInAnswerFinal,
    sourceRank,
    sovScore,
    sourceCitationRate,
    competitors: competitorResult,
  }
}
