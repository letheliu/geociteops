export interface CitationMetricEvent {
  brandMentioned: boolean
  brandSourceCited: boolean
  rankInAnswer: number | null
  sourceRank: number | null
  sovScore: number
}

export interface GeoMetricsSnapshot {
  totalEvents: number
  brandMentionRate: number
  sourceCitationRate: number
  avgAnswerRank: number | null
  avgSourceRank: number | null
  avgSovScore: number
}

export interface GeoEffectComparison {
  before: GeoMetricsSnapshot
  after: GeoMetricsSnapshot
  delta: {
    brandMentionRate: number
    sourceCitationRate: number
    avgAnswerRank: number | null
    avgSourceRank: number | null
    avgSovScore: number
  }
}

function avgOrNull(values: (number | null)[]): number | null {
  const valid = values.filter((v): v is number => v !== null)
  if (valid.length === 0) return null
  return valid.reduce((sum, v) => sum + v, 0) / valid.length
}

export function summarizeGeoMetrics(events: CitationMetricEvent[]): GeoMetricsSnapshot {
  if (events.length === 0) {
    return {
      totalEvents: 0,
      brandMentionRate: 0,
      sourceCitationRate: 0,
      avgAnswerRank: null,
      avgSourceRank: null,
      avgSovScore: 0,
    }
  }

  const totalEvents = events.length
  const brandMentionRate = events.filter((e) => e.brandMentioned).length / totalEvents
  const sourceCitationRate = events.filter((e) => e.brandSourceCited).length / totalEvents
  const avgAnswerRank = avgOrNull(events.map((e) => e.rankInAnswer))
  const avgSourceRank = avgOrNull(events.map((e) => e.sourceRank))
  const avgSovScore = events.reduce((sum, e) => sum + e.sovScore, 0) / totalEvents

  return {
    totalEvents,
    brandMentionRate,
    sourceCitationRate,
    avgAnswerRank,
    avgSourceRank,
    avgSovScore,
  }
}

export function compareGeoMetrics(
  before: CitationMetricEvent[],
  after: CitationMetricEvent[],
): GeoEffectComparison {
  const beforeSnapshot = summarizeGeoMetrics(before)
  const afterSnapshot = summarizeGeoMetrics(after)

  return {
    before: beforeSnapshot,
    after: afterSnapshot,
    delta: {
      brandMentionRate: afterSnapshot.brandMentionRate - beforeSnapshot.brandMentionRate,
      sourceCitationRate: afterSnapshot.sourceCitationRate - beforeSnapshot.sourceCitationRate,
      avgAnswerRank: afterSnapshot.avgAnswerRank !== null && beforeSnapshot.avgAnswerRank !== null
        ? afterSnapshot.avgAnswerRank - beforeSnapshot.avgAnswerRank
        : null,
      avgSourceRank: afterSnapshot.avgSourceRank !== null && beforeSnapshot.avgSourceRank !== null
        ? afterSnapshot.avgSourceRank - beforeSnapshot.avgSourceRank
        : null,
      avgSovScore: afterSnapshot.avgSovScore - beforeSnapshot.avgSovScore,
    },
  }
}
