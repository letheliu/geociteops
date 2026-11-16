import { AI_CRAWLERS, type AiCrawler, type CrawlerRole } from '../bots.js'
import { asEvidence, tx, type AgentReadinessCheck, type CheckStatus } from '../types.js'
import { CHECK_WEIGHTS } from '../weights.js'

export interface RobotsRule {
  type: 'allow' | 'disallow'
  pattern: string
}

export interface RobotsGroup {
  agents: string[]
  rules: RobotsRule[]
}

export interface ParsedRobots {
  groups: RobotsGroup[]
  sitemaps: string[]
}

export interface RobotsDecision {
  allowed: boolean
  source: 'specific' | 'wildcard' | 'default'
  matchedRule: string | null
}

export interface BotAccessRow {
  id: string
  token: string
  vendor: string
  role: CrawlerRole
  allowed: boolean | null
  source: 'specific' | 'wildcard' | 'default' | 'unknown'
  matchedRule: string | null
}

export function parseRobotsTxt(text: string): ParsedRobots {
  const groups: RobotsGroup[] = []
  const sitemaps: string[] = []
  let current: RobotsGroup | null = null
  let seenRule = false

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim()
    if (!line) continue
    const idx = line.indexOf(':')
    if (idx < 0) continue
    const field = line.slice(0, idx).trim().toLowerCase()
    const value = line.slice(idx + 1).trim()
    if (field === 'user-agent') {
      if (!value) continue
      if (!current || seenRule) {
        current = { agents: [], rules: [] }
        groups.push(current)
        seenRule = false
      }
      current.agents.push(value)
    } else if (field === 'allow' || field === 'disallow') {
      if (!current) continue
      seenRule = true
      current.rules.push({ type: field, pattern: value })
    } else if (field === 'sitemap') {
      if (value) sitemaps.push(value)
    }
  }

  return { groups: groups.filter((g) => g.agents.length > 0), sitemaps }
}

