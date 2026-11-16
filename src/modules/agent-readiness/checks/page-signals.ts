import { createDeprecationService } from '../../schema-generator/deprecated-types.js'
import { createSchemaRegistry } from '../../schema-generator/schema-registry.js'
import { asEvidence, tx, type AgentReadinessCheck, type CheckStatus } from '../types.js'
import { CHECK_WEIGHTS } from '../weights.js'

const registry = createSchemaRegistry()
const deprecation = createDeprecationService()

export interface JsonLdBlock {
  types: string[]
  parseError: string | null
}

export function extractJsonLd(html: string): JsonLdBlock[] {
  const blocks: JsonLdBlock[] = []
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi
  for (const match of html.matchAll(re)) {
    const attrs = match[1] ?? ''
    if (!/type\s*=\s*["']application\/ld\+json["']/i.test(attrs)) continue
    let raw = (match[2] ?? '').trim()
    if (raw.startsWith('<!--')) raw = raw.replace(/^<!--/, '').replace(/-->$/, '').trim()
    try {
      const parsed = JSON.parse(raw) as unknown
      const types: string[] = []
      collectTypes(parsed, types)
      blocks.push({ types, parseError: null })
    } catch (err) {
      blocks.push({ types: [], parseError: err instanceof Error ? err.message : 'invalid json' })
    }
  }
  return blocks
}

function collectTypes(node: unknown, types: string[]): void {
  if (Array.isArray(node)) {
    for (const item of node) collectTypes(item, types)
    return
  }
  if (!node || typeof node !== 'object') return
  const obj = node as Record<string, unknown>
  const t = obj['@type']
  if (typeof t === 'string' && t) types.push(t)
  else if (Array.isArray(t)) {
    for (const item of t) if (typeof item === 'string' && item) types.push(item)
  }
  if (obj['@graph']) collectTypes(obj['@graph'], types)
}

export function visibleText(html: string): string {
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<template[\s\S]*?<\/template>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
  return decodeEntities(stripped).replace(/\s+/g, ' ').trim()
}

export function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => safeCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => safeCodePoint(parseInt(n, 16)))
}

function safeCodePoint(n: number): string {
  if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return ''
  try {
    return String.fromCodePoint(n)
  } catch {
    return ''
  }
}

function tagAttrs(html: string, tag: string): string[] {
  const re = new RegExp(`<${tag}\\b[^>]*>`, 'gi')
  return html.match(re) ?? []
}

function attr(tag: string, name: string): string | null {
  const re = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'=<>]+))`, 'i')
  const match = tag.match(re)
  const value = match?.[2] ?? match?.[3] ?? match?.[4]
  return value == null ? null : decodeEntities(value)
}

export function metaContents(html: string, key: string, kind: 'name' | 'property'): string[] {
  const out: string[] = []
  for (const tag of tagAttrs(html, 'meta')) {
    const id = attr(tag, kind)
    if (id && id.toLowerCase() === key.toLowerCase()) {
      const content = attr(tag, 'content')
      if (content != null) out.push(content)
    }
  }
  return out
}

export function linkHref(html: string, rel: string): string | null {
  for (const tag of tagAttrs(html, 'link')) {
    const relVal = attr(tag, 'rel')
    if (!relVal) continue
    const parts = relVal.toLowerCase().split(/\s+/)
    if (!parts.includes(rel.toLowerCase())) continue
    const href = attr(tag, 'href')
    if (href) return href
  }
  return null
}

export function htmlLang(html: string): string | null {
  const tag = html.match(/<html\b[^>]*>/i)?.[0]
  if (!tag) return null
  return attr(tag, 'lang')
}

