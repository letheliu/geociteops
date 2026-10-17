import type { PlatformAdapter, PlatformResult, SourceCitation } from './types.js'

const URL_REGEX = /https?:\/\/[^\s)]+/gi

export class ErnieAdapter implements PlatformAdapter {
  name = 'ernie'

  async query(text: string, credentials: Record<string, string>): Promise<PlatformResult> {
    const apiKey = credentials.ERNIE_API_KEY
    const secretKey = credentials.ERNIE_SECRET_KEY
    const model = credentials.ERNIE_MODEL || 'ernie-speed-128k'

    const tokenRes = await fetch(
      `https://aip.baidubce.com/oauth/2.0/token?grant_type=client_credentials&client_id=${apiKey}&client_secret=${secretKey}`,
      { method: 'POST' }
    )
    if (!tokenRes.ok) {
      throw new Error(`Ernie token failed: ${tokenRes.status}`)
    }
    const tokenJson = (await tokenRes.json()) as { access_token: string }

    const res = await fetch(
      `https://aip.baidubce.com/rpc/2.0/ai_custom/v1/wenxinworkshop/chat/${model}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          temperature: 0,
          messages: [{ role: 'user', content: text }],
        }),
      }
    )
    if (!res.ok) {
      throw new Error(`Ernie adapter failed: ${res.status} ${res.statusText}`)
    }
    const json = (await res.json()) as { result: string }
    const answer = json.result
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
