import type { PlatformAdapter, PlatformResult, SourceCitation } from './types.js'

/**
 * Google Gemini adapter（Generative Language API）。
 * 启用 google_search_retrieval grounding，引用来自 groundingMetadata.groundingChunks[].web。
 */
export class GeminiAdapter implements PlatformAdapter {
  name = 'gemini'

  async query(text: string, credentials: Record<string, string>): Promise<PlatformResult> {
    const apiKey = credentials.GEMINI_API_KEY
    const model = credentials.GEMINI_MODEL || 'gemini-2.0-flash'
    const baseUrl = credentials.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta'

    const url = `${baseUrl}/models/${model}:generateContent?key=${apiKey}`
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text }] }],
        tools: [{ google_search_retrieval: {} }],
      }),
    })
    if (!res.ok) {
      throw new Error(`gemini adapter failed: ${res.status} ${await res.text()}`)
    }
    const json = (await res.json()) as {
      candidates: Array<{
        content: { parts: Array<{ text?: string }> }
        groundingMetadata?: {
          groundingChunks?: Array<{ web?: { uri: string; title?: string } }>
        }
      }>
    }

    const candidate = json.candidates?.[0]
    // 拼接所有 text part
    const answer = (candidate?.content?.parts ?? [])
      .map((p) => p.text ?? '')
      .join('')

    const chunks = candidate?.groundingMetadata?.groundingChunks ?? []
    const sourceCitations: SourceCitation[] = chunks
      .filter((c) => c.web?.uri)
      .map((c, i) => ({
        url: c.web!.uri,
        title: c.web?.title,
        position: i + 1,
        sourceType: 'grounding' as const,
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
