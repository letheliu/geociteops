import { PILLAR_LABEL, type AtomGap, type GeoHealthReport, type PillarId } from './types.js'
import { NOMINAL_WEIGHTS } from './weights.js'

const GAP_ZH: Record<AtomGap, string> = {
  numeric: '缺数字',
  entity: '缺实体',
  selfContained: '缺主谓宾',
  definition: '缺定义句',
}

const IMPACT_ZH = { high: '高', medium: '中', low: '低' } as const

export function renderMarkdown(report: GeoHealthReport): string {
  const lines: string[] = []
  lines.push(`# GEO 体检：${report.brandName}`)
  lines.push('')
  lines.push(`- 站点：${report.siteUrl}`)
  lines.push(`- 行业：${report.industry ?? '—'}`)
  lines.push(`- 竞品：${report.competitors.length > 0 ? report.competitors.join('、') : '—'}`)
  lines.push(`- 总分：**${report.score} / ${report.grade}**`)
  lines.push(`- 时间：${report.generatedAt}`)
  lines.push('')
  lines.push(`> ${report.summary.zh}`)
  lines.push('')
  lines.push('## 权重')
  lines.push('')
  lines.push(report.weighting.notes.zh)
  lines.push('')
  lines.push('| 支柱 | 名义权重 | 本次权重 | 分数 |')
  lines.push('| --- | --- | --- | --- |')
  for (const id of Object.keys(PILLAR_LABEL) as PillarId[]) {
    const score = pillarScore(report, id)
    lines.push(`| ${PILLAR_LABEL[id].zh} | ${pct(NOMINAL_WEIGHTS[id])} | ${pct(report.weighting.applied[id])} | ${score} |`)
  }
  lines.push('')
  lines.push('## Agent 就绪')
  lines.push('')
  const readiness = report.pillars.agentReadiness
  if (readiness.report) {
    lines.push(`得分 ${readiness.report.score}（${readiness.report.grade}）。${readiness.report.summary.zh}`)
    lines.push('')
    lines.push('完整检查项在 JSON 导出的 `pillars.agentReadiness.report` 里，没有另做一套字段。')
  } else {
    lines.push(`这一支柱没有完成。${readiness.error ?? ''}`)
  }
  lines.push('')
  lines.push('## AI 引用快照')
  lines.push('')
  const citations = report.pillars.citations
  lines.push(citations.note?.zh ?? '')
  lines.push('')
  if (citations.mentionRate != null) {
    lines.push(`- 提及率：${pct(citations.mentionRate)}`)
    lines.push(`- 引用率：${pct(citations.citationRate ?? 0)}`)
    lines.push(`- 平均排名：${citations.meanRank == null ? '—' : citations.meanRank.toFixed(1)}`)
    lines.push(`- 声量份额：${pct(citations.shareOfVoice ?? 0)}`)
  }
  if (citations.enginesSkipped.length > 0) {
    lines.push(`- 跳过的引擎：${citations.enginesSkipped.map((item) => `${item.platform}（${item.reason.zh}）`).join('、')}`)
  }
  if (citations.enginesRun.length > 0) {
    lines.push(`- 已跑的引擎：${citations.enginesRun.join('、')}`)
  }
  lines.push('')
  if (citations.queries.length > 0) {
    lines.push('| 问题 | 类型 | 来源 | 提及 | 引用 |')
    lines.push('| --- | --- | --- | --- | --- |')
    for (const query of citations.queries) {
      lines.push(`| ${escapeCell(query.text)} | ${query.kind} | ${query.source} | ${query.mentions}/${query.samples} | ${query.citations}/${query.samples} |`)
    }
    lines.push('')
  }
  if (report.competitors.length > 0) {
    lines.push('| 品牌 | 提及率 | 声量份额 |')
    lines.push('| --- | --- | --- |')
    lines.push(`| ${escapeCell(report.brandName)} | ${pct(citations.mentionRate ?? 0)} | ${pct(citations.shareOfVoice ?? 0)} |`)
    for (const row of citations.competitorSov) {
      lines.push(`| ${escapeCell(row.brand)} | ${pct(row.mentionRate)} | ${pct(row.shareOfVoice)} |`)
    }
    lines.push('')
  }
  lines.push('## 内容可引用性')
  lines.push('')
  lines.push(report.pillars.citability.note?.zh ?? '')
  lines.push('')
  for (const page of report.pillars.citability.weakestPages) {
    lines.push(`- ${page.title}（${page.url}）综合 ${page.composite}，原子 ${page.atomScore}，可引用性 ${page.citabilityScore}`)
    for (const atom of page.weakestAtoms.slice(0, 2)) {
      const missing = atom.missing.map((gap) => GAP_ZH[gap]).join('、')
      lines.push(`  - ${atom.score} 分${missing ? `（${missing}）` : ''}：${atom.text}`)
    }
  }
  lines.push('')
  lines.push('## 结构化信号')
  lines.push('')
  const signals = report.pillars.structuredSignals
  lines.push(signals.note?.zh ?? '')
  lines.push('')
  lines.push(`- JSON-LD：${signals.jsonLdPresent ? '有' : '无'}${signals.schemaTypes.length > 0 ? `（${signals.schemaTypes.join('、')}）` : ''}`)
  lines.push(`- llms.txt：${signals.llmsTxtStatus}`)
  lines.push(`- llms-full.txt：${signals.llmsFullStatus}`)
  lines.push(`- 可下载 llms.txt：${signals.generatedLlmsTxt ? '是' : '否'}`)
  lines.push(`- 可下载 JSON-LD：${signals.generatedJsonLd ? '是' : '否'}`)
  lines.push('')
  lines.push('## 优先行动')
  lines.push('')
  if (report.actions.length === 0) {
    lines.push('这次没有排出行动项。')
  }
  report.actions.forEach((item, index) => {
    lines.push(`### ${index + 1}. ${item.title.zh}`)
    lines.push('')
    lines.push(`- 支柱：${PILLAR_LABEL[item.pillar].zh}`)
    lines.push(`- 影响：${IMPACT_ZH[item.impact]}`)
    lines.push(`- 工作量：${item.effortLabel.zh}`)
    lines.push(`- 做法：${item.fix.zh}`)
    lines.push(`- 如何验证：${item.verify.zh}`)
    if (item.verifyQuery) lines.push(`- 复跑问题：「${item.verifyQuery}」`)
    lines.push('')
  })
  return lines.join('\n').replace(/\n{3,}/g, '\n\n')
}

export function renderJson(report: GeoHealthReport): string {
  return JSON.stringify(report, null, 2)
}

export function exportFilename(report: GeoHealthReport, ext: 'md' | 'json' | 'pdf'): string {
  const day = report.generatedAt.slice(0, 10)
  const slug = report.brandName.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 40) || 'geo-health'
  return `geo-health-${slug}-${day}.${ext}`
}

function pillarScore(report: GeoHealthReport, id: PillarId): string {
  const score = report.pillars[id].score
  if (score == null) return report.pillars[id].status
  return String(score)
}

function pct(value: number): string {
  return `${Math.round(value * 1000) / 10}%`
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\n/g, ' ')
}
