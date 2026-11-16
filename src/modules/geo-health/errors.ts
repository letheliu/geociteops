export type GeoHealthErrorCode = 'INVALID_URL' | 'SSRF_BLOCKED' | 'NOT_FOUND' | 'QUEUE_UNAVAILABLE' | 'NOT_READY' | 'BAD_INPUT'

export class GeoHealthError extends Error {
  constructor(public code: GeoHealthErrorCode, message: string) {
    super(message)
    this.name = 'GeoHealthError'
  }
}

/** Short, secret-free message safe to store on a report. */
export function publicError(err: unknown): string {
  const message = err instanceof Error ? err.message : '未知错误'
  const cleaned = message
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, '[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]')
    .replace(/(api[_-]?key|secret|token)\s*[:=]\s*\S+/gi, '$1=[redacted]')
  return cleaned.length > 500 ? cleaned.slice(0, 500) : cleaned
}
