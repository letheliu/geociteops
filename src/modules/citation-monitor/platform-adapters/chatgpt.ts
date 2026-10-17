import type { PlatformAdapter, PlatformResult, SourceCitation } from './types.js'

const URL_REGEX = /https?:\/\/[^\s)]+/gi

/**
 * ChatGPT Search adapter（走 OpenAI 兼容 /chat/completions）。
 * 引用提取双重兜底：annotations[].url_citation.url（结构化）→ 答案正文正则提 URL。
 */
export class ChatGptSearchAdapter implements PlatformAdapter {
  name = 'chatgpt'

  async query(text: string, credentials: Record<string, string>): Promise<PlatformResult> {
    const apiKey = credentials.OPENAI_API_KEY
    const baseUrl = credentials.OPENAI_BASE_URL || 'https://api.openai.com/v1'
    const model = credentials.OPENAI_SEARCH_MODEL || 'gpt-4o-search-preview'

    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: text }],
        web_search_options: {},
      }),
    })
    if (!res.ok) {
      throw new Error(`chatgpt adapter failed: ${res.status} ${await res.text()}`)
    }
    const json = (await res.json()) as {
      choices: Array<{
        message: {
          content: string
          annotations?: Array<{ type?: string; url_citation?: { url: string; title?: string } }>
        }
      }>
    }

    const message = json.choices[0].message
    const answer = message.content
    const annotations = message.annotations ?? []

    // 优先 annotations（结构化），降级答案正文正则
    let sourceCitations: SourceCitation[]
    if (annotations.length > 0) {
      sourceCitations = annotations
        .filter((a) => a.url_citation?.url)
        .map((a, i) => ({
          url: a.url_citation!.url,
          title: a.url_citation?.title,
          position: i + 1,
          sourceType: 'api_citation' as const,
        }))
    } else {
      const matches = [...answer.matchAll(URL_REGEX)]
      sourceCitations = matches.map((m, i) => ({
        url: m[0],
        position: i + 1,
        sourceType: 'answer_url' as const,
      }))
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
