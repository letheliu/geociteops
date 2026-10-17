import type { ChatMessage, ChatOptions, ChatResponse, LlmProvider } from './types.js'

export class OpenAiProvider implements LlmProvider {
  name = 'openai'
  private apiKey = process.env.OPENAI_API_KEY!
  private baseUrl = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'
  private chatModel = process.env.CHAT_MODEL || 'gpt-4o-mini'
  private embeddingModel = process.env.EMBEDDING_MODEL || 'text-embedding-3-small'

  async chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse> {
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: options?.model || this.chatModel,
        temperature: options?.temperature ?? 0,
        max_tokens: options?.maxTokens,
        messages,
      }),
    })
    if (!res.ok) {
      throw new Error(`OpenAI chat failed: ${res.status} ${await res.text()}`)
    }
    const json = (await res.json()) as {
      choices: { message: { content: string } }[]
      usage?: { prompt_tokens?: number; completion_tokens?: number }
    }
    return {
      text: json.choices[0].message.content,
      usage: {
        promptTokens: json.usage?.prompt_tokens,
        completionTokens: json.usage?.completion_tokens,
      },
    }
  }

  async embed(text: string): Promise<number[]> {
    const res = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model: this.embeddingModel, input: text }),
    })
    if (!res.ok) {
      throw new Error(`OpenAI embed failed: ${res.status} ${await res.text()}`)
    }
    const json = (await res.json()) as { data: { embedding: number[] }[] }
    return json.data[0].embedding
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return []
    const res = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model: this.embeddingModel, input: texts }),
    })
    if (!res.ok) {
      throw new Error(`OpenAI embedBatch failed: ${res.status} ${await res.text()}`)
    }
    const json = (await res.json()) as { data: { embedding: number[] }[] }
    // OpenAI 兼容协议保证返回顺序与输入顺序一致
    return json.data.map((d) => d.embedding)
  }
}
