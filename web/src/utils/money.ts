/**
 * 金额展示工具（任务 14）：后端金额一律整数分（CNY），前端展示转元、保留两位小数。
 * null/undefined/非有限数返回 '—'（折扣/退款等可空金额的占位）。
 */
export function formatCents(cents: number | null | undefined): string {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return '—'
  return (cents / 100).toFixed(2)
}
