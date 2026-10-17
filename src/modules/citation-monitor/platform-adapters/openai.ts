import type { PlatformAdapter, PlatformResult, SourceCitation } from './types.js'

const URL_REGEX = /https?:\/\/[^\s)]+/gi

export class OpenAiAdapter implements PlatformAdapter {
  name = 'openai'

  async query(text: string, credentials: Record<string, string>): Promise<PlatformResult> {
    const apiKey = credentials.OPENAI_API_KEY
    const baseUrl = credentials.OPENAI_BASE_URL || 'https://api.openai.com/v1'
    const model = credentials.OPENAI_MODEL || 'gpt-4o-mini'

    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        messages: [
          { role: 'system', content: '你是一个客观的助手，请直接回答用户问题。' },
          { role: 'user', content: text },
        ],
      }),
    })
    if (!res.ok) {
      throw new Error(`OpenAI adapter failed: ${res.status} ${await res.text()}`)
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
