import type { PlatformAdapter, PlatformResult, SourceCitation } from './types.js'
import { fetchWithTimeout } from '../../../core/lib/fetch-with-timeout.js'
import { DEMO_OUTBOUND_BLOCKED } from '../../../core/demo/blocked-llm.js'
import { isDemoMode } from '../../../core/demo/mode.js'
import { httpStatusError, missingCredential } from './http-error.js'

const URL_REGEX = /https?:\/\/[^\s)]+/gi

/**
 * 腾讯元宝 adapter. The engine id is `yuanbao`. The HTTP call is Tencent's
 * official Hunyuan OpenAI-compatible API, not the Yuanbao consumer app
 * (yuanbao.tencent.com has no public API for this).
 *
 * Endpoint (cloud.tencent.com/document/product/1729/111007, updated 2026-04-27):
 * `POST https://api.hunyuan.cloud.tencent.com/v1/chat/completions`
 * Auth: `Authorization: Bearer $HUNYUAN_API_KEY`
 * Sample model: `hunyuan-turbos-latest`. `hunyuan-lite` ignores search enhancement.
 *
 * Search is off unless requested. This adapter sends `enable_enhancement`,
 * `search_info`, and `citation` (all true). When a search hits, the body
 * includes `search_info.search_results[]` with `index`, `title`, `url`
 * (native SDK names are `SearchInfo.SearchResults[].Url`). `citation` asks
 * the answer to mark those links. The native field `Text` is the site name.
 *
 * Hunyuan's own notice: new model purchases are moving to TokenHub. Keys
 * already issued on this endpoint keep working. Default concurrency is 5,
 * shared by the account. Do not send `temperature` (citation sampling contract).
 */
export class YuanbaoAdapter implements PlatformAdapter {
  name = 'yuanbao'

  async query(text: string, credentials: Record<string, string>): Promise<PlatformResult> {
    if (isDemoMode()) throw new Error(DEMO_OUTBOUND_BLOCKED)

    const apiKey = credentials.HUNYUAN_API_KEY
    if (!apiKey) missingCredential('yuanbao', 'HUNYUAN_API_KEY')

    const baseUrl = (credentials.HUNYUAN_BASE_URL || 'https://api.hunyuan.cloud.tencent.com/v1').replace(/\/$/, '')
    const model = credentials.HUNYUAN_MODEL || 'hunyuan-turbos-latest'

    const res = await fetchWithTimeout(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: text }],
        enable_enhancement: true,
        search_info: true,
        citation: true,
      }),
    })
    if (!res.ok) httpStatusError('yuanbao', res.status, await res.text())

    const json = (await res.json()) as HunyuanBody
    if (!Array.isArray(json.choices) || json.choices.length === 0) {
      throw new Error('yuanbao adapter: invalid response')
    }
    const answer = json.choices[0]?.message?.content ?? ''
    return {
      answer,
      sourceCitations: citationsFromHunyuan(json, answer),
      groundingSources: [],
      answerMentions: [],
      raw: json,
    }
  }
}

interface SearchHit {
  index?: number
  Index?: number
  title?: string
  Title?: string
  url?: string
  Url?: string
  text?: string
  Text?: string
}

interface HunyuanBody {
  choices?: Array<{ message?: { content?: string } }>
  search_info?: { search_results?: SearchHit[] }
  SearchInfo?: { SearchResults?: SearchHit[] }
}

function citationsFromHunyuan(json: HunyuanBody, answer: string): SourceCitation[] {
  const hits = json.search_info?.search_results ?? json.SearchInfo?.SearchResults ?? []
  const seen = new Set<string>()
  const citations: SourceCitation[] = []
  for (const hit of hits) {
    const url = (hit.url ?? hit.Url ?? '').trim()
    if (!url || seen.has(url)) continue
    seen.add(url)
    const index = hit.index ?? hit.Index
    const siteName = hit.text ?? hit.Text
    citations.push({
      url,
      title: (hit.title ?? hit.Title) || undefined,
      position: typeof index === 'number' && index > 0 ? index : citations.length + 1,
      sourceType: 'api_citation',
      providerMetadata: siteName ? { siteName } : undefined,
    })
  }
  if (citations.length > 0) return citations

  return [...answer.matchAll(URL_REGEX)].map((match, index) => ({
    url: match[0],
    position: index + 1,
    sourceType: 'answer_url' as const,
  }))
}
