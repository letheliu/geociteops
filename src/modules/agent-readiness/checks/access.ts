import { asEvidence, tx, type AgentReadinessCheck, type CheckStatus } from '../types.js'
import { CHECK_WEIGHTS } from '../weights.js'

export interface AccessProbe {
  status: number
  durationMs: number
  error?: string
  finalUrl?: string
  redirectCount?: number
}

const SLOW_MS = 3_000
const REDIRECT_WARN = 3

export function checkHttpAccess(browser: AccessProbe): AgentReadinessCheck {
  const redirects = browser.redirectCount ?? 0
  let status: CheckStatus = 'pass'
  let explanation = tx(
    `Final HTTP ${browser.status} in ${browser.durationMs} ms with ${redirects} redirect(s).`,
    `最终 HTTP ${browser.status}，耗时 ${browser.durationMs} ms，经过 ${redirects} 次重定向。`,
  )
  let fix = tx('No change required.', '无需修改。')

  if (browser.error || browser.status === 0) {
    status = 'fail'
    explanation = tx(
      `The page could not be fetched (${browser.error ?? 'network error'}).`,
      `页面抓取失败（${browser.error ?? '网络错误'}）。`,
    )
    fix = tx(
      'Confirm the URL is public HTTPS, returns 200, and is not blocked for a normal browser user-agent.',
      '确认 URL 是公网 HTTPS、返回 200，并且不会拦截普通浏览器 User-Agent。',
    )
  } else if (browser.status >= 400) {
    status = 'fail'
    explanation = tx(`The page returned HTTP ${browser.status}.`, `页面返回 HTTP ${browser.status}。`)
    fix = tx('Fix the status. A 404 or 5xx page cannot be cited.', '先修好状态码。404 或 5xx 的页面无法被引用。')
  } else if (browser.status >= 300) {
    status = 'warn'
    explanation = tx(
      `The fetch stopped on HTTP ${browser.status} after ${redirects} redirect(s).`,
      `抓取在 ${redirects} 次重定向后停在 HTTP ${browser.status}。`,
    )
    fix = tx('Make the URL resolve to a 200 in five redirects or fewer.', '让该 URL 在不超过 5 次重定向内落到 200。')
  } else if (browser.durationMs >= SLOW_MS || redirects >= REDIRECT_WARN) {
    status = 'warn'
    explanation = tx(
      `HTTP ${browser.status}, but the response took ${browser.durationMs} ms and ${redirects} redirect(s). Slow or long chains get dropped by impatient fetchers.`,
      `HTTP ${browser.status}，但耗时 ${browser.durationMs} ms，并经过 ${redirects} 次重定向。偏慢或过长的跳转容易被抓取方放弃。`,
    )
    fix = tx(
      'Collapse redirects (one hop to the canonical URL) and keep the HTML response under about 3 seconds.',
      '把重定向收成一跳到 canonical URL，并让 HTML 响应落在大约 3 秒以内。',
    )
  }

  return {
    id: 'access.http',
    category: 'access',
    title: tx('Page responds to a browser', '页面对浏览器可访问'),
    status,
    weight: CHECK_WEIGHTS['access.http'],
    applicable: true,
    explanation,
    fix,
    verify: tx(
      'curl -sI -o /dev/null -w "%{http_code} %{time_total} %{num_redirects}\\n" -L <url> shows 200, a short time, and few redirects.',
      'curl -sI -o /dev/null -w "%{http_code} %{time_total} %{num_redirects}\\n" -L <url> 应显示 200、较短时间和很少的重定向。',
    ),
    evidence: asEvidence({
      status: browser.status,
      durationMs: browser.durationMs,
      redirectCount: redirects,
      finalUrl: browser.finalUrl ?? null,
      error: browser.error ?? null,
    }),
  }
}

export interface BotProbe extends AccessProbe {
  token: string
  userAgent: string
}

/**
 * Compare a browser fetch with AI-crawler user-agents.
 * A 401/403/429 on the bot while the browser gets 200 is a WAF block.
 */
