import type { ChatMessage, ChatOptions, ChatResponse, LlmProvider } from '../llm/types.js'

export const DEMO_OUTBOUND_BLOCKED = 'DEMO_MODE blocks outbound LLM calls'

/**
 * Stand-in provider used when `DEMO_MODE` is on. It never opens a socket.
 * Callers that expected a model answer get a thrown error instead of a bill.
 */
export function createDemoBlockedLlm(): LlmProvider {
  const fail = async (): Promise<never> => {
    throw new Error(DEMO_OUTBOUND_BLOCKED)
  }
  return {
    name: 'demo-blocked',
    chat(_messages: ChatMessage[], _options?: ChatOptions): Promise<ChatResponse> {
      return fail()
    },
    embed(_text: string): Promise<number[]> {
      return fail()
    },
    embedBatch(_texts: string[]): Promise<number[][]> {
      return fail()
    },
  }
}
