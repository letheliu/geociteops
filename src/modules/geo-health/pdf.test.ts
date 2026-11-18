import { describe, expect, it } from 'vitest'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { buildAcmeDrawSeries } from '../../../scripts/lib/acme-draw-health.ts'
import { renderHealthPdf, resolveCjkFont } from './pdf.js'

async function pdfText(data: Buffer): Promise<string> {
  const doc = await getDocument({
    data: new Uint8Array(data),
    disableWorker: true,
    isEvalSupported: false,
    useSystemFonts: false,
  } as never).promise
  const pages: string[] = []
  for (let i = 1; i <= doc.numPages; i += 1) {
    const page = await doc.getPage(i)
    const content = await page.getTextContent()
    pages.push(content.items.map((item) => ('str' in item ? item.str : '')).join(''))
  }
  return pages.join('\n')
}

describe('health report pdf', () => {
  it('writes a PDF that contains the Chinese report text', async () => {
    expect(resolveCjkFont()).toMatch(/NotoSansSC-Regular\.otf$/)
    const health = buildAcmeDrawSeries({ now: new Date('2026-11-16T08:00:00.000Z') }).at(-1)!.health
    const file = await renderHealthPdf(health)
    expect(file.subarray(0, 5).toString()).toBe('%PDF-')
    expect(file.length).toBeGreaterThan(1000)
    expect(file.length).toBeLessThan(1_500_000)
    const text = await pdfText(file)
    expect(text).toContain('GEO 体检')
    expect(text).toContain('Acme Draw')
    expect(text).toContain('acmedraw.example')
    expect(text).toContain('Northwind Ink')
    expect(text).toContain('Agent 就绪')
    expect(text).toContain('声量份额')
    expect(text).toContain('优先行动')
    expect(text).toContain('附录')
    expect(text).toContain(health.actions[0]!.title.zh)
    expect(text).toContain('Acme Draw 是什么')
    expect(text).toContain('这个引擎还没有配置凭证')
    expect(text).toContain(String(health.score))
  })
})
