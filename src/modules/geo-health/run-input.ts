import { assertPublicHttpUrl, SsrfError } from '../agent-readiness/ssrf.js'
import { GeoHealthError } from './errors.js'
import type { GeoHealthStartInput, HealthLanguage } from './types.js'

/** Inputs captured when the check is queued. Pillars read this, not the live form. */
export interface GeoHealthRunInput {
  workspaceId: string
  brandName: string
  siteUrl: string
  industry: string | null
  competitors: string[]
  userQueries: string[]
  language: HealthLanguage
}

function cleanList(values: string[] | undefined, max: number, itemMax: number): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of values ?? []) {
    const text = raw.trim()
    if (!text) continue
    const key = text.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(text.slice(0, itemMax))
    if (out.length >= max) break
  }
  return out
}

/** Shared by a manual start and a saved schedule. The site URL is the public http(s) form. */
export function prepareHealthFields(input: GeoHealthStartInput): {
  brandName: string
  siteUrl: string
  industry: string | null
  competitors: string[]
  userQueries: string[]
  language: HealthLanguage
} {
  const brandName = input.brandName?.trim() ?? ''
  if (!brandName || brandName.length > 80) {
    throw new GeoHealthError('BAD_INPUT', '品牌名需要 1 到 80 个字符')
  }
  const industry = input.industry?.trim() || null
  if (industry && industry.length > 80) {
    throw new GeoHealthError('BAD_INPUT', '行业最长 80 个字符')
  }
  const language = input.language ?? 'auto'
  if (language !== 'zh' && language !== 'en' && language !== 'auto') {
    throw new GeoHealthError('BAD_INPUT', '语言只能是 zh、en 或 auto')
  }
  let siteUrl: string
  try {
    siteUrl = assertPublicHttpUrl(input.siteUrl.trim()).toString()
  } catch (err) {
    if (err instanceof SsrfError) {
      const code = /无效/.test(err.message) ? 'INVALID_URL' : 'SSRF_BLOCKED'
      throw new GeoHealthError(code, err.message)
    }
    throw err
  }
  return {
    brandName,
    siteUrl,
    industry,
    competitors: cleanList(input.competitors, 8, 80),
    userQueries: cleanList(input.queries, 10, 300),
    language,
  }
}
