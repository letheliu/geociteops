export interface Clocks {
  now: () => number
  sleep: (ms: number) => Promise<void>
}

export const realClocks: Clocks = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}

export interface PollOptions<T> {
  timeoutMs: number
  intervalMs?: number
  clocks?: Clocks
  signal?: AbortSignal
  isDone: (value: T) => boolean
  fetch: () => Promise<T>
  onTick?: (value: T) => Promise<void>
}

export async function pollUntil<T>(options: PollOptions<T>): Promise<{ value: T; timedOut: boolean }> {
  const clocks = options.clocks ?? realClocks
  const interval = options.intervalMs ?? 2_000
  const start = clocks.now()
  let value = await options.fetch()
  await options.onTick?.(value)

  while (!options.isDone(value)) {
    if (options.signal?.aborted) {
      const err = new Error('Cancelled')
      err.name = 'AbortError'
      throw err
    }
    const elapsed = clocks.now() - start
    if (elapsed >= options.timeoutMs) return { value, timedOut: true }
    await clocks.sleep(Math.min(interval, options.timeoutMs - elapsed))
    if (options.signal?.aborted) {
      const err = new Error('Cancelled')
      err.name = 'AbortError'
      throw err
    }
    if (clocks.now() - start >= options.timeoutMs) return { value, timedOut: true }
    value = await options.fetch()
    await options.onTick?.(value)
  }

  return { value, timedOut: false }
}
