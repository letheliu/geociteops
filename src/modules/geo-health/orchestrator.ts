import { tx } from '../agent-readiness/types.js'
import type { AgentReadinessReport } from '../agent-readiness/types.js'
import { buildActions } from './actions.js'
import { runCitationSnapshot, type CitationRunDeps } from './citations.js'
import { runCitability, type CitabilityRunDeps } from './citability.js'
import { publicError } from './errors.js'
import { resolveLanguage } from './queries.js'
import { applyWeights, gradeFor, overallCheckStatus } from './score.js'
import { runStructuredSignals } from './signals.js'
import type { GeoHealthRunInput } from './run-input.js'
import type {
  AgentReadinessPillar,
  CitationPillar,
  CitabilityPillar,
  GeoHealthReport,
  PillarId,
  StructuredSignalsPillar,
} from './types.js'
import { GEO_HEALTH_REPORT_VERSION, PILLAR_IDS, PILLAR_LABEL } from './types.js'
import { NOMINAL_WEIGHTS } from './weights.js'

export interface GeoHealthRunDeps extends CitationRunDeps, CitabilityRunDeps {
  runReadiness(url: string): Promise<AgentReadinessReport>
}

export async function runPillar(
  pillar: PillarId,
  input: GeoHealthRunInput,
  readinessReport: AgentReadinessReport | null,
  deps: GeoHealthRunDeps,
): Promise<AgentReadinessPillar | CitationPillar | CitabilityPillar | StructuredSignalsPillar> {
  try {
    if (pillar === 'agentReadiness') return await runReadinessPillar(input, deps)
    if (pillar === 'citations') return await runCitationSnapshot(input, deps)
    if (pillar === 'citability') return await runCitability(input, deps)
    return runStructuredSignals(input, readinessReport)
  } catch (err) {
    return failedPillar(pillar, publicError(err))
  }
}

async function runReadinessPillar(input: GeoHealthRunInput, deps: GeoHealthRunDeps): Promise<AgentReadinessPillar> {
  try {
    const report = await deps.runReadiness(input.siteUrl)
    return { status: 'SUCCEEDED', score: report.score, report, error: null }
  } catch (err) {
    return { status: 'FAILED', score: null, report: null, error: publicError(err) }
  }
}

export function failedPillar(pillar: PillarId, error: string): AgentReadinessPillar | CitationPillar | CitabilityPillar | StructuredSignalsPillar {
  if (pillar === 'agentReadiness') {
    return { status: 'FAILED', score: null, report: null, error }
  }
  if (pillar === 'citations') {
    return {
      status: 'FAILED',
      score: null,
      queries: [],
      querySource: 'template',
      enginesRun: [],
      enginesSkipped: [],
      mentionRate: null,
      citationRate: null,
      meanRank: null,
      shareOfVoice: null,
      citedUrls: [],
      brandCitedUrls: [],
      competitorSov: [],
      samples: [],
      note: null,
      error,
    }
  }
  if (pillar === 'citability') {
    return { status: 'FAILED', score: null, pages: [], weakestPages: [], note: null, error }
  }
  return {
    status: 'FAILED',
    score: null,
    schemaTypes: [],
    jsonLdPresent: false,
    llmsTxtStatus: 'unknown',
    llmsFullStatus: 'unknown',
    generatedLlmsTxt: '',
    generatedJsonLd: '',
    note: null,
    error,
  }
}

export interface PillarBundle {
  agentReadiness: AgentReadinessPillar
  citations: CitationPillar
  citability: CitabilityPillar
  structuredSignals: StructuredSignalsPillar
}

export function bundlePillars(partial: Partial<PillarBundle>): PillarBundle {
  return {
    agentReadiness: partial.agentReadiness ?? failedPillar('agentReadiness', '这一支柱没有结果') as AgentReadinessPillar,
    citations: partial.citations ?? failedPillar('citations', '这一支柱没有结果') as CitationPillar,
    citability: partial.citability ?? failedPillar('citability', '这一支柱没有结果') as CitabilityPillar,
    structuredSignals: partial.structuredSignals ?? failedPillar('structuredSignals', '这一支柱没有结果') as StructuredSignalsPillar,
  }
}

export function conclude(input: GeoHealthRunInput, partial: Partial<PillarBundle>, now: Date): {
  status: 'SUCCEEDED' | 'PARTIAL' | 'FAILED'
  report: GeoHealthReport
} {
  const pillars = bundlePillars(partial)
  const { score, applied } = applyWeights({
    agentReadiness: pillars.agentReadiness.score,
    citations: pillars.citations.score,
    citability: pillars.citability.score,
    structuredSignals: pillars.structuredSignals.score,
  })
  const grade = gradeFor(score)
  const actions = buildActions({
    readiness: pillars.agentReadiness,
    citations: pillars.citations,
    citability: pillars.citability,
    signals: pillars.structuredSignals,
  })
  const status = overallCheckStatus(PILLAR_IDS.map((id) => pillars[id].status))
  const summary = summaryFor(score, grade, pillars)
  const report: GeoHealthReport = {
    version: GEO_HEALTH_REPORT_VERSION,
    brandName: input.brandName,
    siteUrl: input.siteUrl,
    industry: input.industry,
    competitors: input.competitors,
    language: input.language,
    resolvedLanguage: resolveLanguage(input),
    score,
    grade,
    weighting: {
      nominal: { ...NOMINAL_WEIGHTS },
      applied,
      notes: tx(
        'Nominal weights: agent readiness 30%, citations 35%, citability 20%, structured signals 15%. A pillar with no score (failed or skipped) is dropped and the rest are scaled to 100%.',
        '名义权重：Agent 就绪 30%，引用快照 35%，内容可引用性 20%，结构化信号 15%。没有分数的支柱（失败或跳过）不计入，其余按比例放大到 100%。',
      ),
    },
    summary,
    pillars,
    actions,
    generatedAt: now.toISOString(),
  }
  return { status, report }
}

function summaryFor(score: number, grade: string, pillars: PillarBundle): { en: string; zh: string } {
  const scored = PILLAR_IDS
    .map((id) => ({ id, score: pillars[id].score }))
    .filter((item): item is { id: PillarId; score: number } => typeof item.score === 'number')
  if (scored.length === 0) {
    return tx('No pillar produced a score.', '没有支柱给出分数。')
  }
  const weakest = [...scored].sort((a, b) => a.score - b.score || a.id.localeCompare(b.id))[0]
  return tx(
    `GEO health is ${score} (${grade}). The weakest scored pillar is ${PILLAR_LABEL[weakest.id].en} at ${weakest.score}.`,
    `GEO 体检得分 ${score}（${grade}）。已评分支柱里最弱的是${PILLAR_LABEL[weakest.id].zh}（${weakest.score}）。`,
  )
}
