import type { ChatMessage } from '../../core/llm/types.js'
import { analyzeCitation } from '../citation-monitor/analyzer.js'
import type { PlatformResult } from '../citation-monitor/platform-adapters/types.js'
import { tx } from '../agent-readiness/types.js'
import { publicError } from './errors.js'
import {
  buildQueryPrompt,
  completeQuerySet,
  queriesFromUser,
  querySourceOf,
  resolveLanguage,
  templateQueries,
  parseGeneratedQueries,
  QUERY_FALLBACK_NOTE,
} from './queries.js'
import { citationPillarScore } from './score.js'
import type { CitationPillar, CitationSample, CompetitorSov, EngineSkip, HealthQuery, QueryRollup } from './types.js'
import type { GeoHealthRunInput } from './run-input.js'

const SAMPLE_URL_CAP = 8
const CITED_URL_CAP = 30
const CALL_TIMEOUT_MS = 25_000
const CALL_CONCURRENCY = 4

export interface CitationRunDeps {
  completeChat(messages: ChatMessage[]): Promise<string>
  listEngines(workspaceId: string): Promise<{ active: string[]; skipped: EngineSkip[] }>
  queryEngine(workspaceId: string, platform: string, text: string): Promise<PlatformResult>
}

export async function runCitationSnapshot(input: GeoHealthRunInput, deps: CitationRunDeps): Promise<CitationPillar> {
  const language = resolveLanguage(input)
  let queries: HealthQuery[]
  let note = QUERY_FALLBACK_NOTE.user
  if (input.userQueries.length > 0) {
    queries = queriesFromUser(input.userQueries, language)
  } else {
    const templates = templateQueries({
      brandName: input.brandName,
      industry: input.industry,
      competitors: input.competitors,
      language,
    })
    try {
      const prompt = buildQueryPrompt({
        brandName: input.brandName,
        siteUrl: input.siteUrl,
        industry: input.industry,
        competitors: input.competitors,
        language,
      })
      const raw = await deps.completeChat([
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ])
      const parsed = parseGeneratedQueries(raw)
      queries = completeQuerySet(parsed, templates, language)
      note = queries.every((query) => query.source === 'template')
        ? QUERY_FALLBACK_NOTE.template
        : QUERY_FALLBACK_NOTE.llm
    } catch (err) {
      queries = templates
      note = tx(
        `${QUERY_FALLBACK_NOTE.template.en} (${publicError(err)})`,
        `${QUERY_FALLBACK_NOTE.template.zh}（${publicError(err)}）`,
      )
    }
  }

  let engines: { active: string[]; skipped: EngineSkip[] }
  try {
    engines = await deps.listEngines(input.workspaceId)
  } catch (err) {
    return emptyCitations(queries, 'FAILED', publicError(err), tx(
      'Engine credentials could not be read, so no question was sent.',
      '读不到引擎凭证，所以没有发出任何问题。',
    ))
  }

  if (engines.active.length === 0) {
    return {
      ...emptyCitations(queries, 'SKIPPED', null, tx(
        'No registered engine has credentials yet. The questions are saved on this report so you can monitor them after you add a key.',
        '已注册的引擎都还没有凭证。问题已经写在这份报告里，配好 Key 之后可以拿去持续监测。',
      )),
      enginesSkipped: engines.skipped,
    }
  }

  const domain = brandDomain(input.siteUrl)
  const pairs = engines.active.flatMap((platform) => queries.map((query) => ({ platform, query })))
  const samples = await mapPool(pairs, CALL_CONCURRENCY, async (pair) => ask(input, domain, pair.platform, pair.query, deps))
  const ok = samples.filter((sample) => sample.ok)
  if (ok.length === 0) {
    return {
      status: 'FAILED',
      score: null,
      queries: rollup(queries, samples),
      querySource: querySourceOf(queries),
      enginesRun: engines.active,
      enginesSkipped: engines.skipped,
      mentionRate: null,
      citationRate: null,
      meanRank: null,
      shareOfVoice: null,
      citedUrls: [],
      brandCitedUrls: [],
      competitorSov: competitorRows(input.competitors, samples),
      samples,
      note: tx(
        'Every engine call failed. Nothing was scored. The skipped engines, if any, are listed separately.',
        '所有引擎调用都失败了，这次没有评分。未配置的引擎另外列在跳过名单里。',
      ),
      error: samples.map((sample) => sample.error).filter(Boolean)[0] ?? '引擎没有返回',
    }
  }

  const mentionRate = ok.filter((sample) => sample.brandMentioned).length / ok.length
  const citationRate = ok.filter((sample) => sample.brandCited).length / ok.length
  const ranks = ok.map((sample) => sample.rankInAnswer).filter((rank): rank is number => rank != null && rank > 0)
  const meanRank = ranks.length > 0 ? ranks.reduce((sum, rank) => sum + rank, 0) / ranks.length : null
  const sovValues = ok.map((sample) => sample.sovScore)
  const shareOfVoice = sovValues.reduce((sum, value) => sum + value, 0) / sovValues.length
  const citedUrls = unique(ok.flatMap((sample) => sample.citedUrls)).slice(0, CITED_URL_CAP)
  const brandCitedUrls = unique(ok.filter((sample) => sample.brandCited).flatMap((sample) => sample.citedUrls.filter((url) => matchesDomain(url, domain)))).slice(0, CITED_URL_CAP)

  return {
    status: 'SUCCEEDED',
    score: citationPillarScore({ mentionRate, citationRate, meanRank }),
    queries: rollup(queries, samples),
    querySource: querySourceOf(queries),
    enginesRun: engines.active,
    enginesSkipped: engines.skipped,
    mentionRate,
    citationRate,
    meanRank,
    shareOfVoice,
    citedUrls,
    brandCitedUrls,
    competitorSov: competitorRows(input.competitors, samples),
    samples,
    note,
    error: null,
  }
}

