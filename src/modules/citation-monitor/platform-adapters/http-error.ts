/**
 * Adapter failures carry `status` so diagnostic sampling can classify
 * 401/403 as configuration and 429 as rate limit (`classifySampleError`).
 */

export function missingCredential(platform: string, key: string): never {
  const err = new Error(`${platform} adapter: missing ${key}`) as Error & { status: number }
  err.status = 401
  throw err
}

export function httpStatusError(platform: string, status: number, body: string): never {
  const err = new Error(`${platform} adapter failed: ${status} ${body}`) as Error & { status: number }
  err.status = status
  throw err
}
