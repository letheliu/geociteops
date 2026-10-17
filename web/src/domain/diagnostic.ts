export const DIAGNOSTIC_QUERY_TYPE_LABELS: Record<string, string> = {
  BRAND: '品牌问题',
  CATEGORY: '品类问题',
  SCENARIO: '场景问题',
  COMPARISON: '对比问题',
}

export const DIAGNOSTIC_QUERY_TYPE_COLORS: Record<string, string> = {
  BRAND: '#2d8cf0',
  CATEGORY: '#19be6b',
  SCENARIO: '#ff9900',
  COMPARISON: '#ed4014',
}

export const DIAGNOSTIC_RUN_STATUS_LABELS: Record<string, string> = {
  DRAFT: '草稿',
  READY: '就绪',
  RUNNING: '运行中',
  PARTIAL: '部分完成',
  COMPLETED: '已完成',
  FAILED: '失败',
  CANCELLED: '已取消',
}

export const DIAGNOSTIC_RUN_STATUS_COLORS: Record<string, 'default' | 'info' | 'success' | 'warning' | 'error' | 'primary'> = {
  DRAFT: 'default',
  READY: 'info',
  RUNNING: 'warning',
  PARTIAL: 'warning',
  COMPLETED: 'success',
  FAILED: 'error',
  CANCELLED: 'default',
}

export const DIAGNOSTIC_ACTION_HORIZON_LABELS: Record<string, string> = {
  DAYS_30: '30 天内',
  DAYS_60: '60 天内',
  DAYS_90: '90 天内',
}

export const DIAGNOSTIC_FINDING_SEVERITY_COLORS: Record<string, 'default' | 'info' | 'success' | 'warning' | 'error' | 'primary'> = {
  INFO: 'default',
  WARNING: 'warning',
  CRITICAL: 'error',
}

export const DIAGNOSTIC_FINDING_TYPE_LABELS: Record<string, string> = {
  LOW_VISIBILITY: '品牌可见度偏低',
  LOW_SOURCE_CITATION: '来源引用不足',
  LOW_RANK: '推荐排名靠后',
  COMPETITOR_DOMINANCE: '竞品主导',
  QUERY_COVERAGE_GAP: '查询覆盖缺口',
  PLATFORM_GAP: '平台缺口',
  INSUFFICIENT_SAMPLE: '样本不足',
}

export const QUERY_TYPE_SUGGESTED_COUNTS: Record<string, { minimum: number; target: string }> = {
  BRAND: { minimum: 3, target: '品牌能否被基本识别' },
  CATEGORY: { minimum: 5, target: '品牌能否进入品类推荐' },
  SCENARIO: { minimum: 10, target: '真实任务中能否被推荐' },
  COMPARISON: { minimum: 5, target: '与竞品比较时的位置' },
}

export function calculateRequestUnits(queryCount: number, platformCount: number, samplesPerQuery: number): number {
  return queryCount * platformCount * samplesPerQuery
}

export function queryCoverageHint(type: string, count: number): { minimum: number; satisfied: boolean; target: string } | null {
  const info = QUERY_TYPE_SUGGESTED_COUNTS[type]
  if (!info) return null
  return { minimum: info.minimum, satisfied: count >= info.minimum, target: info.target }
}

export function formatMentionRate(rate: number | null, decimals = 1): string {
  if (rate == null) return '—'
  return `${(rate * 100).toFixed(decimals)}%`
}

export function formatAverageRank(rank: number | null): string {
  if (rank == null) return '—'
  return rank.toFixed(1)
}
