import { tx } from '../agent-readiness/types.js'
import type { HealthLanguage, HealthQuery, QueryKind, QueryLanguage } from './types.js'
import { AUTO_QUERY_MAX, AUTO_QUERY_MIN, USER_QUERY_MAX } from './weights.js'

const CJK = /[\u4e00-\u9fff]/

export function resolveLanguage(input: {
  language: HealthLanguage
  brandName: string
  industry: string | null
  siteUrl: string
}): QueryLanguage {
  if (input.language === 'zh' || input.language === 'en') return input.language
  if (CJK.test(`${input.brandName} ${input.industry ?? ''}`)) return 'zh'
  try {
    const host = new URL(input.siteUrl).hostname.toLowerCase()
    if (host.endsWith('.cn') || host.endsWith('.tw') || host.endsWith('.hk') || host.endsWith('.com.cn')) return 'zh'
  } catch {
    // The URL was already checked before a run. A bad value falls through to English.
  }
  return 'en'
}

export interface QueryPrompt {
  system: string
  user: string
}

/**
 * Prompt for the starter query set. The model must return JSON only.
 * `parseGeneratedQueries` is the other half of this contract.
 */
export function buildQueryPrompt(input: {
  brandName: string
  siteUrl: string
  industry: string | null
  competitors: string[]
  language: QueryLanguage
}): QueryPrompt {
  const languageName = input.language === 'zh' ? 'Simplified Chinese' : 'English'
  const system = [
    'You write realistic questions that people type into AI answer engines.',
    'Return JSON only. No markdown, no commentary.',
    'Shape: {"queries":[{"text":"...","kind":"brand"|"category"|"comparison","language":"zh"|"en"}]}',
    'Rules:',
    `- Write exactly ${AUTO_QUERY_MAX} questions.`,
    '- 3 brand questions: someone asking what the brand is, whether it is any good, or where the official site is.',
    '- 3 category questions: "best X", "which X should I use", or a recommendation in the industry. Do not stuff the brand name into every one.',
    '- 2 comparison questions against the named competitors. If no competitor is named, compare the brand with alternatives.',
    `- Every question's language field is "${input.language}" and the text is ${languageName}.`,
    '- Sound like a person, not a keyword list.',
    '- Do not mention GEO, SEO, or that these questions were generated.',
  ].join('\n')
  const user = [
    `brand: ${input.brandName}`,
    `site: ${input.siteUrl}`,
    `industry: ${input.industry ?? '(none)'}`,
    `competitors: ${input.competitors.length > 0 ? input.competitors.join(', ') : '(none)'}`,
    `language: ${input.language}`,
  ].join('\n')
  return { system, user }
}

export interface ParsedQueryDraft {
  text: string
  kind: QueryKind
  language: QueryLanguage | null
}

const KINDS = new Set<QueryKind>(['brand', 'category', 'comparison'])

/**
 * Pull queries out of a model response.
 * Accepts a fenced ```json block, or the first {...} object, or prose wrapped around it.
 * Drops empty text, unknown kinds, and anything past the cap. Never throws.
 */
export function parseGeneratedQueries(raw: string, limit = AUTO_QUERY_MAX): ParsedQueryDraft[] {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const body = fenced?.[1] ?? raw
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start < 0 || end <= start) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(body.slice(start, end + 1))
  } catch {
    return []
  }
  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { queries?: unknown }).queries)
      ? (parsed as { queries: unknown[] }).queries
      : null
  if (!list) return []
  const out: ParsedQueryDraft[] = []
  const seen = new Set<string>()
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const record = item as { text?: unknown; kind?: unknown; language?: unknown }
    if (typeof record.text !== 'string') continue
    const text = record.text.trim()
    if (!text || text.length > 300) continue
    if (record.kind !== 'brand' && record.kind !== 'category' && record.kind !== 'comparison') continue
    if (!KINDS.has(record.kind)) continue
    const key = text.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    const language = record.language === 'zh' || record.language === 'en' ? record.language : null
    out.push({ text, kind: record.kind, language })
    if (out.length >= limit) break
  }
  return out
}