export function hasSpaShell(html: string): boolean {
  return /\bid\s*=\s*["'](app|root|__next|__nuxt|__app)["']/i.test(html)
}

export interface PageSignalInput {
  /** Page was fetched well enough to inspect. */
  available: boolean
  url: string
  finalUrl: string
  status: number
  headers: Record<string, string>
  html: string
  error?: string
}

function skipped(id: keyof typeof CHECK_WEIGHTS, title: ReturnType<typeof tx>, reason: ReturnType<typeof tx>): AgentReadinessCheck {
  return {
    id,
    category: 'page',
    title,
    status: 'warn',
    weight: CHECK_WEIGHTS[id],
    applicable: false,
    explanation: reason,
    fix: tx('Fix the HTTP fetch first, then re-run. These page checks are not double-counted.', '先让页面抓取成功，再重新审计。这些页面检查不会重复扣分。'),
    verify: tx('The access check passes, then these checks become applicable.', '访问检查通过后，这些项才会计入分数。'),
    evidence: asEvidence({ skipped: true }),
  }
}

const SKIP_REASON = tx(
  'Skipped because the HTML response was not available. The access check already records the failure.',
  '没有拿到 HTML，本项不重复计分。失败已记在访问检查上。',
)

export function checkPageSignals(input: PageSignalInput): AgentReadinessCheck[] {
  const titles = {
    jsonld: tx('Schema.org JSON-LD is present', '存在 Schema.org JSON-LD'),
    description: tx('Meta description is usable', 'meta description 可用'),
    canonical: tx('Canonical URL is set', '已设置 canonical'),
    lang: tx('Page declares a language', '页面声明了语言'),
    og: tx('Open Graph title and description', 'Open Graph 标题与描述'),
    ssr: tx('Server-rendered text is visible', '服务端直出的可见文本'),
    robots: tx('Page is indexable', '页面允许索引'),
  }
  if (!input.available) {
    return [
      skipped('page.jsonld', titles.jsonld, SKIP_REASON),
      skipped('page.meta-description', titles.description, SKIP_REASON),
      skipped('page.canonical', titles.canonical, SKIP_REASON),
      skipped('page.lang', titles.lang, SKIP_REASON),
      skipped('page.open-graph', titles.og, SKIP_REASON),
      skipped('page.ssr-text', titles.ssr, SKIP_REASON),
      skipped('page.robots-directives', titles.robots, SKIP_REASON),
    ]
  }

  return [
    jsonLdCheck(input.html),
    descriptionCheck(input.html),
    canonicalCheck(input),
    langCheck(input.html),
    openGraphCheck(input.html),
    ssrCheck(input.html),
    robotsDirectiveCheck(input),
  ]
}

function jsonLdCheck(html: string): AgentReadinessCheck {
  const blocks = extractJsonLd(html)
  const parsed = blocks.filter((b) => !b.parseError)
  const errors = blocks.filter((b) => b.parseError)
  const types = [...new Set(parsed.flatMap((b) => b.types))]
  const supported = types.filter((t) => registry.isSupported(t))
  const deprecated = types
    .filter((t) => deprecation.isDeprecated(t))
    .map((t) => ({ type: t, replacement: deprecation.getReplacement(t) }))
  const unknown = types.filter((t) => !registry.isSupported(t) && !deprecation.isDeprecated(t))

  let status: CheckStatus = 'pass'
  let explanation = tx(
    `Found JSON-LD types: ${types.join(', ') || '(none)'}. Recognized by the schema registry: ${supported.join(', ') || '(none)'}.`,
    `发现 JSON-LD 类型：${types.join('、') || '（无）'}。Schema 注册表已支持：${supported.join('、') || '（无）'}。`,
  )
  let fix = tx('No change required.', '无需修改。')

  if (blocks.length === 0) {
    status = 'warn'
    explanation = tx(
      'No application/ld+json block in the raw HTML. Answer engines that do not execute JavaScript will not see structured types.',
      '原始 HTML 里没有 application/ld+json。不执行 JavaScript 的回答引擎看不到结构化类型。',
    )
    fix = tx(
      'Embed JSON-LD in the server-rendered HTML. Organization, WebSite, and FAQPage are the usual GEO set; generate them from the schema screen.',
      '把 JSON-LD 写进服务端渲染的 HTML。GEO 常用 Organization、WebSite 和 FAQPage，可在 Schema 生成页产出。',
    )
  } else if (parsed.length === 0) {
    status = 'fail'
    explanation = tx(
      `Found ${errors.length} JSON-LD script(s) and none parsed as JSON.`,
      `发现 ${errors.length} 段 JSON-LD，但都不是合法 JSON。`,
    )
    fix = tx(
      'Validate the script body with a JSON parser. Do not leave trailing commas or HTML comments inside the script.',
      '用 JSON 解析器校验 script 正文。不要留下尾逗号，也不要把 HTML 注释留在 script 里。',
    )
  } else if (supported.length === 0) {
    status = 'warn'
    explanation = tx(
      `JSON-LD parsed, but none of the types are in the schema registry${deprecated.length ? ` (deprecated: ${deprecated.map((d) => d.type).join(', ')})` : ''}${unknown.length ? ` (unrecognized: ${unknown.join(', ')})` : ''}.`,
      `JSON-LD 能解析，但类型都不在 Schema 注册表中${deprecated.length ? `（已废弃：${deprecated.map((d) => d.type).join('、')}）` : ''}${unknown.length ? `（未识别：${unknown.join('、')}）` : ''}。`,
    )
    fix = tx(
      'Add a supported type such as Organization, WebSite, Article, Product, or FAQPage. Replace deprecated types with the registry replacement when one exists.',
      '补一个已支持的类型，例如 Organization、WebSite、Article、Product 或 FAQPage。废弃类型如果注册表给出了替代，就换掉。',
    )
  }

  return {
    id: 'page.jsonld',
    category: 'page',
    title: tx('Schema.org JSON-LD is present', '存在 Schema.org JSON-LD'),
    status,
    weight: CHECK_WEIGHTS['page.jsonld'],
    applicable: true,
    explanation,
    fix,
    verify: tx(
      'View source (not the DOM inspector) and confirm a script type="application/ld+json" is in the HTML. Re-run the audit.',
      '查看网页源代码（不是 DOM 检查器），确认 HTML 里有 script type="application/ld+json"。然后重新审计。',
    ),
    evidence: asEvidence({
      blocks: blocks.length,
      parseErrors: errors.length,
      types,
      supported,
      deprecated,
      unknown,
    }),
  }
}

function descriptionCheck(html: string): AgentReadinessCheck {
  const value = metaContents(html, 'description', 'name')[0]?.trim() ?? ''
  let status: CheckStatus = 'pass'
  let explanation = tx(`Meta description is ${value.length} characters.`, `meta description 长度为 ${value.length} 个字符。`)
  let fix = tx('No change required.', '无需修改。')
  if (!value) {
    status = 'warn'
    explanation = tx('No meta name="description". Answer engines and link previews fall back to whatever text they can scrape.', '没有 meta name="description"。回答引擎和链接预览只能去刮页面里的其它文字。')
    fix = tx('Add a 50–160 character description that states what the page is and who it is for.', '加上 50–160 字的描述，写清这个页面是什么、给谁看。')
  } else if (value.length < 50 || value.length > 160) {
    status = 'warn'
    explanation = tx(
      `Meta description is ${value.length} characters. Aim for 50–160 so it is specific without being truncated.`,
      `meta description 有 ${value.length} 个字符。建议 50–160，既具体又不会被截断。`,
    )
    fix = tx('Rewrite the description into that range. Keep the primary entity name in the sentence.', '把描述改到这个长度，并在句子里保留主要实体名称。')
  }
  return {
    id: 'page.meta-description',
    category: 'page',
    title: tx('Meta description is usable', 'meta description 可用'),
    status,
    weight: CHECK_WEIGHTS['page.meta-description'],
    applicable: true,
    explanation,
    fix,
    verify: tx('curl -s the page and grep name="description". Re-run the audit.', 'curl -s 页面并 grep name="description"。然后重新审计。'),
    evidence: asEvidence({ length: value.length, present: Boolean(value) }),
  }
}

function canonicalCheck(input: PageSignalInput): AgentReadinessCheck {
  const href = linkHref(input.html, 'canonical')
  let status: CheckStatus = 'pass'
  let resolved: string | null = null
  let explanation = tx('A canonical link is present.', '已设置 canonical 链接。')
  let fix = tx('No change required.', '无需修改。')
  if (!href) {
    status = 'warn'
    explanation = tx('No rel=canonical. Duplicate URLs can split the signals answer engines associate with the page.', '没有 rel=canonical。重复 URL 会把回答引擎认到的信号拆散。')
    fix = tx('Add <link rel="canonical" href="https://<host>/<path>"> pointing at the preferred URL.', '加上 <link rel="canonical" href="https://<主机>/<路径>">，指向首选 URL。')
  } else {
    try {
      resolved = new URL(href, input.finalUrl).toString()
      const canon = new URL(resolved)
      const page = new URL(input.finalUrl)
      if (canon.origin !== page.origin) {
        status = 'warn'
        explanation = tx(
          `Canonical ${resolved} is on a different origin than ${input.finalUrl}.`,
          `canonical ${resolved} 与页面 ${input.finalUrl} 不在同一个源。`,
        )
        fix = tx('Point canonical at the preferred URL on this host, unless this page is intentionally consolidated elsewhere.', '把 canonical 指到本主机上的首选 URL，除非这个页面故意合并到别的站点。')
      }
    } catch {
      status = 'fail'
      explanation = tx(`Canonical href "${href}" is not a valid URL.`, `canonical href「${href}」不是合法 URL。`)
      fix = tx('Replace it with an absolute https URL.', '改成绝对的 https URL。')
    }
  }
  return {
    id: 'page.canonical',
    category: 'page',
    title: tx('Canonical URL is set', '已设置 canonical'),
    status,
    weight: CHECK_WEIGHTS['page.canonical'],
    applicable: true,
    explanation,
    fix,
    verify: tx('View source and confirm exactly one rel=canonical. Re-run the audit.', '查看源代码，确认只有一个 rel=canonical。然后重新审计。'),
    evidence: asEvidence({ href: href ?? null, resolved }),
  }
}

function langCheck(html: string): AgentReadinessCheck {
  const lang = htmlLang(html)
  return {
    id: 'page.lang',
    category: 'page',
    title: tx('Page declares a language', '页面声明了语言'),
    status: lang ? 'pass' : 'warn',
    weight: CHECK_WEIGHTS['page.lang'],
    applicable: true,
    explanation: lang
      ? tx(`html lang="${lang}".`, `html lang="${lang}"。`)
      : tx('The <html> element has no lang attribute. Language detection then guesses, which hurts both accessibility and answer-engine locale matching.', '<html> 没有 lang。语言只能靠猜测，无障碍和回答引擎的语言匹配都会变差。'),
    fix: lang
      ? tx('No change required.', '无需修改。')
      : tx('Set <html lang="zh-CN"> or the real page language (BCP 47).', '设置 <html lang="zh-CN">，或页面真实的 BCP 47 语言标签。'),
    verify: tx('View source and check the <html> tag. Re-run the audit.', '查看源代码里的 <html> 标签。然后重新审计。'),
    evidence: asEvidence({ lang }),
  }
}

function openGraphCheck(html: string): AgentReadinessCheck {
  const title = metaContents(html, 'og:title', 'property')[0]?.trim() ?? ''
  const description = metaContents(html, 'og:description', 'property')[0]?.trim() ?? ''
  const status: CheckStatus = title && description ? 'pass' : 'warn'
  return {
    id: 'page.open-graph',
    category: 'page',
    title: tx('Open Graph title and description', 'Open Graph 标题与描述'),
    status,
    weight: CHECK_WEIGHTS['page.open-graph'],
    applicable: true,
    explanation: tx(
      `og:title ${title ? 'present' : 'missing'}, og:description ${description ? 'present' : 'missing'}.`,
      `og:title ${title ? '已设置' : '缺失'}，og:description ${description ? '已设置' : '缺失'}。`,
    ),
    fix: status === 'pass'
      ? tx('No change required.', '无需修改。')
      : tx(
        'Add og:title and og:description meta tags. They are what chat apps and some crawlers show when they unfurl the URL.',
        '补上 og:title 和 og:description。聊天应用和部分爬虫展开链接时用的就是这两项。',
      ),
    verify: tx('curl -s the page and grep property="og:. Re-run the audit.', 'curl -s 页面并 grep property="og:。然后重新审计。'),
    evidence: asEvidence({ hasTitle: Boolean(title), hasDescription: Boolean(description) }),
  }
}

function ssrCheck(html: string): AgentReadinessCheck {
  const text = visibleText(html)
  const spa = hasSpaShell(html)
  let status: CheckStatus = 'pass'
  let explanation = tx(
    `Raw HTML contains about ${text.length} characters of visible text.`,
    `原始 HTML 里大约有 ${text.length} 个字符的可见文本。`,
  )
  let fix = tx('No change required.', '无需修改。')
  if (text.length < 150) {
    status = 'fail'
    explanation = tx(
      `Only ${text.length} characters of visible text in the raw HTML${spa ? ', and the page looks like a client-rendered shell (app/root mount point)' : ''}. Crawlers that do not run JavaScript will index an empty page.`,
      `原始 HTML 里只有 ${text.length} 个字符的可见文本${spa ? '，而且页面像客户端渲染外壳（存在 app/root 挂载点）' : ''}。不执行 JavaScript 的爬虫会索引到一个空页面。`,
    )
    fix = tx(
      'Server-render the primary copy (title, summary, and the citable paragraphs) into the HTML. Do not rely on a hydration-only shell.',
      '把主要文案（标题、摘要、可被引用的段落）直接渲染进 HTML，不要只靠注水后的空壳。',
    )
  } else if (text.length < 400) {
    status = 'warn'
    explanation = tx(
      `Visible text is ${text.length} characters. That is enough to prove the page is not empty, but thin for citation.`,
      `可见文本 ${text.length} 个字符。这能证明页面不是空的，但对引用来说偏薄。`,
    )
    fix = tx(
      'Add a server-rendered summary of at least a few sentences, with the facts you want cited.',
      '在服务端渲染里补上至少几句话的摘要，写上希望被引用的事实。',
    )
  }
  return {
    id: 'page.ssr-text',
    category: 'page',
    title: tx('Server-rendered text is visible', '服务端直出的可见文本'),
    status,
    weight: CHECK_WEIGHTS['page.ssr-text'],
    applicable: true,
    explanation,
    fix,
    verify: tx(
      'curl -s the URL and read the body with scripts removed. You should see the same sentences a reader sees. Re-run the audit.',
      'curl -s 该 URL，去掉 script 后仍能读到读者看到的句子。然后重新审计。',
    ),
    evidence: asEvidence({ textLength: text.length, spaShell: spa }),
  }
}

function robotsDirectiveCheck(input: PageSignalInput): AgentReadinessCheck {
  const metas = [
    ...metaContents(input.html, 'robots', 'name'),
    ...metaContents(input.html, 'googlebot', 'name'),
  ]
  const header = input.headers['x-robots-tag'] ?? ''
  const tokens = new Set<string>()
  const absorb = (value: string) => {
    for (const part of value.split(/[,;]/)) {
      const token = part.trim().toLowerCase()
      if (token) tokens.add(token)
    }
  }
  metas.forEach(absorb)
  if (header) absorb(header)

  const list = [...tokens]
  const noindex = list.some((t) => t === 'noindex' || t === 'none')
  const nosnippet = list.some((t) => t === 'nosnippet' || t.startsWith('max-snippet:0'))
  const nofollow = list.includes('nofollow')
  let status: CheckStatus = 'pass'
  let explanation = tx('No noindex or nosnippet directive on the page.', '页面没有 noindex 或 nosnippet。')
  let fix = tx('No change required.', '无需修改。')
  if (noindex) {
    status = 'fail'
    explanation = tx(
      `The page asks crawlers not to index it (${list.join(', ') || 'noindex'}). Answer engines will not cite a URL they are told to skip.`,
      `页面要求爬虫不要索引（${list.join(', ') || 'noindex'}）。回答引擎不会引用一个被明确要求跳过的 URL。`,
    )
    fix = tx(
      'Remove noindex / none from the meta robots tag and from the X-Robots-Tag header on this URL.',
      '从该 URL 的 meta robots 和 X-Robots-Tag 响应头里去掉 noindex / none。',
    )
  } else if (nosnippet) {
    status = 'warn'
    explanation = tx(
      'nosnippet or max-snippet:0 is set. Crawlers may index the URL but are asked not to show a snippet, which is the part answer engines quote.',
      '设置了 nosnippet 或 max-snippet:0。爬虫也许会索引 URL，但被要求不展示摘要，而摘要正是回答引擎会引用的部分。',
    )
    fix = tx('Remove nosnippet and max-snippet:0 unless this page must not be quoted.', '去掉 nosnippet 和 max-snippet:0，除非这个页面明确不能被引用。')
  } else if (nofollow) {
    status = 'warn'
    explanation = tx(
      'nofollow is set. The page itself can still be indexed, but crawlers are asked not to follow its links.',
      '设置了 nofollow。页面本身仍可被索引，但爬虫被要求不要跟踪其中的链接。',
    )
    fix = tx('Drop nofollow on pages whose outbound links should be discovered.', '如果希望站内链接被发现，就去掉 nofollow。')
  }
  return {
    id: 'page.robots-directives',
    category: 'page',
    title: tx('Page is indexable', '页面允许索引'),
    status,
    weight: CHECK_WEIGHTS['page.robots-directives'],
    applicable: true,
    explanation,
    fix,
    verify: tx(
      'curl -sI the URL and confirm there is no X-Robots-Tag: noindex. View source and confirm meta robots is absent or "index, follow". Re-run the audit.',
      'curl -sI 该 URL，确认没有 X-Robots-Tag: noindex。源代码里的 meta robots 应不存在或为 "index, follow"。然后重新审计。',
    ),
    evidence: asEvidence({ directives: list, xRobotsTag: header || null }),
  }
}
