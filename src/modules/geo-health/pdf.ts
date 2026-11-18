import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import PDFDocument from 'pdfkit'
import { PILLAR_IDS, PILLAR_LABEL, type GeoHealthReport } from './types.js'

const INK = '#17323a'
const MUTED = '#5c6b73'
const TEAL = '#0f766e'
const TEAL_DARK = '#0b3d38'
const TRACK = '#e6eeec'
const LINE = '#d7e3e0'
const PAPER = '#f4f7f6'
const BAD = '#b42318'
const WARN = '#b86e00'

const IMPACT_ZH = { high: '高', medium: '中', low: '低' } as const

const PAGE_BOTTOM = 786

export function resolveCjkFont(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    process.env.GEO_CJK_FONT,
    join(process.cwd(), 'assets/fonts/NotoSansSC-Regular.otf'),
    join(here, '../../../assets/fonts/NotoSansSC-Regular.otf'),
    join(here, '../../../../assets/fonts/NotoSansSC-Regular.otf'),
  ].filter((item): item is string => Boolean(item))
  for (const path of candidates) {
    if (existsSync(path)) return path
  }
  throw new Error('缺少中文字体 assets/fonts/NotoSansSC-Regular.otf（或设置 GEO_CJK_FONT）')
}

function openDocument(options: PDFKit.PDFDocumentOptions): PDFKit.PDFDocument {
  const Ctor = PDFDocument as unknown as new (options?: PDFKit.PDFDocumentOptions) => PDFKit.PDFDocument
  return new Ctor(options)
}

function shanghaiStamp(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(date)
}

function pct(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—'
  return `${Math.round(value * 1000) / 10}%`
}

function gradeColor(grade: string): string {
  if (grade === 'A' || grade === 'B') return TEAL
  if (grade === 'C') return WARN
  return BAD
}

/**
 * Branded A4 report. Chinese text uses the bundled Noto Sans SC face.
 * pdfkit subsets that face, so the file stays small even though the
 * source font is about 8 MB on disk. No browser and no Chromium.
 */
export function renderHealthPdf(report: GeoHealthReport, fontPath = resolveCjkFont()): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = openDocument({
      size: 'A4',
      margins: { top: 56, bottom: 56, left: 48, right: 48 },
      bufferPages: true,
      info: {
        Title: `GEO 体检 ${report.brandName}`,
        Author: 'GeoCiteOps',
        Creator: 'GeoCiteOps',
      },
    })
    const chunks: Buffer[] = []
    doc.on('data', (chunk: Buffer) => chunks.push(chunk))
    doc.on('error', reject)
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    try {
      doc.registerFont('cjk', fontPath)
      doc.font('cjk')
      drawCover(doc, report)
      doc.addPage()
      doc.font('cjk')
      let y = drawHeader(doc, report.brandName)
      y = drawPillars(doc, report, y)
      y = drawSov(doc, report, y)
      y = drawReadiness(doc, report, y)
      y = drawActions(doc, report, y)
      drawAppendix(doc, report, y)
      stampPages(doc)
      doc.end()
    } catch (err) {
      reject(err)
    }
  })
}

function drawHeader(doc: PDFKit.PDFDocument, brand: string): number {
  doc.font('cjk').fontSize(9).fillColor(MUTED)
  doc.text(`GeoCiteOps  ·  GEO 体检  ·  ${brand}`, 48, 32, { width: 500, lineBreak: false })
  doc.moveTo(48, 48).lineTo(547, 48).strokeColor(LINE).lineWidth(1).stroke()
  return 64
}

function newPage(doc: PDFKit.PDFDocument, brand: string): number {
  doc.addPage()
  doc.font('cjk')
  return drawHeader(doc, brand)
}

function ensure(doc: PDFKit.PDFDocument, y: number, needed: number, brand: string): number {
  if (y + needed <= PAGE_BOTTOM) return y
  return newPage(doc, brand)
}

function sectionTitle(doc: PDFKit.PDFDocument, y: number, title: string): number {
  doc.font('cjk').fontSize(14).fillColor(TEAL_DARK).text(title, 48, y, { width: 499 })
  return doc.y + 8
}