export function templateQueries(input: {
  brandName: string
  industry: string | null
  competitors: string[]
  language: QueryLanguage
}): HealthQuery[] {
  const brand = input.brandName.trim()
  const industry = input.industry?.trim() || null
  const first = input.competitors[0]?.trim()
  const second = input.competitors[1]?.trim()
  if (input.language === 'zh') {
    const category = industry ?? brand
    return [
      q(`${brand} 是什么`, 'brand', 'zh'),
      q(`${brand} 怎么样`, 'brand', 'zh'),
      q(`${brand} 官网是哪个`, 'brand', 'zh'),
      q(industry ? `${industry}哪个好` : `${brand} 适合谁`, 'category', 'zh'),
      q(industry ? `最好的${industry}` : `${brand} 有哪些功能`, 'category', 'zh'),
      q(industry ? `${industry}推荐` : `${category} 怎么选`, 'category', 'zh'),
      q(first ? `${brand} 和 ${first} 哪个好` : `${brand} 和同类产品比怎么样`, 'comparison', 'zh'),
      q(second ? `${brand} 和 ${second} 比怎么样` : `${brand} 有什么替代`, 'comparison', 'zh'),
    ]
  }
  const category = industry ?? brand
  return [
    q(`What is ${brand}?`, 'brand', 'en'),
    q(`Is ${brand} worth it?`, 'brand', 'en'),
    q(`${brand} official site`, 'brand', 'en'),
    q(`best ${category}`, 'category', 'en'),
    q(industry ? `which ${industry} should I use` : `what is ${brand} used for`, 'category', 'en'),
    q(`${category} recommendations`, 'category', 'en'),
    q(first ? `${brand} vs ${first}` : `${brand} vs alternatives`, 'comparison', 'en'),
    q(second ? `${brand} vs ${second}` : `${brand} alternatives`, 'comparison', 'en'),
  ]
}

function q(text: string, kind: QueryKind, language: QueryLanguage): HealthQuery {
  return { text, kind, language, source: 'template' }
}

/** User-typed questions win outright. No LLM, no templates mixed in. */
export function queriesFromUser(texts: string[], language: QueryLanguage): HealthQuery[] {
  const out: HealthQuery[] = []
  const seen = new Set<string>()
  for (const raw of texts) {
    const text = raw.trim()
    if (!text) continue
    const key = text.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ text: text.slice(0, 300), kind: 'custom', language, source: 'user' })
    if (out.length >= USER_QUERY_MAX) break
  }
  return out
}

/**
 * Keep a valid model list (capped). If it is shorter than the minimum starter set,
 * fill from the deterministic templates up to AUTO_QUERY_MAX.
 */
export function completeQuerySet(parsed: ParsedQueryDraft[], templates: HealthQuery[], language: QueryLanguage): HealthQuery[] {
  const out: HealthQuery[] = []
  const seen = new Set<string>()
  for (const item of parsed) {
    push(out, seen, {
      text: item.text,
      kind: item.kind,
      language: item.language ?? language,
      source: 'llm',
    }, AUTO_QUERY_MAX)
  }
  if (out.length < AUTO_QUERY_MIN) {
    for (const tmpl of templates) {
      if (out.length >= AUTO_QUERY_MAX) break
      push(out, seen, tmpl, AUTO_QUERY_MAX)
    }
  }
  return out
}

function push(out: HealthQuery[], seen: Set<string>, query: HealthQuery, max: number) {
  if (out.length >= max) return
  const key = query.text.trim().toLowerCase()
  if (!key || seen.has(key)) return
  seen.add(key)
  out.push(query)
}

export function querySourceOf(queries: HealthQuery[]): HealthQuery['source'] | 'mixed' {
  const sources = new Set(queries.map((query) => query.source))
  if (sources.size === 1) return queries[0]?.source ?? 'template'
  if (sources.has('user')) return 'user'
  return 'mixed'
}

export const QUERY_FALLBACK_NOTE = {
  llm: tx(
    'The starter questions came from the LLM. Templates filled any gap under the minimum of 5.',
    '起步问题由模型生成。不足 5 条时用模板补齐。',
  ),
  template: tx(
    'The model did not return a usable question list, so this run used the built-in starter templates.',
    '模型没有返回可用的问题列表，这次改用内置的起步模板。',
  ),
  user: tx(
    'This run used the questions you typed.',
    '这次用的是你填写的问题。',
  ),
}
