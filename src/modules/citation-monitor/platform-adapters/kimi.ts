import type { PlatformAdapter, PlatformResult, SourceCitation } from './types.js'
import { fetchWithTimeout } from '../../../core/lib/fetch-with-timeout.js'
import { DEMO_OUTBOUND_BLOCKED } from '../../../core/demo/blocked-llm.js'
import { isDemoMode } from '../../../core/demo/mode.js'
import { httpStatusError, missingCredential } from './http-error.js'

const URL_REGEX = /https?:\/\/[^\s)]+/gi

/**
 * Kimi（月之暗面 Moonshot）adapter.
 *
 * Official OpenAI-compatible host: `https://api.moonshot.cn/v1`.
 * Auth header: `Authorization: Bearer $MOONSHOT_API_KEY`.
 * Model list (platform.kimi.com/docs/models, checked 2026-11-24): `kimi-k3`,
 * `kimi-k3.1-pro`, `kimi-k3.1-pro-highspeed`. Default here is `kimi-k3`.
 * The Responses web-search sample in the docs uses `kimi-k3.1-pro`; set
 * `MOONSHOT_MODEL` to switch. moonshot-v1 and the kimi-k2 preview ids are offline.
 *
 * `$web_search` (`builtin_function` on `/chat/completions`) is not the current
 * protocol. K3 does not accept it, and Formula `moonshot/web-search:latest`
 * returns `encrypted_output`, which does not expose cited URLs.
 * This adapter calls `POST /v1/responses` with `tools: [{ type: "web_search" }]`
 * and `include: ["web_search_call.action.sources"]`. The server searches when
 * it decides a search is needed. Sources are `{ type: "url", url, title }`.
 * Docs: https://platform.kimi.com/docs/api/responses
 * Search that actually runs is billed per call (docs: ¥0.03) plus model tokens.
 */
export class KimiAdapter implements PlatformAdapter {
  name = 'kimi'

  async query(text: string, credentials: Record<string, string>): Promise<PlatformResult> {
    if (isDemoMode()) throw new Error(DEMO_OUTBOUND_BLOCKED)

    const apiKey = credentials.MOONSHOT_API_KEY
    if (!apiKey) missingCredential('kimi', 'MOONSHOT_API_KEY')

    const baseUrl = (credentials.MOONSHOT_BASE_URL || 'https://api.moonshot.cn/v1').replace(/\/$/, '')
    const model = credentials.MOONSHOT_MODEL || 'kimi-k3'

    const res = await fetchWithTimeout(`${baseUrl}/responses`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        input: text,
        tools: [{ type: 'web_search' }],
        include: ['web_search_call.action.sources'],
      }),
    })
    if (!res.ok) httpStatusError('kimi', res.status, await res.text())

    const json = (await res.json()) as ResponsesBody
    if (typeof json.output_text !== 'string' && !Array.isArray(json.output)) {
      throw new Error('kimi adapter: invalid response')
    }
    const answer = answerFromResponses(json)
    return {
      answer,
      sourceCitations: citationsFromResponses(json, answer),
      groundingSources: [],
      answerMentions: [],
      raw: json,
    }
  }
}

interface WebSearchSource {
  type?: string
  url?: string
  title?: string
}

interface ResponsesBody {
  output_text?: string
  output?: Array<{
    type?: string
    content?: Array<{ type?: string; text?: string }>
    action?: { sources?: WebSearchSource[] }
  }>
}

function answerFromResponses(json: ResponsesBody): string {
  if (typeof json.output_text === 'string' && json.output_text.length > 0) return json.output_text
  const parts: string[] = []
  for (const item of json.output ?? []) {
    if (item.type !== 'message' || !Array.isArray(item.content)) continue
    for (const part of item.content) {
      if (typeof part.text === 'string' && part.text.length > 0) parts.push(part.text)
    }
  }
  return parts.join('')
}

function citationsFromResponses(json: ResponsesBody, answer: string): SourceCitation[] {
  const seen = new Set<string>()
  const citations: SourceCitation[] = []
  for (const item of json.output ?? []) {
    if (item.type !== 'web_search_call') continue
    for (const source of item.action?.sources ?? []) {
      const url = source.url?.trim()
      if (!url || seen.has(url)) continue
      seen.add(url)
      citations.push({
        url,
        title: source.title || undefined,
        position: citations.length + 1,
        sourceType: 'api_citation',
      })
    }
  }
  if (citations.length > 0) return citations

  return [...answer.matchAll(URL_REGEX)].map((match, index) => ({
    url: match[0],
    position: index + 1,
    sourceType: 'answer_url' as const,
  }))
}
