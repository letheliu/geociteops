import type { PlatformAdapter, PlatformResult, SourceCitation } from './types.js'
import { fetchWithTimeout } from '../../../core/lib/fetch-with-timeout.js'

/**
 * Perplexity Sonar API adapter。
 * 引用来源：优先 search_results（含 title/url），降级 citations（裸 URL 数组）。
 */
export class PerplexityAdapter implements PlatformAdapter {
  name = 'perplexity'

  async query(text: string, credentials: Record<string, string>): Promise<PlatformResult> {
    const apiKey = credentials.PERPLEXITY_API_KEY
    const baseUrl = credentials.PERPLEXITY_BASE_URL || 'https://api.perplexity.ai'
    const model = credentials.PERPLEXITY_MODEL || 'sonar'

    const res = await fetchWithTimeout(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: text }],
        return_citations: true,
      }),
    })
    if (!res.ok) {
      throw new Error(`perplexity adapter failed: ${res.status} ${await res.text()}`)
    }
    const json = (await res.json()) as {
      choices: { message: { content: string } }[]
      search_results?: Array<{ title?: string; url: string; date?: string }>
      citations?: string[]
    }

    const answer = json.choices[0].message.content

    // 优先 search_results（含 title），降级 citations（裸 URL）
    let sourceCitations: SourceCitation[]
    if (json.search_results && json.search_results.length > 0) {
      sourceCitations = json.search_results.map((s, i) => ({
        url: s.url,
        title: s.title,
        position: i + 1,
        sourceType: 'api_citation' as const,
      }))
    } else if (json.citations && json.citations.length > 0) {
      sourceCitations = json.citations.map((url, i) => ({
        url,
        position: i + 1,
        sourceType: 'api_citation' as const,
      }))
    } else {
      sourceCitations = []
    }

    return {
      answer,
      sourceCitations,
      groundingSources: [],
      answerMentions: [],
      raw: json,
    }
  }
}
