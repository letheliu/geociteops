export type AgentReadinessErrorCode = 'INVALID_URL' | 'SSRF_BLOCKED' | 'NOT_FOUND' | 'QUEUE_UNAVAILABLE'

export class AgentReadinessError extends Error {
  constructor(public code: AgentReadinessErrorCode, message: string) {
    super(message)
    this.name = 'AgentReadinessError'
  }
}
