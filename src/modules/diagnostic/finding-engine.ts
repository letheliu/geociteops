import type { DiagnosticMetrics, DiagnosticMetricSample } from './types.js'

export interface Finding {
  type: string
  severity: 'INFO' | 'WARNING' | 'CRITICAL'
  title: string
  summary: string
  metric: Record<string, unknown>
  evidenceSampleIds: string[]
}

export interface FindingInput {
  samples: DiagnosticMetricSample[]
  globalMetrics: DiagnosticMetrics
  allPlatforms: string[]
  queryTypes: string[]
  queryTypeSamples: Record<string, { totalQueries: number; samples: DiagnosticMetricSample[] }>
}

function rankSamplesForEvidence(samples: DiagnosticMetricSample[]): DiagnosticMetricSample[] {
  return [...samples].sort((a, b) => {
    const aAnalysis = a.analysis
    const bAnalysis = b.analysis

    // 1. Brand NOT mentioned but competitor mentioned
    const aCompMentioned = aAnalysis?.competitors?.some((c) => c.mentioned) ?? false
    const bCompMentioned = bAnalysis?.competitors?.some((c) => c.mentioned) ?? false
    if (!aAnalysis?.brandMentioned && aCompMentioned && bAnalysis?.brandMentioned) return -1
    if (bAnalysis?.brandMentioned && !bAnalysis?.brandMentioned && bCompMentioned) return 1

    // 2. Brand mentioned but no source citation
    if (aAnalysis?.brandMentioned && !aAnalysis?.brandSourceCited && bAnalysis?.brandSourceCited) return -1
    if (bAnalysis?.brandMentioned && !bAnalysis?.brandSourceCited) return 1

    // 3. Brand rank lower than competitor
    // 4. Lowest SOV
    const aSov = aAnalysis?.sovScore ?? 0
    const bSov = bAnalysis?.sovScore ?? 0
    if (aSov !== bSov) return aSov - bSov

    return 0
  })
}

