import { asEvidence, tx, type AgentReadinessCheck, type CheckStatus } from '../types.js'
import { CHECK_WEIGHTS } from '../weights.js'

export interface LlmsLink {
  label: string
  url: string
  description: string | null
}

export interface LlmsSection {
  title: string
  links: LlmsLink[]
}

export interface ParsedLlmsTxt {
  hasH1: boolean
  h1: string | null
  hasBlockquote: boolean
  summary: string | null
  sections: LlmsSection[]
  links: LlmsLink[]
}

const LINK_RE = /^\[([^\]]+)\]\(([^)\s]+)\)(?::\s*(.*))?$/

/** llmstxt.org: H1 title, optional-but-expected blockquote, H2 sections of links. */
export function parseLlmsTxt(markdown: string): ParsedLlmsTxt {
  const lines = markdown.replace(/^\uFEFF/, '').split(/\r?\n/)
  let h1: string | null = null
  const summaries: string[] = []
  const sections: LlmsSection[] = []
  let current: LlmsSection | null = null

  for (const line of lines) {
    const trimmed = line.trim()
    if (!h1 && trimmed.startsWith('# ') && !trimmed.startsWith('## ')) {
      h1 = trimmed.slice(2).trim() || null
      continue
    }
    if (trimmed.startsWith('>')) {
      const text = trimmed.replace(/^>\s?/, '').trim()
      if (text) summaries.push(text)
      continue
    }
    if (trimmed.startsWith('## ') && !trimmed.startsWith('### ')) {
      current = { title: trimmed.slice(3).trim(), links: [] }
      sections.push(current)
      continue
    }
    if (current && trimmed.startsWith('- ')) {
      const match = trimmed.slice(2).trim().match(LINK_RE)
      if (match) {
        const link: LlmsLink = {
          label: match[1].trim(),
          url: match[2].trim(),
          description: match[3]?.trim() || null,
        }
        current.links.push(link)
      }
    }
  }

  const links = sections.flatMap((s) => s.links)
  return {
    hasH1: Boolean(h1),
    h1,
    hasBlockquote: summaries.length > 0,
    summary: summaries.join(' ') || null,
    sections,
    links,
  }
}

export function looksLikeHtmlDocument(body: string, contentType?: string): boolean {
  if (contentType && /text\/html|application\/xhtml/i.test(contentType)) return true
  const head = body.trimStart().slice(0, 300).toLowerCase()
  return head.startsWith('<!doctype html') || head.startsWith('<html') || head.startsWith('<head')
}

export interface LlmsPresenceInput {
  status: number
  body: string
  contentType?: string
  error?: string
}

