import type { DiagnosticRunStatus } from '@prisma/client'
import type { DiagnosticMetrics, DiagnosticMetricSample } from './types.js'

export function calculateMetrics(input: {
  plannedSamples: number
  runStatus: DiagnosticRunStatus
  samples: DiagnosticMetricSample[]
}): DiagnosticMetrics {
  const { plannedSamples, runStatus, samples } = input

  const validSamples = samples.filter(
    (s) => s.status === 'SUCCEEDED' && s.rawAnswer && s.analysis
  )
  const validCount = validSamples.length
  const successCount = samples.filter((s) => s.status === 'SUCCEEDED').length
  const failedCount = samples.filter((s) => s.status === 'FAILED').length

  const validSampleRate = plannedSamples > 0 ? validCount / plannedSamples : 0

  const mentioned = validSamples.filter((s) => s.analysis!.brandMentioned)
  const mentionRate = validCount > 0 ? mentioned.length / validCount : null

  const sourceCited = mentioned.filter((s) => s.analysis!.brandSourceCited)
  const sourceCitationRate = validCount > 0 ? sourceCited.length / validCount : null
  const mentionedSourceCitationRate =
    mentioned.length > 0 ? sourceCited.length / mentioned.length : null

  const rankedSamples = mentioned.filter((s) => s.analysis!.rankInAnswer != null)
  const rankedCount = rankedSamples.length
  const averageRank =
    rankedCount > 0
      ? rankedSamples.reduce((sum, s) => sum + s.analysis!.rankInAnswer!, 0) / rankedCount
      : null

  const rankCoverageScore =
    validCount > 0
      ? validSamples.reduce((sum, s) => {
          if (!s.analysis!.brandMentioned) return sum + 0
          const rank = s.analysis!.rankInAnswer
          if (rank == null) return sum + 0
          return sum + 1 / rank
        }, 0) / validCount
      : 0

  const sovValues = validSamples.map((s) => s.analysis!.sovScore)
  const sovScore = sovValues.length > 0 ? sovValues.reduce((a, b) => a + b, 0) / sovValues.length : 0

  const allCompetitorNames = new Set<string>()
  validSamples.forEach((s) => {
    s.analysis!.competitors.forEach((c) => allCompetitorNames.add(c.name))
  })

  const competitorLeadDeltas = Array.from(allCompetitorNames).map((name) => {
    const competitorMentioned = validSamples.filter((s) =>
      s.analysis!.competitors.some((c) => c.name === name && c.mentioned)
    )
    const compMentionRate = validCount > 0 ? competitorMentioned.length / validCount : 0
    const brandMentionRate = mentionRate ?? 0
    return {
      name,
      mentionRate: compMentionRate,
      leadDelta: compMentionRate - brandMentionRate,
    }
  })

  const platformGaps = findPlatformGaps(samples, validCount)

  const reliability = calculateReliability(validSampleRate, runStatus, platformGaps.length === 0)

  return {
    validSampleRate,
    validSampleCount: validCount,
    mentionRate,
    sourceCitationRate,
    mentionedSourceCitationRate,
    averageRank,
    rankedSampleCount: rankedCount,
    rankCoverageScore,
    sovScore,
    competitorLeadDeltas,
    queryTypeCoverage: {},
    reliability,
    plannedSamples,
    failedSamples: failedCount,
    successSamples: successCount,
    platformGaps,
  }
}

function findPlatformGaps(samples: DiagnosticMetricSample[], validCount: number): string[] {
  if (validCount === 0) return []
  const platformsWithValid = new Set(
    samples.filter((s) => s.status === 'SUCCEEDED' && s.rawAnswer && s.analysis).map((s) => s.platform)
  )
  const allPlatforms = new Set(samples.map((s) => s.platform))
  const gaps: string[] = []
  for (const p of allPlatforms) {
    if (!platformsWithValid.has(p)) gaps.push(p)
  }
  return gaps
}

function calculateReliability(
  validSampleRate: number,
  runStatus: string,
  allPlatformsHaveResults: boolean,
): 'HIGH' | 'MEDIUM' | 'LOW' {
  if (validSampleRate >= 0.9 && allPlatformsHaveResults && runStatus === 'COMPLETED') {
    return 'HIGH'
  }
  if (runStatus === 'PARTIAL') {
    return 'MEDIUM'
  }
  if (validSampleRate >= 0.7 && allPlatformsHaveResults) {
    return 'MEDIUM'
  }
  return 'LOW'
}