export function generateFindings(input: FindingInput): Finding[] {
  const { samples, globalMetrics, allPlatforms, queryTypes, queryTypeSamples } = input
  const findings: Finding[] = []
  const rankedSamples = rankSamplesForEvidence(samples)
  const maxEvidence = 10

  // INSUFFICIENT_SAMPLE
  if (globalMetrics.validSampleRate < 0.7 || globalMetrics.platformGaps.length > 0) {
    const isCritical = globalMetrics.validSampleRate < 0.5
    const evidenceSampleIds = rankedSamples.slice(0, maxEvidence).map((s) => (s as any).id).filter(Boolean)
    findings.push({
      type: 'INSUFFICIENT_SAMPLE',
      severity: isCritical ? 'CRITICAL' : 'WARNING',
      title: isCritical ? '诊断样本严重不足' : '诊断样本不足',
      summary: isCritical
        ? `有效样本率仅 ${(globalMetrics.validSampleRate * 100).toFixed(0)}%，低于 50%，诊断结果可靠性低`
        : globalMetrics.platformGaps.length > 0
          ? `以下平台无有效结果：${globalMetrics.platformGaps.join('、')}`
          : `有效样本率 ${(globalMetrics.validSampleRate * 100).toFixed(0)}%，低于 70%`,
      metric: {
        validSampleRate: globalMetrics.validSampleRate,
        platformGaps: globalMetrics.platformGaps,
      },
      evidenceSampleIds: evidenceSampleIds,
    })
  }

  // LOW_VISIBILITY: global and per-query-type
  const validCount = globalMetrics.validSampleCount
  if (validCount >= 5 && globalMetrics.mentionRate != null && globalMetrics.mentionRate < 0.3) {
    const severity = globalMetrics.mentionRate < 0.1 ? 'CRITICAL' : 'WARNING'
    const evidenceSampleIds = rankedSamples.slice(0, maxEvidence).map((s) => (s as any).id).filter(Boolean)
    findings.push({
      type: 'LOW_VISIBILITY',
      severity,
      title: severity === 'CRITICAL' ? '品牌可见度极低' : '品牌可见度偏低',
      summary: `品牌提及率 ${(globalMetrics.mentionRate * 100).toFixed(0)}%，低于 ${severity === 'CRITICAL' ? '10%' : '30%'} 阈值`,
      metric: { mentionRate: globalMetrics.mentionRate, threshold: 0.3 },
      evidenceSampleIds,
    })
  }

  // LOW_SOURCE_CITATION
  const brandMentionedCount = samples.filter(
    (s) => s.status === 'SUCCEEDED' && s.analysis?.brandMentioned
  ).length
  if (
    brandMentionedCount >= 5 &&
    globalMetrics.mentionedSourceCitationRate != null &&
    globalMetrics.mentionedSourceCitationRate < 0.2
  ) {
    const severity = globalMetrics.mentionedSourceCitationRate === 0 ? 'CRITICAL' : 'WARNING'
    const evidenceSampleIds = rankedSamples.slice(0, maxEvidence).map((s) => (s as any).id).filter(Boolean)
    findings.push({
      type: 'LOW_SOURCE_CITATION',
      severity,
      title: severity === 'CRITICAL' ? '品牌来源引用率为零' : '品牌来源引用率偏低',
      summary: `提及后来源引用率 ${(globalMetrics.mentionedSourceCitationRate * 100).toFixed(0)}%，低于 20%`,
      metric: {
        mentionedSourceCitationRate: globalMetrics.mentionedSourceCitationRate,
        threshold: 0.2,
      },
      evidenceSampleIds,
    })
  }

  // LOW_RANK
  if (
    globalMetrics.rankedSampleCount >= 5 &&
    globalMetrics.averageRank != null &&
    globalMetrics.averageRank > 3
  ) {
    const evidenceSampleIds = rankedSamples.slice(0, maxEvidence).map((s) => (s as any).id).filter(Boolean)
    findings.push({
      type: 'LOW_RANK',
      severity: 'WARNING',
      title: '推荐排名靠后',
      summary: `平均推荐排名 ${globalMetrics.averageRank.toFixed(1)}，超过 3 的建议阈值`,
      metric: { averageRank: globalMetrics.averageRank, threshold: 3 },
      evidenceSampleIds,
    })
  }

  // COMPETITOR_DOMINANCE
  for (const delta of globalMetrics.competitorLeadDeltas) {
    if (delta.leadDelta >= 0.2) {
      const severity = delta.leadDelta >= 0.4 ? 'CRITICAL' : 'WARNING'
      const evidenceSampleIds = rankedSamples.slice(0, maxEvidence).map((s) => (s as any).id).filter(Boolean)
      findings.push({
        type: 'COMPETITOR_DOMINANCE',
        severity,
        title: `竞品 ${delta.name} 领先优势明显`,
        summary: `竞品 ${delta.name} 提及率 ${(delta.mentionRate * 100).toFixed(0)}%，品牌提及率 ${globalMetrics.mentionRate != null ? (globalMetrics.mentionRate * 100).toFixed(0) : 'N/A'}%，领先 ${(delta.leadDelta * 100).toFixed(0)} 个百分点`,
        metric: {
          competitor: delta.name,
          competitorMentionRate: delta.mentionRate,
          brandMentionRate: globalMetrics.mentionRate,
          leadDelta: delta.leadDelta,
        },
        evidenceSampleIds,
      })
    }
  }

  // PLATFORM_GAP
  for (const platform of allPlatforms) {
    const platformSamples = samples.filter((s) => s.platform === platform)
    const platformValid = platformSamples.filter(
      (s) => s.status === 'SUCCEEDED' && s.rawAnswer && s.analysis
    )
    if (platformValid.length >= 5) {
      const platformMentioned = platformValid.filter((s) => s.analysis!.brandMentioned)
      if (platformMentioned.length === 0) {
        // Check if any other platform has mentions
        const otherPlatformMentioned = samples.some(
          (s) => s.platform !== platform && s.analysis?.brandMentioned
        )
        if (otherPlatformMentioned) {
          const evidenceSampleIds = platformValid.slice(0, maxEvidence).map((s) => (s as any).id).filter(Boolean)
          findings.push({
            type: 'PLATFORM_GAP',
            severity: 'WARNING',
            title: `${platform} 平台品牌可见度为零`,
            summary: `在 ${platform} 上有 ${platformValid.length} 个有效样本但没有一次品牌提及，其他平台有提及`,
            metric: { platform, validSampleCount: platformValid.length, mentionCount: 0 },
            evidenceSampleIds,
          })
        }
      }
    }
  }

  return findings
}