export function checkLlmsTxt(input: LlmsPresenceInput): { check: AgentReadinessCheck; parsed: ParsedLlmsTxt | null } {
  const missing = input.status === 404 || input.status === 410
  const transportFailed = Boolean(input.error) || (input.status !== 200 && !missing)
  if (transportFailed) {
    return {
      parsed: null,
      check: {
        id: 'llms.txt',
        category: 'llms',
        title: tx('llms.txt is present and valid', 'llms.txt 存在且格式有效'),
        status: 'fail',
        weight: CHECK_WEIGHTS['llms.txt'],
        applicable: true,
        explanation: tx(
          `Could not read /llms.txt (${input.error ?? `HTTP ${input.status}`}).`,
          `无法读取 /llms.txt（${input.error ?? `HTTP ${input.status}`}）。`,
        ),
        fix: tx(
          'Serve /llms.txt over HTTPS with HTTP 200. GeoCiteOps can generate the file from the llms.txt editor.',
          '通过 HTTPS 在 /llms.txt 返回 HTTP 200。GeoCiteOps 的 llms.txt 编辑器可以直接生成这个文件。',
        ),
        verify: tx('curl -sI https://<host>/llms.txt returns 200.', 'curl -sI https://<主机>/llms.txt 返回 200。'),
        evidence: asEvidence({ status: input.status, error: input.error ?? null }),
      },
    }
  }

  if (missing || !input.body.trim() || looksLikeHtmlDocument(input.body, input.contentType)) {
    return {
      parsed: null,
      check: {
        id: 'llms.txt',
        category: 'llms',
        title: tx('llms.txt is present and valid', 'llms.txt 存在且格式有效'),
        status: 'warn',
        weight: CHECK_WEIGHTS['llms.txt'],
        applicable: true,
        explanation: tx(
          'No llms.txt was found. The format is still a proposal: major answer engines have not confirmed they consume it, so a missing file warns instead of failing. It remains the file GEO teams publish so crawlers can discover canonical URLs.',
          '没有发现 llms.txt。该格式仍是提案，主流回答引擎尚未确认会消费它，因此缺失记为警告而不是失败。它仍然是 GEO 团队用来告诉爬虫「哪些 URL 是权威页面」的文件。',
        ),
        fix: tx(
          'Publish /llms.txt with an H1 title, a blockquote summary, and H2 sections of markdown links. Generate it from the console llms.txt editor, then deploy it at the site root.',
          '在站点根目录发布 /llms.txt：H1 标题、一段 blockquote 摘要，以及用 H2 分节的 markdown 链接。可在控制台的 llms.txt 编辑器生成后部署。',
        ),
        verify: tx(
          'curl -s https://<host>/llms.txt starts with "# " and the next content line starts with "> ".',
          'curl -s https://<主机>/llms.txt 以「# 」开头，紧接着的内容行以「> 」开头。',
        ),
        evidence: asEvidence({ status: input.status, htmlDisguised: looksLikeHtmlDocument(input.body, input.contentType) }),
      },
    }
  }

  const parsed = parseLlmsTxt(input.body)
  const linkCount = parsed.links.length
  let status: CheckStatus = 'pass'
  let explanation = tx(
    `llms.txt has an H1 ("${parsed.h1}"), a blockquote summary, and ${linkCount} link(s) across ${parsed.sections.length} section(s).`,
    `llms.txt 含 H1（「${parsed.h1}」）、blockquote 摘要，以及 ${parsed.sections.length} 个小节中的 ${linkCount} 个链接。`,
  )
  let fix = tx('No change required.', '无需修改。')
  if (!parsed.hasH1 || !parsed.hasBlockquote) {
    status = 'fail'
    const missingBits = [!parsed.hasH1 ? 'H1' : null, !parsed.hasBlockquote ? 'blockquote' : null].filter(Boolean).join(' and ')
    const missingZh = [!parsed.hasH1 ? 'H1 标题' : null, !parsed.hasBlockquote ? 'blockquote 摘要' : null].filter(Boolean).join('和')
    explanation = tx(
      `llms.txt is present but missing the ${missingBits} required by the basic llmstxt.org shape this audit checks.`,
      `llms.txt 存在，但缺少本审计按 llmstxt.org 基本结构要求的${missingZh}。`,
    )
    fix = tx(
      'Start the file with "# Site name", then a "> one-sentence summary", then "## Section" lists of "- [label](https://...): description".',
      '文件以「# 站点名」开头，下一行是「> 一句话摘要」，然后用「## 小节」列出「- [名称](https://...): 说明」。',
    )
  } else if (linkCount === 0) {
    status = 'warn'
    explanation = tx(
      'llms.txt has a title and summary but no H2 link sections. Crawlers get no URLs to follow.',
      'llms.txt 有标题和摘要，但没有任何 H2 链接小节，爬虫拿不到可跟随的 URL。',
    )
    fix = tx(
      'Add at least one "## Docs" (or similar) section with markdown links to canonical pages.',
      '至少增加一个「## 文档」之类的小节，里面放指向权威页面的 markdown 链接。',
    )
  }

  return {
    parsed,
    check: {
      id: 'llms.txt',
      category: 'llms',
      title: tx('llms.txt is present and valid', 'llms.txt 存在且格式有效'),
      status,
      weight: CHECK_WEIGHTS['llms.txt'],
      applicable: true,
      explanation,
      fix,
      verify: tx(
        'Confirm the file matches the H1 / blockquote / H2-link shape, then re-run the audit.',
        '确认文件符合 H1 / blockquote / H2 链接的结构后重新审计。',
      ),
      evidence: asEvidence({
        h1: parsed.h1,
        hasBlockquote: parsed.hasBlockquote,
        sectionCount: parsed.sections.length,
        linkCount,
        sections: parsed.sections.map((s) => s.title),
      }),
    },
  }
}

