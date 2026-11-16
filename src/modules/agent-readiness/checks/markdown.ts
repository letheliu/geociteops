import { asEvidence, tx, type AgentReadinessCheck } from '../types.js'
import { CHECK_WEIGHTS } from '../weights.js'

export interface MarkdownProbe {
  url: string
  status: number
  contentType: string
  body: string
  error?: string
}

export function looksLikeMarkdown(body: string, contentType: string): boolean {
  if (/text\/markdown|text\/x-markdown/i.test(contentType)) return true
  if (/text\/html|application\/xhtml|application\/json/i.test(contentType)) return false
  const sample = body.trimStart().slice(0, 400).toLowerCase()
  if (!sample) return false
  if (sample.startsWith('<!doctype html') || sample.startsWith('<html') || sample.startsWith('<head')) return false
  return /^#\s+\S/m.test(body) || /\[[^\]]+\]\([^)]+\)/.test(body)
}

/**
 * Markdown for agents: either `<url>.md` or `Accept: text/markdown` content negotiation.
 * Absence warns. The practice is still uncommon, so it does not fail the audit.
 */
export function checkMarkdown(negotiated: MarkdownProbe | null, dotMd: MarkdownProbe | null): AgentReadinessCheck {
  const negotiationOk = negotiated ? looksLikeMarkdown(negotiated.body, negotiated.contentType) && negotiated.status === 200 && !negotiated.error : false
  const dotOk = dotMd ? looksLikeMarkdown(dotMd.body, dotMd.contentType) && dotMd.status === 200 && !dotMd.error : false
  const ok = negotiationOk || dotOk
  const via = negotiationOk ? 'content negotiation (Accept: text/markdown)' : dotOk ? `${dotMd?.url}` : null
  return {
    id: 'markdown',
    category: 'markdown',
    title: tx('Markdown is available to agents', '可为 Agent 提供 Markdown'),
    status: ok ? 'pass' : 'warn',
    weight: CHECK_WEIGHTS.markdown,
    applicable: true,
    explanation: ok
      ? tx(`Markdown was returned via ${via}.`, `通过 ${via} 返回了 Markdown。`)
      : tx(
        'Neither content negotiation (Accept: text/markdown) nor a sibling .md URL returned markdown. Agents then have to read HTML.',
        '内容协商（Accept: text/markdown）和同路径的 .md 地址都没有返回 markdown。Agent 只能去读 HTML。',
      ),
    fix: ok
      ? tx('No change required.', '无需修改。')
      : tx(
        'Serve the page as markdown when the client sends Accept: text/markdown, or publish the same path with a .md suffix (https://<host>/docs/page.md).',
        '当客户端发送 Accept: text/markdown 时返回 markdown，或发布同路径的 .md（https://<主机>/docs/page.md）。',
      ),
    verify: tx(
      'curl -sH "Accept: text/markdown" https://<url> starts with a heading, or curl -s https://<url>.md does. Re-run the audit.',
      'curl -sH "Accept: text/markdown" https://<url> 以标题开头，或者 curl -s https://<url>.md 如此。然后重新审计。',
    ),
    evidence: asEvidence({
      negotiation: negotiated
        ? { url: negotiated.url, status: negotiated.status, contentType: negotiated.contentType, ok: negotiationOk, error: negotiated.error ?? null }
        : null,
      dotMd: dotMd
        ? { url: dotMd.url, status: dotMd.status, contentType: dotMd.contentType, ok: dotOk, error: dotMd.error ?? null }
        : null,
    }),
  }
}

/** `https://host/docs/page` → `https://host/docs/page.md`; a trailing slash becomes index.md. */
export function markdownSiblingUrl(raw: string): string | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.pathname.endsWith('.md')) return null
  if (url.pathname.endsWith('/')) url.pathname += 'index.md'
  else url.pathname += '.md'
  return url.toString()
}