function ruleMatches(pattern: string, path: string): boolean {
  if (!pattern) return false
  let source = pattern
  let endAnchor = false
  if (source.endsWith('$')) {
    endAnchor = true
    source = source.slice(0, -1)
  }
  const escaped = source.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${escaped}${endAnchor ? '$' : ''}`).test(path)
}

function agentMatches(agent: string, token: string): boolean {
  const a = agent.trim().toLowerCase()
  const t = token.trim().toLowerCase()
  if (!a || a === '*') return false
  if (a === t) return true
  // robots.txt matches the crawler token as a substring (Google's rule).
  // Require 3+ characters so a one-letter group cannot capture every bot.
  if (a.length < 3) return false
  return t.includes(a) || a.includes(t)
}

/**
 * Longest matching Allow/Disallow wins. Equal length: Allow wins.
 * A specific user-agent group beats `*`. No matching group means allow.
 */
export function robotsDecision(parsed: ParsedRobots, token: string, path: string): RobotsDecision {
  let bestLen = -1
  const specific: RobotsGroup[] = []
  const wildcard: RobotsGroup[] = []

  for (const group of parsed.groups) {
    let groupBest = -1
    for (const agent of group.agents) {
      if (agent.trim() === '*') {
        wildcard.push(group)
        continue
      }
      if (agentMatches(agent, token)) groupBest = Math.max(groupBest, agent.trim().length)
    }
    if (groupBest < 0) continue
    if (groupBest > bestLen) {
      bestLen = groupBest
      specific.length = 0
      specific.push(group)
    } else if (groupBest === bestLen) {
      specific.push(group)
    }
  }

  const groups = specific.length > 0 ? specific : wildcard
  const source: RobotsDecision['source'] = specific.length > 0 ? 'specific' : wildcard.length > 0 ? 'wildcard' : 'default'
  if (groups.length === 0) return { allowed: true, source: 'default', matchedRule: null }

  let winner: { type: 'allow' | 'disallow'; pattern: string; len: number } | null = null
  for (const rule of groups.flatMap((g) => g.rules)) {
    if (!rule.pattern || !ruleMatches(rule.pattern, path)) continue
    const len = rule.pattern.length
    if (
      !winner ||
      len > winner.len ||
      (len === winner.len && rule.type === 'allow' && winner.type === 'disallow')
    ) {
      winner = { type: rule.type, pattern: rule.pattern, len }
    }
  }
  if (!winner) return { allowed: true, source, matchedRule: null }
  const label = winner.type === 'allow' ? 'Allow' : 'Disallow'
  return { allowed: winner.type === 'allow', source, matchedRule: `${label}: ${winner.pattern}` }
}

function looksLikeHtml(body: string, contentType: string | undefined): boolean {
  if (contentType && /text\/html|application\/xhtml/i.test(contentType)) return true
  const head = body.trimStart().slice(0, 200).toLowerCase()
  return head.startsWith('<!doctype html') || head.startsWith('<html') || head.startsWith('<head')
}

function rowsFor(bots: readonly AiCrawler[], parsed: ParsedRobots | null, path: string, known: boolean): BotAccessRow[] {
  return bots.map((bot) => {
    if (!known || !parsed) {
      return {
        id: bot.id,
        token: bot.token,
        vendor: bot.vendor,
        role: bot.role,
        allowed: null,
        source: 'unknown',
        matchedRule: null,
      }
    }
    const decision = robotsDecision(parsed, bot.token, path)
    return {
      id: bot.id,
      token: bot.token,
      vendor: bot.vendor,
      role: bot.role,
      allowed: decision.allowed,
      source: decision.source,
      matchedRule: decision.matchedRule,
    }
  })
}

function blocked(rows: BotAccessRow[], role: CrawlerRole): BotAccessRow[] {
  return rows.filter((r) => r.role === role && r.allowed === false)
}

export interface RobotsCheckInput {
  status: number
  body: string
  contentType?: string
  error?: string
  /** URL path (pathname + search) the rules are evaluated against. */
  path: string
  truncated?: boolean
  bots?: readonly AiCrawler[]
}

export interface RobotsCheckResult {
  checks: AgentReadinessCheck[]
  sitemaps: string[]
  bots: BotAccessRow[]
}

function unreachable(input: RobotsCheckInput, bots: readonly AiCrawler[]): RobotsCheckResult {
  const rows = rowsFor(bots, null, input.path, false)
  const why = input.error === 'html'
    ? 'robots.txt 的地址返回了 HTML，不是纯文本规则。'
    : input.error
      ? `robots.txt 请求失败（${input.error}）。`
      : `robots.txt 返回 HTTP ${input.status}。`
  const whyEn = input.error === 'html'
    ? 'The robots.txt URL returned HTML instead of a plain-text rules file.'
    : input.error
      ? `Fetching robots.txt failed (${input.error}).`
      : `robots.txt returned HTTP ${input.status}.`
  return {
    sitemaps: [],
    bots: rows,
    checks: [
      {
        id: 'robots.reachable',
        category: 'robots',
        title: tx('robots.txt can be fetched', 'robots.txt 可抓取'),
        status: 'fail',
        weight: CHECK_WEIGHTS['robots.reachable'],
        applicable: true,
        explanation: tx(
          `${whyEn} Google treats a 5xx robots.txt as temporarily unavailable and may stop crawling. A 401/403 is treated as disallow.`,
          `${why}搜索引擎通常把 5xx 视为暂时不可用并暂停抓取，把 401/403 视为禁止抓取。`,
        ),
        fix: tx(
          'Serve a plain-text robots.txt at /robots.txt with HTTP 200. Explicitly allow answer crawlers (OAI-SearchBot, Claude-SearchBot, PerplexityBot, ChatGPT-User) and Googlebot/Bingbot.',
          '在 /robots.txt 以 HTTP 200 返回纯文本。明确放行回答引擎爬虫（OAI-SearchBot、Claude-SearchBot、PerplexityBot、ChatGPT-User）以及 Googlebot / Bingbot。',
        ),
        verify: tx(
          'curl -sI https://<host>/robots.txt returns 200 and Content-Type text/plain. curl -s shows User-agent groups.',
          'curl -sI https://<主机>/robots.txt 返回 200 且 Content-Type 为 text/plain；curl -s 能看到 User-agent 分组。',
        ),
        evidence: asEvidence({ status: input.status, error: input.error ?? null }),
      },
      {
        id: 'robots.answer-bots',
        category: 'robots',
        title: tx('Answer-engine crawlers are allowed', '回答引擎爬虫被放行'),
        status: 'fail',
        weight: CHECK_WEIGHTS['robots.answer-bots'],
        applicable: true,
        explanation: tx(
          'The allow/disallow policy could not be read, so answer engines may not crawl the site.',
          '无法读取允许/禁止策略，回答引擎可能不会抓取该站点。',
        ),
        fix: tx(
          'Publish robots.txt and allow the answer-role tokens listed in the bot catalog.',
          '发布 robots.txt，并放行爬虫清单里角色为 answer 的 token。',
        ),
        verify: tx(
          'Re-run this audit. Each answer bot should show allowed=true.',
          '重新跑本审计，每个 answer 爬虫应显示为允许。',
        ),
        evidence: asEvidence({ bots: rows }),
      },
      {
        id: 'robots.search-bots',
        category: 'robots',
        title: tx('Search crawlers are allowed', '搜索爬虫被放行'),
        status: 'warn',
        weight: CHECK_WEIGHTS['robots.search-bots'],
        applicable: false,
        explanation: tx(
          'Skipped because robots.txt could not be parsed. The reachable check already covers this failure.',
          'robots.txt 无法解析，本项不重复计分。失败已记在「可抓取」检查上。',
        ),
        fix: tx('Fix robots.txt first, then re-check search crawlers.', '先修复 robots.txt，再复查搜索爬虫。'),
        verify: tx('The reachable check passes, then this check becomes applicable.', '「可抓取」通过后，本项才会计入分数。'),
        evidence: asEvidence({ bots: rows.filter((r) => r.role === 'search') }),
      },
    ],
  }
}

/**
 * robots.txt fetch + per-bot allow/disallow.
 * Training-crawler opt-outs are reported on the bot rows and do not fail the score.
 */
export function checkRobots(input: RobotsCheckInput): RobotsCheckResult {
  const bots = input.bots ?? AI_CRAWLERS
  const failedTransport = Boolean(input.error) || input.status === 0 || input.status >= 400
  if (input.status !== 404 && failedTransport) return unreachable(input, bots)

  if (input.status === 404) {
    const rows = rowsFor(bots, { groups: [], sitemaps: [] }, input.path, true).map((r) => ({
      ...r,
      allowed: true,
      source: 'default' as const,
    }))
    return {
      sitemaps: [],
      bots: rows,
      checks: [
        {
          id: 'robots.reachable',
          category: 'robots',
          title: tx('robots.txt can be fetched', 'robots.txt 可抓取'),
          status: 'warn',
          weight: CHECK_WEIGHTS['robots.reachable'],
          applicable: true,
          explanation: tx(
            'No robots.txt (HTTP 404). Crawlers default to allow, but there is no explicit policy for AI bots and no Sitemap directive to discover.',
            '没有 robots.txt（HTTP 404）。爬虫默认允许抓取，但缺少面向 AI 爬虫的明确策略，也没有 Sitemap 指令可发现站点地图。',
          ),
          fix: tx(
            'Publish /robots.txt that allows answer and search crawlers. Add a Sitemap: line pointing at the XML sitemap. Training opt-outs (GPTBot, CCBot, Google-Extended) can stay disallowed.',
            '发布 /robots.txt，放行 answer 与 search 爬虫，并加上 Sitemap: 指向 XML 站点地图。训练爬虫（GPTBot、CCBot、Google-Extended）可以继续禁止。',
          ),
          verify: tx(
            'curl -s https://<host>/robots.txt shows the groups. Re-run the audit and confirm this check passes.',
            'curl -s https://<主机>/robots.txt 能看到分组。重新审计，本项应为通过。',
          ),
          evidence: asEvidence({ status: 404 }),
        },
        answerCheck(rows, 'pass'),
        searchCheck(rows),
      ],
    }
  }

  if (looksLikeHtml(input.body, input.contentType)) {
    return unreachable({ ...input, error: input.error ?? 'html' }, bots)
  }

  const parsed = parseRobotsTxt(input.body)
  const rows = rowsFor(bots, parsed, input.path, true)
  const reachableStatus: CheckStatus = input.truncated ? 'warn' : 'pass'
  return {
    sitemaps: parsed.sitemaps,
    bots: rows,
    checks: [
      {
        id: 'robots.reachable',
        category: 'robots',
        title: tx('robots.txt can be fetched', 'robots.txt 可抓取'),
        status: reachableStatus,
        weight: CHECK_WEIGHTS['robots.reachable'],
        applicable: true,
        explanation: input.truncated
          ? tx(
            'robots.txt returned 200 but the body was truncated at the size limit, so later rules may be missing.',
            'robots.txt 返回 200，但正文超过大小上限被截断，后面的规则可能没有被读到。',
          )
          : tx(
            `robots.txt returned 200 and parsed into ${parsed.groups.length} group(s) and ${parsed.sitemaps.length} sitemap directive(s).`,
            `robots.txt 返回 200，解析出 ${parsed.groups.length} 个分组、${parsed.sitemaps.length} 条 Sitemap 指令。`,
          ),
        fix: input.truncated
          ? tx('Keep robots.txt under 512 KB and put the important groups first.', '把 robots.txt 控制在 512 KB 以内，并把重要分组放在前面。')
          : tx('No change required.', '无需修改。'),
        verify: tx(
          'curl -s https://<host>/robots.txt | head matches what this audit parsed.',
          'curl -s https://<主机>/robots.txt | head 与本次解析结果一致。',
        ),
        evidence: asEvidence({
          status: input.status,
          groups: parsed.groups.length,
          sitemaps: parsed.sitemaps,
          truncated: Boolean(input.truncated),
        }),
      },
      answerCheck(rows, answerStatus(rows)),
      searchCheck(rows),
    ],
  }
}

function answerStatus(rows: BotAccessRow[]): CheckStatus {
  const answer = rows.filter((r) => r.role === 'answer')
  const denied = blocked(rows, 'answer')
  if (answer.length === 0) return 'pass'
  if (denied.length === 0) return 'pass'
  if (denied.length * 2 >= answer.length) return 'fail'
  return 'warn'
}

function answerCheck(rows: BotAccessRow[], status: CheckStatus): AgentReadinessCheck {
  const denied = blocked(rows, 'answer')
  const trainingDenied = blocked(rows, 'training').map((r) => r.token)
  const names = denied.map((r) => r.token).join(', ')
  const trainingNote = trainingDenied.length
    ? ` Training opt-out is allowed and does not change this check: ${trainingDenied.join(', ')}.`
    : ''
  const trainingNoteZh = trainingDenied.length
    ? ` 训练爬虫的拒绝不会拉低本项：${trainingDenied.join('、')}。`
    : ''
  const explanation = status === 'pass'
    ? tx(
      `Answer crawlers are allowed for this path.${trainingNote}`,
      `该路径放行了回答引擎爬虫。${trainingNoteZh}`,
    )
    : tx(
      `Blocked answer crawlers: ${names}.${trainingNote} These tokens fetch pages for answers, which is separate from training opt-out.`,
      `被禁止的回答引擎爬虫：${names}。${trainingNoteZh}这些 token 会为了生成答案去抓页面，和训练爬虫的 opt-out 不是一回事。`,
    )
  return {
    id: 'robots.answer-bots',
    category: 'robots',
    title: tx('Answer-engine crawlers are allowed', '回答引擎爬虫被放行'),
    status,
    weight: CHECK_WEIGHTS['robots.answer-bots'],
    applicable: true,
    explanation,
    fix: status === 'pass'
      ? tx('No change required. Keep training opt-outs if you want them.', '无需修改。训练爬虫如需拒绝，可以继续 Disallow。')
      : tx(
        `Remove Disallow rules that match ${names} (or add a longer Allow). Leave GPTBot, CCBot, Bytespider, Google-Extended, and similar training tokens blocked if that is the policy you want.`,
        `删掉命中 ${names} 的 Disallow（或加一条更长的 Allow）。GPTBot、CCBot、Bytespider、Google-Extended 等训练 token 可以继续禁止。`,
      ),
    verify: tx(
      'curl -sA "<token>" is not something robots.txt changes; re-fetch /robots.txt and confirm the token\'s group has no Disallow: / . Re-run the audit.',
      'robots.txt 不改变 curl 的状态码。重新抓取 /robots.txt，确认这些 token 的分组没有 Disallow: /，然后重新审计。',
    ),
    evidence: asEvidence({ bots: rows, trainingOptOut: trainingDenied }),
  }
}

function searchCheck(rows: BotAccessRow[]): AgentReadinessCheck {
  const denied = blocked(rows, 'search')
  const major = denied.filter((r) => r.token === 'Googlebot' || r.token === 'Bingbot')
  const status: CheckStatus = major.length > 0 ? 'fail' : denied.length > 0 ? 'warn' : 'pass'
  const names = denied.map((r) => r.token).join(', ')
  return {
    id: 'robots.search-bots',
    category: 'robots',
    title: tx('Search crawlers are allowed', '搜索爬虫被放行'),
    status,
    weight: CHECK_WEIGHTS['robots.search-bots'],
    applicable: true,
    explanation: status === 'pass'
      ? tx(
        'Googlebot, Bingbot, and the identifiable Chinese search crawlers (Baiduspider, YisouSpider, Sogou web spider, 360Spider) are allowed. Search indexes still feed AI Overviews and Copilot.',
        'Googlebot、Bingbot，以及可识别的中文搜索爬虫（Baiduspider、YisouSpider、Sogou web spider、360Spider）均被放行。搜索索引仍然是 AI Overviews 与 Copilot 的上游。',
      )
      : tx(
        `Blocked search crawlers: ${names}. Blocking Googlebot or Bingbot removes the site from the indexes that feed AI answers.`,
        `被禁止的搜索爬虫：${names}。禁止 Googlebot 或 Bingbot 会让站点离开喂给 AI 答案的索引。`,
      ),
    fix: status === 'pass'
      ? tx('No change required.', '无需修改。')
      : tx(
        `Allow ${names}. Do not confuse Google-Extended (training opt-out) with Googlebot (search).`,
        `放行 ${names}。不要把 Google-Extended（训练 opt-out）和 Googlebot（搜索）写成同一条规则。`,
      ),
    verify: tx(
      'In robots.txt, Googlebot and Bingbot groups do not contain Disallow: /. Re-run the audit.',
      'robots.txt 里 Googlebot 与 Bingbot 分组没有 Disallow: /。重新审计。',
    ),
    evidence: asEvidence({ bots: rows.filter((r) => r.role === 'search') }),
  }
}
