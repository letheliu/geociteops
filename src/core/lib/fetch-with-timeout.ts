/**
 * 带超时的 fetch（规格 §6）：平台调用是 Run 的成本大头，必须能被 deadline 掐断，
 * 否则一个挂起的请求会把整轮采样拖过采集窗口。
 */

/** 默认 30s；可用环境变量 CITATION_FETCH_TIMEOUT_MS 覆盖 */
export const DEFAULT_FETCH_TIMEOUT_MS = 30_000

/** 超时抛出的错误类型——与普通网络错误区分，便于 Monitor 归类 failureReason */
export class TimeoutError extends Error {
  constructor(url: string, timeoutMs: number) {
    super(`Fetch timeout after ${timeoutMs}ms: ${url}`)
    this.name = 'TimeoutError'
  }
}

/** 环境变量在每次调用时读取（而非模块加载时），便于测试与运行时改配置 */
function resolveTimeout(explicit?: number): number {
  if (explicit !== undefined) return explicit
  const env = process.env.CITATION_FETCH_TIMEOUT_MS
  const parsed = env ? Number(env) : NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_FETCH_TIMEOUT_MS
}

/**
 * 与 fetch 同签名，额外支持超时（AbortController 实现）。
 *
 * 超时与调用方传入的 signal 都会真正 abort 底层请求——不是"等它自己返回"。
 * 只有**我们自己触发的超时**报 TimeoutError；调用方取消与真实网络错误原样透传。
 */
export async function fetchWithTimeout(
  url: string,
  init?: RequestInit,
  timeoutMs?: number,
): Promise<Response> {
  const timeout = resolveTimeout(timeoutMs)
  const controller = new AbortController()
  let timedOut = false

  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeout)

  // 调用方的取消信号透传到我们的 controller：外层取消 → 底层请求也停
  const outerSignal = init?.signal
  if (outerSignal) {
    if (outerSignal.aborted) controller.abort()
    else outerSignal.addEventListener('abort', () => controller.abort(), { once: true })
  }

  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } catch (err) {
    if (timedOut) throw new TimeoutError(url, timeout)
    throw err
  } finally {
    clearTimeout(timer)
  }
}
