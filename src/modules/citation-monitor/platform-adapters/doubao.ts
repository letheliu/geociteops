import type { PlatformAdapter, PlatformResult, SourceCitation } from './types.js'

const URL_REGEX = /https?:\/\/[^\s)]+/gi

export class DoubaoAdapter implements PlatformAdapter {
  name = 'doubao'

  async query(text: string, credentials: Record<string, string>): Promise<PlatformResult> {
    const apiKey = credentials.DOUBAO_API_KEY
    const baseUrl = credentials.DOUBAO_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3'
    const model = credentials.DOUBAO_MODEL || 'doubao-pro-4k'

    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        messages: [{ role: 'user', content: text }],
      }),
    })
    if (!res.ok) {
      throw new Error(`Doubao adapter failed: ${res.status} ${res.statusText}`)
    }
    const json = (await res.json()) as {
      choices: { message: { content: string } }[]
    }
    const answer = json.choices[0].message.content
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
