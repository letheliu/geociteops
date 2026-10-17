import type { PlatformAdapter, PlatformResult, SourceCitation } from './types.js'

const URL_REGEX = /https?:\/\/[^\s)]+/gi

export class AnthropicAdapter implements PlatformAdapter {
  name = 'anthropic'

  async query(text: string, credentials: Record<string, string>): Promise<PlatformResult> {
    const apiKey = credentials.ANTHROPIC_API_KEY
    const baseUrl = credentials.ANTHROPIC_BASE_URL || 'https://api.anthropic.com'
    const model = credentials.ANTHROPIC_MODEL || 'claude-3-5-sonnet-20241022'

    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        messages: [{ role: 'user', content: text }],
      }),
    })
    if (!res.ok) {
      throw new Error(`Anthropic adapter failed: ${res.status} ${await res.text()}`)
    }
    const json = (await res.json()) as {
      content: { type: string; text: string }[]
    }
    const answer = json.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('')

    const matches = [...answer.matchAll(URL_REGEX)]
    const sourceCitations: SourceCitation[] = matches.map((m, i) => ({
      url: m[0],
      position: i + 1,
      sourceType: 'answer_url' as const,
    }))

    return {
      answer,
      sourceCitations,
      groundingSources: [],
      answerMentions: [],
      raw: json,
    }
  }
}