function emptyCitations(
  queries: HealthQuery[],
  status: 'SKIPPED' | 'FAILED',
  error: string | null,
  note: CitationPillar['note'],
): CitationPillar {
  return {
    status,
    score: null,
    queries: rollup(queries, []),
    querySource: querySourceOf(queries),
    enginesRun: [],
    enginesSkipped: [],
    mentionRate: null,
    citationRate: null,
    meanRank: null,
    shareOfVoice: null,
    citedUrls: [],
    brandCitedUrls: [],
    competitorSov: [],
    samples: [],
    note,
    error,
  }
}

async function ask(
  input: GeoHealthRunInput,
  domain: string,
  platform: string,
  query: HealthQuery,
  deps: CitationRunDeps,
): Promise<CitationSample> {
  try {
    const result = await withTimeout(deps.queryEngine(input.workspaceId, platform, query.text), CALL_TIMEOUT_MS)
    const analysis = analyzeCitation({
      platformResult: result,
      brand: { name: input.brandName, domain: domain || undefined },
      brandDomains: domain ? [domain] : [],
      competitors: input.competitors,
    })
    const names = [input.brandName, ...input.competitors]
    const counts = names.map((name) => countTerm(result.answer ?? '', name))
    const total = counts.reduce((sum, count) => sum + count, 0)
    const sovScore = total > 0 ? counts[0] / total : 0
    const urls = unique([
      ...result.sourceCitations.map((item) => item.url),
      ...result.groundingSources.map((item) => item.url),
    ]).slice(0, SAMPLE_URL_CAP)
    return {
      platform,
      query: query.text,
      ok: true,
      error: null,
      brandMentioned: analysis.brandMentioned,
      brandCited: analysis.brandSourceCited,
      rankInAnswer: analysis.rankInAnswer,
      sovScore,
      citedUrls: urls,
      competitors: input.competitors.map((brand, index) => {
        const match = analysis.competitors.find((item) => item.brand === brand)
        return {
          brand,
          mentioned: match?.mentioned ?? false,
          rank: match?.rank ?? null,
          shareOfVoice: total > 0 ? counts[index + 1] / total : 0,
        }
      }),
    }
  } catch (err) {
    return {
      platform,
      query: query.text,
      ok: false,
      error: publicError(err),
      brandMentioned: false,
      brandCited: false,
      rankInAnswer: null,
      sovScore: 0,
      citedUrls: [],
      competitors: [],
    }
  }
}

function rollup(queries: HealthQuery[], samples: CitationSample[]): QueryRollup[] {
  return queries.map((query) => {
    const mine = samples.filter((sample) => sample.ok && sample.query === query.text)
    const ranks = mine.map((sample) => sample.rankInAnswer).filter((rank): rank is number => rank != null && rank > 0)
    return {
      ...query,
      samples: mine.length,
      mentions: mine.filter((sample) => sample.brandMentioned).length,
      citations: mine.filter((sample) => sample.brandCited).length,
      meanRank: ranks.length > 0 ? ranks.reduce((sum, rank) => sum + rank, 0) / ranks.length : null,
    }
  })
}

function competitorRows(competitors: string[], samples: CitationSample[]): CompetitorSov[] {
  const ok = samples.filter((sample) => sample.ok)
  if (ok.length === 0 || competitors.length === 0) return []
  return competitors.map((brand) => {
    const rows = ok.map((sample) => sample.competitors.find((item) => item.brand === brand))
    const known = rows.filter((row): row is NonNullable<typeof row> => !!row)
    const mentioned = known.filter((row) => row.mentioned).length
    const share = known.reduce((sum, row) => sum + row.shareOfVoice, 0)
    return {
      brand,
      mentionRate: mentioned / ok.length,
      shareOfVoice: known.length > 0 ? share / ok.length : 0,
    }
  })
}

export function brandDomain(siteUrl: string): string {
  try {
    return new URL(siteUrl).hostname.replace(/^www\./i, '')
  } catch {
    return ''
  }
}

export function matchesDomain(url: string, domain: string): boolean {
  if (!domain) return false
  try {
    const host = new URL(url).hostname.replace(/^www\./i, '')
    return host === domain || host.endsWith(`.${domain}`)
  } catch {
    return false
  }
}

function countTerm(text: string, term: string): number {
  const trimmed = term.trim()
  if (!trimmed) return 0
  const re = new RegExp(trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
  return [...text.matchAll(re)].length
}

function unique(values: string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    if (!value || seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}

async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      out[index] = await fn(items[index])
    }
  })
  await Promise.all(workers)
  return out
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('引擎超时')), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}