function drawCover(doc: PDFKit.PDFDocument, report: GeoHealthReport): void {
  doc.rect(0, 0, doc.page.width, 132).fill(TEAL_DARK)
  doc.font('cjk').fillColor('#ffffff').fontSize(11).text('GeoCiteOps', 48, 36, { lineBreak: false })
  doc.fontSize(28).text('GEO 体检', 48, 58, { lineBreak: false })
  doc.fontSize(11).fillColor('#d7efe9').text('一份报告，看清现在被引用的机会，以及先改哪几件事。', 48, 98, { width: 460 })

  doc.fillColor(INK).fontSize(12).text('品牌', 48, 164, { lineBreak: false })
  doc.fontSize(26).text(report.brandName, 48, 182, { width: 499 })
  let y = doc.y + 8
  doc.fontSize(11).fillColor(MUTED)
  doc.text(report.siteUrl, 48, y, { width: 499 })
  y = doc.y + 4
  const meta = [
    `日期  ${shanghaiStamp(report.generatedAt)}（Asia/Shanghai）`,
    `行业  ${report.industry ?? '—'}`,
    `竞品  ${report.competitors.length > 0 ? report.competitors.join('、') : '—'}`,
  ]
  for (const line of meta) {
    doc.text(line, 48, y, { width: 499 })
    y = doc.y + 2
  }

  y += 18
  doc.roundedRect(48, y, 499, 118, 8).fill(PAPER)
  doc.fillColor(gradeColor(report.grade)).fontSize(42)
  const scoreWidth = doc.widthOfString(String(report.score))
  doc.text(String(report.score), 68, y + 28, { lineBreak: false })
  doc.fontSize(22).text(report.grade, 68 + scoreWidth + 16, y + 46, { lineBreak: false })
  doc.fillColor(MUTED).fontSize(11).text('总分  /  字母档', 68, y + 82, { lineBreak: false })
  doc.fillColor(INK).fontSize(11).text(report.summary.zh, 220, y + 36, { width: 300 })

  y += 146
  doc.fontSize(12).fillColor(TEAL_DARK).text('四根支柱', 48, y)
  y = doc.y + 10
  for (const id of PILLAR_IDS) {
    const score = report.pillars[id].score
    doc.fontSize(11).fillColor(INK).text(PILLAR_LABEL[id].zh, 48, y, { width: 140, lineBreak: false })
    doc.fillColor(MUTED).text(score == null ? '—' : String(score), 470, y, { width: 70, align: 'right', lineBreak: false })
    bar(doc, 190, y + 2, 260, 10, score == null ? 0 : score / 100, TEAL)
    y += 26
  }

  doc.fontSize(10).fillColor(MUTED).text(report.weighting.notes.zh, 48, y + 12, { width: 499 })
}

function bar(doc: PDFKit.PDFDocument, x: number, y: number, width: number, height: number, fraction: number, color: string): void {
  doc.roundedRect(x, y, width, height, 2).fill(TRACK)
  const filled = Math.max(0, Math.min(1, fraction)) * width
  if (filled > 0.5) doc.roundedRect(x, y, filled, height, 2).fill(color)
}

function drawPillars(doc: PDFKit.PDFDocument, report: GeoHealthReport, y: number): number {
  y = sectionTitle(doc, y, '支柱得分')
  doc.font('cjk').fontSize(10).fillColor(MUTED)
  doc.text('没有分数的支柱不计入总分，其余权重按比例放大。', 48, y, { width: 499 })
  y = doc.y + 10
  for (const id of PILLAR_IDS) {
    y = ensure(doc, y, 36, report.brandName)
    const pillar = report.pillars[id]
    const score = pillar.score
    doc.font('cjk').fontSize(11).fillColor(INK).text(PILLAR_LABEL[id].zh, 48, y, { width: 160, lineBreak: false })
    doc.fillColor(MUTED).text(
      `${pillar.status}${score == null ? '' : `  ·  ${score}`}`,
      220,
      y,
      { width: 320, align: 'right', lineBreak: false },
    )
    bar(doc, 48, y + 16, 499, 8, score == null ? 0 : score / 100, TEAL)
    y += 34
  }
  return y + 8
}

