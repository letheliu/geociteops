/**
 * Versioned one-click GEO health report.
 *
 * `pillars.agentReadiness.report` is the AgentReadinessReport object from the
 * readiness audit (version 1). Do not flatten those checks into a second shape.
 * Bump `version` if a field changes meaning.
 */
import type { AgentReadinessReport, CheckStatus, LocalizedText, ReadinessGrade } from '../agent-readiness/types.js'

export const GEO_HEALTH_REPORT_VERSION = 1 as const

export type { LocalizedText, ReadinessGrade }

export type GeoHealthStatus = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'PARTIAL' | 'FAILED'

export type PillarId = 'agentReadiness' | 'citations' | 'citability' | 'structuredSignals'

export const PILLAR_IDS: PillarId[] = ['agentReadiness', 'citations', 'citability', 'structuredSignals']

export type PillarRunStatus = 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'SKIPPED' | 'FAILED'

export type QueryKind = 'brand' | 'category' | 'comparison' | 'custom'

export type QueryLanguage = 'zh' | 'en'

export type HealthLanguage = QueryLanguage | 'auto'

export type QuerySourceKind = 'user' | 'llm' | 'template'

export type ImpactLevel = 'high' | 'medium' | 'low'

export type EffortLevel = 1 | 2 | 3

export interface PillarProgress {
  status: PillarRunStatus
  error: string | null
  startedAt: string | null
  finishedAt: string | null
}

export interface GeoHealthProgress {
  percent: number
  pillars: Record<PillarId, PillarProgress>
}

export interface HealthQuery {
  text: string
  kind: QueryKind
  language: QueryLanguage
  source: QuerySourceKind
}

export interface QueryRollup extends HealthQuery {
  samples: number
  mentions: number
  citations: number
  meanRank: number | null
}

export interface EngineSkip {
  platform: string
  reason: LocalizedText
}

export interface SampleCompetitor {
  brand: string
  mentioned: boolean
  rank: number | null
  /** Exact-name share of this answer. 0 when nobody tracked was named. */
  shareOfVoice: number
}

export interface CitationSample {
  platform: string
  query: string
  ok: boolean
  error: string | null
  brandMentioned: boolean
  brandCited: boolean
  rankInAnswer: number | null
  /** Exact-name share of voice for the brand on this answer. */
  sovScore: number
  citedUrls: string[]
  competitors: SampleCompetitor[]
}

export interface CompetitorSov {
  brand: string
  mentionRate: number
  /** Mean exact-name share of voice across answers that returned. */
  shareOfVoice: number
}

export interface CitationPillar {
  status: PillarRunStatus
  score: number | null
  queries: QueryRollup[]
  querySource: QuerySourceKind | 'mixed'
  enginesRun: string[]
  enginesSkipped: EngineSkip[]
  /** Null when no engine returned an answer. */
  mentionRate: number | null
  citationRate: number | null
  meanRank: number | null
  shareOfVoice: number | null
  citedUrls: string[]
  brandCitedUrls: string[]
  competitorSov: CompetitorSov[]
  samples: CitationSample[]
  note: LocalizedText | null
  error: string | null
}

export type AtomGap = 'numeric' | 'entity' | 'selfContained' | 'definition'

export interface WeakAtom {
  text: string
  score: number
  missing: AtomGap[]
}

export interface PageCitability {
  url: string
  title: string
  atomScore: number
  citabilityScore: number
  composite: number
  weakestAtoms: WeakAtom[]
  fetchError: string | null
}

export interface CitabilityPillar {
  status: PillarRunStatus
  score: number | null
  pages: PageCitability[]
  /** Lowest composite first, at most three pages that actually scored. */
  weakestPages: PageCitability[]
  note: LocalizedText | null
  error: string | null
}

export type SignalCheckStatus = CheckStatus | 'unknown'

export interface StructuredSignalsPillar {
  status: PillarRunStatus
  score: number | null
  schemaTypes: string[]
  jsonLdPresent: boolean
  llmsTxtStatus: SignalCheckStatus
  llmsFullStatus: SignalCheckStatus
  /** Built with the llms.txt generator. Empty only when generation itself failed. */
  generatedLlmsTxt: string
  /** Organization + WebSite JSON-LD from the schema generator. */
  generatedJsonLd: string
  note: LocalizedText | null
  error: string | null
}

export interface AgentReadinessPillar {
  status: PillarRunStatus
  score: number | null
  report: AgentReadinessReport | null
  error: string | null
}

export interface GeoHealthWeighting {
  /** Documented nominal weights. They sum to 1. */
  nominal: Record<PillarId, number>
  /** Weights actually used after dropping pillars that have no score. They sum to 1, or to 0 when nothing scored. */
  applied: Record<PillarId, number>
  notes: LocalizedText
}

export interface GeoHealthAction {
  id: string
  pillar: PillarId
  title: LocalizedText
  impact: ImpactLevel
  effort: EffortLevel
  effortLabel: LocalizedText
  fix: LocalizedText
  verify: LocalizedText
  /** A citation query the user can run again after the fix. Null when the fix is not query-shaped. */
  verifyQuery: string | null
}

export interface GeoHealthReport {
  version: typeof GEO_HEALTH_REPORT_VERSION
  brandName: string
  siteUrl: string
  industry: string | null
  competitors: string[]
  language: HealthLanguage
  resolvedLanguage: QueryLanguage
  score: number
  grade: ReadinessGrade
  weighting: GeoHealthWeighting
  summary: LocalizedText
  pillars: {
    agentReadiness: AgentReadinessPillar
    citations: CitationPillar
    citability: CitabilityPillar
    structuredSignals: StructuredSignalsPillar
  }
  /** At most ten, impact descending, then effort ascending. */
  actions: GeoHealthAction[]
  generatedAt: string
}

export interface GeoHealthCheckSummary {
  id: string
  brandName: string
  siteUrl: string
  status: GeoHealthStatus
  score: number | null
  grade: ReadinessGrade | null
  error: string | null
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
}

export interface GeoHealthCheckDetail extends GeoHealthCheckSummary {
  industry: string | null
  competitors: string[]
  userQueries: string[]
  language: HealthLanguage
  progress: GeoHealthProgress
  report: GeoHealthReport | null
}

export interface GeoHealthStartInput {
  brandName: string
  siteUrl: string
  industry?: string | null
  competitors?: string[]
  queries?: string[]
  language?: HealthLanguage
}

export const PILLAR_LABEL: Record<PillarId, LocalizedText> = {
  agentReadiness: { en: 'Agent readiness', zh: 'Agent 就绪' },
  citations: { en: 'AI citation snapshot', zh: 'AI 引用快照' },
  citability: { en: 'Content citability', zh: '内容可引用性' },
  structuredSignals: { en: 'Structured signals', zh: '结构化信号' },
}
