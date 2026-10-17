import type { LlmProvider } from './types.js'
import { OpenAiProvider } from './openai-provider.js'

let provider: LlmProvider | null = null

export function getLlmProvider(): LlmProvider {
  if (!provider) {
    provider = new OpenAiProvider()
  }
  return provider
}

export function setLlmProvider(p: LlmProvider): void {
  provider = p
}

export type { LlmProvider, ChatMessage, ChatOptions, ChatResponse } from './types.js'