function drawSov(doc: PDFKit.PDFDocument, report: GeoHealthReport, y: number): number {
  y = ensure(doc, y, 80, report.brandName)
  y = sectionTitle(doc, y, '声量份额')
  const citations = report.pillars.citations
  const rows = [
    { brand: report.brandName, share: citations.shareOfVoice, mention: citations.mentionRate, self: true },
    ...citations.competitorSov.map((row) => ({
      brand: row.brand,
      share: row.shareOfVoice,
      mention: row.mentionRate,
      self: false,
    })),
  ].filter((row) => row.share != null || row.self)
  if (citations.shareOfVoice == null && citations.competitorSov.length === 0) {
    doc.font('cjk').fontSize(10).fillColor(MUTED).text(citations.note?.zh || '这次没有可对比的声量。', 48, y, { width: 499 })
    return doc.y + 12
  }
  const max = Math.max(0.01, ...rows.map((row) => row.share ?? 0))
  for (const row of rows) {
    y = ensure(doc, y, 28, report.brandName)
    doc.font('cjk').fontSize(10).fillColor(row.self ? TEAL_DARK : INK)
    doc.text(`${row.brand}${row.self ? '（本品）' : ''}`, 48, y, { width: 150, lineBreak: false })
    doc.fillColor(MUTED).text(`提及 ${pct(row.mention)}`, 430, y, { width: 110, align: 'right', lineBreak: false })
    bar(doc, 200, y + 2, 210, 9, (row.share ?? 0) / max, row.self ? TEAL : '#7aa8a2')
    y += 22
  }
  if (citations.note?.zh) {
    y = ensure(doc, y, 28, report.brandName)
    doc.font('cjk').fontSize(9).fillColor(MUTED).text(citations.note.zh, 48, y, { width: 499 })
    y = doc.y + 8
  }
  return y + 6
}

function drawReadiness(doc: PDFKit.PDFDocument, report: GeoHealthReport, y: number): number {
  y = ensure(doc, y, 70, report.brandName)
  y = sectionTitle(doc, y, 'Agent 就绪')
  const pillar = report.pillars.agentReadiness
  const embedded = pillar.report
  doc.font('cjk').fontSize(11).fillColor(INK)
  if (!embedded) {
    doc.text(pillar.error || '这一支柱没有嵌入就绪报告。', 48, y, { width: 499 })
    return doc.y + 12
  }
  doc.text(`得分 ${embedded.score}（${embedded.grade}）。${embedded.summary.zh}`, 48, y, { width: 499 })
  y = doc.y + 8
  const fixes = embedded.fixes.slice(0, 6)
  if (fixes.length === 0) {
    doc.fontSize(10).fillColor(MUTED).text('没有优先修复项。完整检查项在 JSON 导出里。', 48, y, { width: 499 })
    return doc.y + 12
  }
  for (const fix of fixes) {
    y = ensure(doc, y, 32, report.brandName)
    doc.font('cjk').fontSize(10).fillColor(INK).text(`· ${fix.title.zh}`, 48, y, { width: 499 })
    y = doc.y + 2
    doc.fontSize(9).fillColor(MUTED).text(fix.fix.zh, 60, y, { width: 487 })
    y = doc.y + 6
  }
  return y
}

interface Cell {
  text: string
  width: number
}

function rowHeight(doc: PDFKit.PDFDocument, cells: Cell[], fontSize: number): number {
  doc.font('cjk').fontSize(fontSize)
  const heights = cells.map((cell) => doc.heightOfString(cell.text || ' ', { width: cell.width - 8 }))
  return Math.max(...heights, fontSize) + 8
}

function drawRow(doc: PDFKit.PDFDocument, y: number, cells: Cell[], fontSize: number, header: boolean): number {
  const height = rowHeight(doc, cells, fontSize)
  let x = 48
  for (const cell of cells) {
    if (header) doc.rect(x, y, cell.width, height).fill('#e7f2f0')
    else doc.rect(x, y, cell.width, height).strokeColor(LINE).lineWidth(0.4).stroke()
    doc.font('cjk').fontSize(fontSize).fillColor(header ? TEAL_DARK : INK)
    doc.text(cell.text, x + 4, y + 4, { width: cell.width - 8 })
    x += cell.width
  }
  return y + height
}

