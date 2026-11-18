import type { GeoHealthDiff, GeoHealthReport, PillarDelta, PillarId } from './types.js'
import { PILLAR_IDS } from './types.js'

const IMPACT_RANK = { low: 1, medium: 2, high: 3 } as const

function scoreOf(report: GeoHealthReport, pillar: PillarId): number | null {
  const score = report.pillars[pillar].score
  return typeof score === 'number' ? score : null
}

/**
 * Compare two finished reports. Action identity is the stable id
 * (`citations:mention`, `readiness:llms.txt`, …), not the title text.
 */
export function diffReports(previous: GeoHealthReport, current: GeoHealthReport): Omit<GeoHealthDiff, 'previousId' | 'previousAt'> {
  const previousById = new Map(previous.actions.map((action) => [action.id, action]))
  const currentById = new Map(current.actions.map((action) => [action.id, action]))
  const newActions = current.actions.filter((action) => !previousById.has(action.id))
  const resolvedActions = previous.actions.filter((action) => !currentById.has(action.id))
  const regressedActions = current.actions.filter((action) => {
    const prior = previousById.get(action.id)
    if (!prior) return false
    return IMPACT_RANK[action.impact] > IMPACT_RANK[prior.impact]
  })
  const pillars: PillarDelta[] = PILLAR_IDS.map((pillar) => {
    const before = scoreOf(previous, pillar)
    const after = scoreOf(current, pillar)
    return {
      pillar,
      previous: before,
      current: after,
      delta: before == null || after == null ? null : after - before,
    }
  })
  return {
    previousScore: previous.score,
    currentScore: current.score,
    scoreDelta: current.score - previous.score,
    previousGrade: previous.grade,
    currentGrade: current.grade,
    pillars,
    newActions,
    resolvedActions,
    regressedActions,
    regressedPillars: pillars
      .filter((item) => item.delta != null && item.delta < 0)
      .map((item) => item.pillar),
  }
}
