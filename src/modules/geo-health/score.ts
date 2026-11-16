import { gradeFor } from '../agent-readiness/score.js'
import type { CheckStatus } from '../agent-readiness/types.js'
import { tx } from '../agent-readiness/types.js'
import type {
  EffortLevel,
  GeoHealthProgress,
  GeoHealthStatus,
  ImpactLevel,
  PillarId,
  PillarRunStatus,
} from './types.js'
import { PILLAR_IDS } from './types.js'
import { CITATION_POINTS, NOMINAL_WEIGHTS, PAGE_BLEND, SIGNAL_POINTS } from './weights.js'

export { gradeFor }

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

/** 100 at rank 1, minus 25 per extra rank, floored at 0. */
export function rankComponent(meanRank: number | null): number {
  if (meanRank == null || !Number.isFinite(meanRank) || meanRank < 1) return 0
  return Math.max(0, Math.round(100 - (meanRank - 1) * 25))
}

export function citationPillarScore(input: {
  mentionRate: number
  citationRate: number
  meanRank: number | null
}): number {
  const raw =
    clamp01(input.mentionRate) * CITATION_POINTS.mention +
    clamp01(input.citationRate) * CITATION_POINTS.citation +
    (rankComponent(input.meanRank) / 100) * CITATION_POINTS.rank
  return Math.round(raw)
}

export function pageComposite(atomScore: number, citabilityScore: number): number {
  return Math.round(atomScore * PAGE_BLEND.atom + citabilityScore * PAGE_BLEND.citability)
}

export function signalFactor(status: CheckStatus | undefined): number {
  if (status === 'pass') return 1
  if (status === 'warn') return 0.5
  return 0
}

export function structuredSignalScore(checks: { id: string; status: CheckStatus; applicable: boolean }[]): number {
  const find = (id: string) => checks.find((check) => check.id === id && check.applicable)
  const raw =
    signalFactor(find('page.jsonld')?.status) * SIGNAL_POINTS.jsonld +
    signalFactor(find('llms.txt')?.status) * SIGNAL_POINTS.llmsTxt +
    signalFactor(find('llms-full.txt')?.status) * SIGNAL_POINTS.llmsFull
  return Math.round(raw)
}

export function applyWeights(scores: Partial<Record<PillarId, number | null>>): {
  score: number
  applied: Record<PillarId, number>
} {
  const available = PILLAR_IDS.filter((id) => typeof scores[id] === 'number')
  const nominalSum = available.reduce((sum, id) => sum + NOMINAL_WEIGHTS[id], 0)
  const applied = {} as Record<PillarId, number>
  for (const id of PILLAR_IDS) {
    applied[id] = available.includes(id) && nominalSum > 0 ? NOMINAL_WEIGHTS[id] / nominalSum : 0
  }
  if (nominalSum <= 0) return { score: 0, applied }
  const score = available.reduce((sum, id) => sum + (scores[id] as number) * applied[id], 0)
  return { score: Math.round(score), applied }
}

export function isTerminal(status: PillarRunStatus): boolean {
  return status === 'SUCCEEDED' || status === 'FAILED' || status === 'SKIPPED'
}

export function progressPercent(progress: GeoHealthProgress): number {
  let units = 0
  for (const id of PILLAR_IDS) {
    const status = progress.pillars[id].status
    if (isTerminal(status)) units += 1
    else if (status === 'RUNNING') units += 0.5
  }
  return Math.round((units / PILLAR_IDS.length) * 100)
}

export function overallCheckStatus(statuses: PillarRunStatus[]): Extract<GeoHealthStatus, 'SUCCEEDED' | 'PARTIAL' | 'FAILED'> {
  const failed = statuses.filter((status) => status === 'FAILED').length
  if (failed === 0) return 'SUCCEEDED'
  if (failed === statuses.length) return 'FAILED'
  return 'PARTIAL'
}

export function impactBand(value: number): ImpactLevel {
  if (value >= 8) return 'high'
  if (value >= 4) return 'medium'
  return 'low'
}

export function effortLabel(effort: EffortLevel) {
  if (effort === 1) return tx('Low', '低')
  if (effort === 2) return tx('Medium', '中')
  return tx('High', '高')
}

export function freshPillarProgress(): GeoHealthProgress['pillars'][PillarId] {
  return { status: 'PENDING', error: null, startedAt: null, finishedAt: null }
}

export function emptyProgress(): GeoHealthProgress {
  return {
    percent: 0,
    pillars: {
      agentReadiness: freshPillarProgress(),
      citations: freshPillarProgress(),
      citability: freshPillarProgress(),
      structuredSignals: freshPillarProgress(),
    },
  }
}