const ACTION_WIDTHS = [28, 110, 36, 52, 136, 137]

function actionCells(values: string[]): Cell[] {
  return values.map((text, index) => ({ text, width: ACTION_WIDTHS[index] ?? 40 }))
}

function drawActions(doc: PDFKit.PDFDocument, report: GeoHealthReport, y: number): number {
  y = ensure(doc, y, 60, report.brandName)
  y = sectionTitle(doc, y, '优先行动')
  if (report.actions.length === 0) {
    doc.font('cjk').fontSize(10).fillColor(MUTED).text('这次没有排出行动项。', 48, y, { width: 499 })
    return doc.y + 12
  }
  const header = actionCells(['#', '事项', '影响', '工作量', '做法', '如何验证'])
  const paintHeader = () => {
    y = drawRow(doc, y, header, 8, true)
  }
  paintHeader()
  report.actions.forEach((action, index) => {
    const cells = actionCells([
      String(index + 1),
      action.title.zh,
      IMPACT_ZH[action.impact],
      action.effortLabel.zh,
      action.fix.zh,
      action.verifyQuery ? `${action.verify.zh} 复跑：「${action.verifyQuery}」` : action.verify.zh,
    ])
    const height = rowHeight(doc, cells, 8)
    if (y + height > PAGE_BOTTOM) {
      y = newPage(doc, report.brandName)
      paintHeader()
    }
    y = drawRow(doc, y, cells, 8, false)
  })
  return y + 12
}

function drawAppendix(doc: PDFKit.PDFDocument, report: GeoHealthReport, y: number): number {
  y = ensure(doc, y, 70, report.brandName)
  y = sectionTitle(doc, y, '附录：问题与跳过的引擎')
  const citations = report.pillars.citations
  if (citations.queries.length === 0) {
    doc.font('cjk').fontSize(10).fillColor(MUTED).text('这次没有留下问题。', 48, y, { width: 499 })
    y = doc.y + 8
  }
  for (const query of citations.queries) {
    y = ensure(doc, y, 28, report.brandName)
    doc.font('cjk').fontSize(10).fillColor(INK).text(query.text, 48, y, { width: 340 })
    const textBottom = doc.y
    doc.fontSize(9).fillColor(MUTED).text(
      `${query.kind} · 提及 ${query.mentions}/${query.samples} · 引用 ${query.citations}/${query.samples}`,
      390,
      y,
      { width: 157, align: 'right' },
    )
    y = Math.max(textBottom, doc.y) + 6
  }
  y += 6
  y = ensure(doc, y, 36, report.brandName)
  doc.font('cjk').fontSize(11).fillColor(TEAL_DARK).text('跳过的引擎', 48, y, { width: 499 })
  y = doc.y + 6
  if (citations.enginesSkipped.length === 0) {
    doc.fontSize(10).fillColor(MUTED).text(
      citations.enginesRun.length > 0 ? `已跑：${citations.enginesRun.join('、')}。没有跳过的引擎。` : '没有引擎记录。',
      48,
      y,
      { width: 499 },
    )
    return doc.y + 8
  }
  for (const skip of citations.enginesSkipped) {
    y = ensure(doc, y, 22, report.brandName)
    doc.font('cjk').fontSize(10).fillColor(INK).text(`${skip.platform}  —  ${skip.reason.zh}`, 48, y, { width: 499 })
    y = doc.y + 4
  }
  if (citations.enginesRun.length > 0) {
    y = ensure(doc, y, 22, report.brandName)
    doc.font('cjk').fontSize(9).fillColor(MUTED).text(`已跑：${citations.enginesRun.join('、')}`, 48, y, { width: 499 })
  }
  return doc.y
}

function stampPages(doc: PDFKit.PDFDocument): void {
  const range = doc.bufferedPageRange()
  for (let i = 0; i < range.count; i += 1) {
    doc.switchToPage(range.start + i)
    doc.font('cjk').fontSize(8).fillColor(MUTED)
    doc.text(`第 ${i + 1} / ${range.count} 页`, 48, doc.page.height - 36, {
      width: doc.page.width - 96,
      align: 'right',
      lineBreak: false,
    })
  }
}