export function checkBotUserAgent(browser: AccessProbe, bots: BotProbe[]): AgentReadinessCheck {
  const browserOk = !browser.error && browser.status >= 200 && browser.status < 300
  if (!browserOk) {
    return {
      id: 'access.bot-ua',
      category: 'access',
      title: tx('AI crawler user-agents are not blocked', 'AI 爬虫 User-Agent 未被拦截'),
      status: 'warn',
      weight: CHECK_WEIGHTS['access.bot-ua'],
      applicable: false,
      explanation: tx(
        'Skipped because the browser fetch did not return 200, so a WAF difference cannot be judged.',
        '浏览器抓取没有返回 200，无法判断 WAF 差异，本项不重复计分。',
      ),
      fix: tx('Restore a 200 for browsers, then re-run.', '先让浏览器请求返回 200，再重新审计。'),
      verify: tx('The HTTP check passes, then this check becomes applicable.', 'HTTP 检查通过后，本项才会计入分数。'),
      evidence: asEvidence({ browserStatus: browser.status, bots: bots.map(summarize) }),
    }
  }

  const blocked = bots.filter((b) => !b.error && (b.status === 401 || b.status === 403 || b.status === 429 || b.status === 503))
  const errored = bots.filter((b) => Boolean(b.error) || b.status === 0 || (b.status >= 400 && !blocked.includes(b)))
  const slowed = bots.filter((b) => !b.error && b.status >= 200 && b.status < 300 && browser.durationMs > 0 && b.durationMs > browser.durationMs * 3 && b.durationMs > 2_000)

  let status: CheckStatus = 'pass'
  let explanation = tx(
    `GPTBot and ClaudeBot received the same class of response as the browser (HTTP ${browser.status}).`,
    `GPTBot 与 ClaudeBot 收到了和浏览器同一类的响应（HTTP ${browser.status}）。`,
  )
  let fix = tx('No change required.', '无需修改。')
  if (blocked.length > 0) {
    status = 'fail'
    explanation = tx(
      `${blocked.map((b) => `${b.token} got HTTP ${b.status}`).join('; ')}, while a browser user-agent got HTTP ${browser.status}. A WAF or bot rule is turning AI crawlers away.`,
      `${blocked.map((b) => `${b.token} 得到 HTTP ${b.status}`).join('；')}，而浏览器 User-Agent 得到 HTTP ${browser.status}。WAF 或机器人规则正在把 AI 爬虫挡在外面。`,
    )
    fix = tx(
      'Allow the GPTBot and ClaudeBot user-agents (and the other tokens in the crawler catalog) through the WAF. Keep a separate robots.txt policy if you only want to opt out of training.',
      '在 WAF 上放行 GPTBot 和 ClaudeBot 的 User-Agent（以及爬虫清单里的其它 token）。如果只想拒绝训练，用 robots.txt 单独表达，不要在 WAF 上直接 403。',
    )
  } else if (errored.length > 0) {
    status = 'warn'
    explanation = tx(
      `${errored.map((b) => `${b.token} ${b.error ?? `HTTP ${b.status}`}`).join('; ')}. The browser request succeeded, so the bot path is not equivalent.`,
      `${errored.map((b) => `${b.token} ${b.error ?? `HTTP ${b.status}`}`).join('；')}。浏览器请求是成功的，爬虫路径并不等价。`,
    )
    fix = tx('Compare the two requests in the access logs and allow the crawler user-agents.', '在访问日志里对比这两类请求，并放行爬虫 User-Agent。')
  } else if (slowed.length > 0) {
    status = 'warn'
    explanation = tx(
      `${slowed.map((b) => b.token).join(', ')} succeeded but took more than 3× the browser response. Rate limits that stall crawlers have the same effect as a block.`,
      `${slowed.map((b) => b.token).join('、')} 虽然成功，但耗时超过浏览器的 3 倍。把爬虫拖慢的限速，效果接近直接拦截。`,
    )
    fix = tx('Do not apply a harsher rate limit to known AI crawler user-agents than to browsers.', '不要对已知 AI 爬虫 User-Agent 使用比浏览器更严的限速。')
  }

  return {
    id: 'access.bot-ua',
    category: 'access',
    title: tx('AI crawler user-agents are not blocked', 'AI 爬虫 User-Agent 未被拦截'),
    status,
    weight: CHECK_WEIGHTS['access.bot-ua'],
    applicable: true,
    explanation,
    fix,
    verify: tx(
      'curl -sI -A "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot" <url> returns the same status as a browser curl. Re-run the audit.',
      'curl -sI -A "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot" <url> 的状态码应与浏览器 curl 相同。然后重新审计。',
    ),
    evidence: asEvidence({
      browserStatus: browser.status,
      browserDurationMs: browser.durationMs,
      bots: bots.map(summarize),
    }),
  }
}

function summarize(bot: BotProbe) {
  return {
    token: bot.token,
    status: bot.status,
    durationMs: bot.durationMs,
    error: bot.error ?? null,
  }
}
