import type { PlatformAdapter, PlatformResult, SourceCitation } from './types.js'

const URL_REGEX = /https?:\/\/[^\s)]+/gi

export class QwenAdapter implements PlatformAdapter {
  name = 'qwen'

  async query(text: string, credentials: Record<string, string>): Promise<PlatformResult> {
    const apiKey = credentials.QWEN_API_KEY
    const baseUrl = credentials.QWEN_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1'
    const model = credentials.QWEN_MODEL || 'qwen-turbo'

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
      throw new Error(`Qwen adapter failed: ${res.status} ${res.statusText}`)
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