export function checkLlmsFull(input: LlmsPresenceInput): AgentReadinessCheck {
  const missing = input.status === 404 || input.status === 410 || !input.body.trim()
  const html = looksLikeHtmlDocument(input.body, input.contentType)
  if (input.error || (input.status !== 200 && input.status !== 404 && input.status !== 410 && input.status !== 0)) {
    return baseFull('fail', true, tx(
      `Could not read /llms-full.txt (${input.error ?? `HTTP ${input.status}`}).`,
      `无法读取 /llms-full.txt（${input.error ?? `HTTP ${input.status}`}）。`,
    ), { status: input.status, error: input.error ?? null })
  }
  if (missing || html) {
    return baseFull('warn', true, tx(
      'llms-full.txt is optional. It was not found. Publish it when you want crawlers to read full page text without rendering HTML.',
      'llms-full.txt 是可选文件，当前没有找到。如果希望爬虫不用渲染 HTML 就能读到完整正文，再发布它。',
    ), { status: input.status, present: false })
  }
  if (input.body.trim().length < 80) {
    return baseFull('warn', true, tx(
      'llms-full.txt exists but is almost empty.',
      'llms-full.txt 存在，但内容几乎为空。',
    ), { status: input.status, bytes: input.body.length })
  }
  return baseFull('pass', true, tx(
    `llms-full.txt is present (${input.body.length} characters).`,
    `llms-full.txt 存在（${input.body.length} 个字符）。`,
  ), { status: input.status, bytes: input.body.length })
}

function baseFull(status: CheckStatus, applicable: boolean, explanation: ReturnType<typeof tx>, evidence: object): AgentReadinessCheck {
  return {
    id: 'llms-full.txt',
    category: 'llms',
    title: tx('llms-full.txt is available', 'llms-full.txt 可获取'),
    status,
    weight: CHECK_WEIGHTS['llms-full.txt'],
    applicable,
    explanation,
    fix: status === 'pass'
      ? tx('No change required.', '无需修改。')
      : tx(
        'Optional: publish /llms-full.txt as the concatenation of the pages linked from llms.txt, in markdown.',
        '可选：把 llms.txt 所链接页面的 markdown 正文拼成 /llms-full.txt 发布。',
      ),
    verify: tx('curl -sI https://<host>/llms-full.txt returns 200 and a non-trivial body.', 'curl -sI https://<主机>/llms-full.txt 返回 200，且正文不是空文件。'),
    evidence: asEvidence(evidence),
  }
}

export interface LinkProbe {
  url: string
  status: number
  error?: string
}

export function checkLlmsLinks(parsed: ParsedLlmsTxt | null, probes: LinkProbe[]): AgentReadinessCheck {
  if (!parsed || parsed.links.length === 0) {
    return {
      id: 'llms.links',
      category: 'llms',
      title: tx('llms.txt links resolve', 'llms.txt 链接可访问'),
      status: 'warn',
      weight: CHECK_WEIGHTS['llms.links'],
      applicable: false,
      explanation: tx(
        'Skipped because there is no llms.txt link list to sample. Fix llms.txt first.',
        '没有可抽样的 llms.txt 链接，本项不重复计分。请先补上 llms.txt。',
      ),
      fix: tx('Add markdown links to llms.txt, then re-run.', '在 llms.txt 中加入 markdown 链接后重新审计。'),
      verify: tx('This check becomes applicable once llms.txt contains links.', 'llms.txt 含有链接后，本项才会计入分数。'),
      evidence: asEvidence({ sampled: 0 }),
    }
  }

  const ok = probes.filter((p) => p.status >= 200 && p.status < 400 && !p.error)
  const bad = probes.filter((p) => !ok.includes(p))
  let status: CheckStatus = 'pass'
  if (probes.length === 0) status = 'warn'
  else if (ok.length === 0) status = 'fail'
  else if (bad.length > 0) status = 'warn'

  return {
    id: 'llms.links',
    category: 'llms',
    title: tx('llms.txt links resolve', 'llms.txt 链接可访问'),
    status,
    weight: CHECK_WEIGHTS['llms.links'],
    applicable: true,
    explanation: tx(
      `Sampled ${probes.length} link(s): ${ok.length} reachable, ${bad.length} not.`,
      `抽样 ${probes.length} 个链接：${ok.length} 个可访问，${bad.length} 个不可访问。`,
    ),
    fix: status === 'pass'
      ? tx('No change required.', '无需修改。')
      : tx(
        'Point every llms.txt link at a URL that returns HTTP 200 without a login wall. Drop or replace the failing URLs.',
        '让 llms.txt 里的每个链接都返回 HTTP 200，且不需要登录。删掉或换掉失败的 URL。',
      ),
    verify: tx(
      'curl -sI each failing URL from the evidence list. Re-run the audit after they return 200.',
      '对证据里失败的 URL 执行 curl -sI。它们返回 200 后再审计。',
    ),
    evidence: asEvidence({
      sampled: probes.length,
      reachable: ok.length,
      probes: probes.map((p) => ({ url: p.url, status: p.status, error: p.error ?? null })),
    }),
  }
}
