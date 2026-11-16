/**
 * Versioned audit report.
 *
 * Step 2 (one-click GEO health check) should embed this object as
 * `agentReadiness: AgentReadinessReport` instead of flattening checks.
 * Bump `version` if a field changes meaning.
 */
export const AGENT_READINESS_REPORT_VERSION = 1 as const

export type CheckStatus = 'pass' | 'warn' | 'fail'

export type CheckCategory = 'robots' | 'llms' | 'sitemap' | 'page' | 'markdown' | 'access'

export type ReadinessGrade = 'A' | 'B' | 'C' | 'D' | 'F'

export type AgentReadinessStatus = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED'

/** Both languages travel with the report so a later console i18n switch does not re-fetch. */
export interface LocalizedText {
  en: string
  zh: string
}

export interface AgentReadinessCheck {
  id: string
  category: CheckCategory
  title: LocalizedText
  status: CheckStatus
  /** Relative weight. The overall score normalizes across applicable checks. */
  weight: number
  /**
   * When false the check is shown but excluded from the score and the fix list
   * (a dependency was missing, so scoring it would double-count).
   */
  applicable: boolean
  explanation: LocalizedText
  fix: LocalizedText
  verify: LocalizedText
  evidence: Record<string, unknown>
}

export interface AgentReadinessFix {
  checkId: string
  category: CheckCategory
  title: LocalizedText
  status: Exclude<CheckStatus, 'pass'>
  /** weight × (1 − status factor). Higher means fix this first. pass=1, warn=0.5, fail=0. */
  impact: number
  fix: LocalizedText
  verify: LocalizedText
}

export interface AgentReadinessCategoryScore {
  id: CheckCategory
  label: LocalizedText
  score: number
  status: CheckStatus
}

export interface AgentReadinessReport {
  version: typeof AGENT_READINESS_REPORT_VERSION
  url: string
  finalUrl: string
  fetchedAt: string
  durationMs: number
  score: number
  grade: ReadinessGrade
  summary: LocalizedText
  checks: AgentReadinessCheck[]
  /** Warn/fail checks, applicable only, sorted by impact descending. */
  fixes: AgentReadinessFix[]
  categories: AgentReadinessCategoryScore[]
}

export interface AgentReadinessAuditSummary {
  id: string
  url: string
  status: AgentReadinessStatus
  score: number | null
  grade: ReadinessGrade | null
  error: string | null
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
}

export interface AgentReadinessAuditDetail extends AgentReadinessAuditSummary {
  report: AgentReadinessReport | null
}

export function tx(en: string, zh: string): LocalizedText {
  return { en, zh }
}

export function asEvidence(value: object): Record<string, unknown> {
  return value as Record<string, unknown>
}
