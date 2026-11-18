const brand = Symbol('geociteops.toolOutput')

export interface ToolOutput {
  readonly brand: typeof brand
  text: string
  data: unknown
  isError?: boolean
}

export function isToolOutput(value: unknown): value is ToolOutput {
  return Boolean(value) && typeof value === 'object' && (value as ToolOutput).brand === brand
}

function render(summary: string, data: unknown, isError?: boolean): ToolOutput {
  return {
    brand,
    isError,
    data,
    text: `${summary.trim()}\n\n${JSON.stringify(data, null, 2)}`,
  }
}

export function ok(summary: string, data: unknown): ToolOutput {
  return render(summary, data)
}

export function fail(summary: string, data: Record<string, unknown> = {}): ToolOutput {
  return render(summary, { error: summary, ...data }, true)
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message
  return 'Unexpected error'
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

export function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

export function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}
