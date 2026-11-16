import {
  tx,
  type AgentReadinessCategoryScore,
  type AgentReadinessCheck,
  type AgentReadinessFix,
  type AgentReadinessReport,
  type CheckCategory,
  type CheckStatus,
  type ReadinessGrade,
} from './types.js'
import { AGENT_READINESS_REPORT_VERSION } from './types.js'

const CATEGORIES: { id: CheckCategory; label: ReturnType<typeof tx> }[] = [
  { id: 'access', label: tx('Access', '可访问性') },
  { id: 'robots', label: tx('Crawlers', '爬虫协议') },
  { id: 'llms', label: tx('llms.txt', 'llms.txt') },
  { id: 'sitemap', label: tx('Sitemap', '站点地图') },
  { id: 'page', label: tx('Page signals', '页面信号') },
  { id: 'markdown', label: tx('Markdown', 'Markdown') },
]

export function statusFactor(status: CheckStatus): number {
  if (status === 'pass') return 1
  if (status === 'warn') return 0.5
  return 0
}

export function gradeFor(score: number): ReadinessGrade {
  if (score >= 90) return 'A'
  if (score >= 75) return 'B'
  if (score >= 60) return 'C'
  if (score >= 40) return 'D'
  return 'F'
}

export function scoreChecks(checks: AgentReadinessCheck[]): number {
  const applicable = checks.filter((c) => c.applicable)
  const max = applicable.reduce((sum, c) => sum + c.weight, 0)
  if (max <= 0) return 0
  const earned = applicable.reduce((sum, c) => sum + c.weight * statusFactor(c.status), 0)
  return Math.round((100 * earned) / max)
}

export function categoryScores(checks: AgentReadinessCheck[]): AgentReadinessCategoryScore[] {
  return CATEGORIES.map((category) => {
    const mine = checks.filter((c) => c.category === category.id)
    const applicable = mine.filter((c) => c.applicable)
    let status: CheckStatus = 'pass'
    if (applicable.some((c) => c.status === 'fail')) status = 'fail'
    else if (applicable.some((c) => c.status === 'warn')) status = 'warn'
    else if (applicable.length === 0) status = 'warn'
    return {
      id: category.id,
      label: category.label,
      score: scoreChecks(applicable),
      status,
    }
  })
}

export function prioritizeFixes(checks: AgentReadinessCheck[]): AgentReadinessFix[] {
  return checks
    .filter((c): c is AgentReadinessCheck & { status: 'warn' | 'fail' } => c.applicable && c.status !== 'pass')
    .map((c) => ({
      checkId: c.id,
      category: c.category,
      title: c.title,
      status: c.status,
      impact: Math.round(c.weight * (1 - statusFactor(c.status)) * 10) / 10,
      fix: c.fix,
      verify: c.verify,
    }))
    .sort((a, b) => b.impact - a.impact || a.checkId.localeCompare(b.checkId))
}

export function buildReport(input: {
  url: string
  finalUrl: string
  fetchedAt: string
  durationMs: number
  checks: AgentReadinessCheck[]
}): AgentReadinessReport {
  const score = scoreChecks(input.checks)
  const grade = gradeFor(score)
  const fixes = prioritizeFixes(input.checks)
  const failCount = fixes.filter((f) => f.status === 'fail').length
  const warnCount = fixes.filter((f) => f.status === 'warn').length
  return {
    version: AGENT_READINESS_REPORT_VERSION,
    url: input.url,
    finalUrl: input.finalUrl,
    fetchedAt: input.fetchedAt,
    durationMs: input.durationMs,
    score,
    grade,
    summary: tx(
      `Score ${score} (${grade}). ${failCount} failing check(s), ${warnCount} warning(s). Fix the list from the top — impact is weight times how far the check is from a pass.`,
      `得分 ${score}（${grade}）。${failCount} 项未通过，${warnCount} 项警告。按列表从上往下修：影响度 = 权重 × 离通过还差多少。`,
    ),
    checks: input.checks,
    fixes,
    categories: categoryScores(input.checks),
  }
}
