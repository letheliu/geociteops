export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatOptions {
  model?: string
  temperature?: number
  maxTokens?: number
}

export interface ChatResponse {
  text: string
  usage?: { promptTokens?: number; completionTokens?: number }
}

export interface LlmProvider {
  name: string
  chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse>
  embed(text: string): Promise<number[]>
  /** 批量 embedding。实现应优先走模型的原生批量接口以减少网络往返。 */
  embedBatch(texts: string[]): Promise<number[][]>
}
