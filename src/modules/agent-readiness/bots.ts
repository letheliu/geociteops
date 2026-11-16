/**
 * Crawler catalog for the Agent Readiness audit.
 *
 * Add a row to extend the audit. Robots checks, the per-bot table, and the
 * console all read this list — there is no second copy.
 *
 * `role` is what the score cares about:
 * - answer: fetches pages to ground an answer (blocking these hurts GEO)
 * - search: traditional indexers that also feed AI overviews
 * - training: opting out is recorded and does not fail the audit
 */
export type CrawlerRole = 'answer' | 'search' | 'training'

export interface AiCrawler {
  id: string
  /** Product token as it appears in robots.txt User-agent lines. */
  token: string
  vendor: string
  role: CrawlerRole
  /** Short note for people extending the list. Not shown as a check by itself. */
  note: string
}

export const AI_CRAWLERS: readonly AiCrawler[] = [
  { id: 'gptbot', token: 'GPTBot', vendor: 'OpenAI', role: 'training', note: 'OpenAI training crawler. Search uses OAI-SearchBot.' },
  { id: 'oai-searchbot', token: 'OAI-SearchBot', vendor: 'OpenAI', role: 'answer', note: 'ChatGPT Search indexing crawler.' },
  { id: 'chatgpt-user', token: 'ChatGPT-User', vendor: 'OpenAI', role: 'answer', note: 'User-triggered fetch from ChatGPT.' },
  { id: 'claudebot', token: 'ClaudeBot', vendor: 'Anthropic', role: 'training', note: 'Anthropic training crawler.' },
  { id: 'claude-user', token: 'Claude-User', vendor: 'Anthropic', role: 'answer', note: 'User-triggered fetch from Claude.' },
  { id: 'claude-searchbot', token: 'Claude-SearchBot', vendor: 'Anthropic', role: 'answer', note: 'Claude search indexing crawler.' },
  { id: 'perplexitybot', token: 'PerplexityBot', vendor: 'Perplexity', role: 'answer', note: 'Perplexity indexing crawler.' },
  { id: 'perplexity-user', token: 'Perplexity-User', vendor: 'Perplexity', role: 'answer', note: 'User-triggered fetch from Perplexity.' },
  { id: 'google-extended', token: 'Google-Extended', vendor: 'Google', role: 'training', note: 'Gemini training opt-out. Does not control Google Search.' },
  { id: 'googlebot', token: 'Googlebot', vendor: 'Google', role: 'search', note: 'Google Search, which feeds AI Overviews.' },
  { id: 'bingbot', token: 'Bingbot', vendor: 'Microsoft', role: 'search', note: 'Bing, which feeds Copilot citations.' },
  { id: 'applebot-extended', token: 'Applebot-Extended', vendor: 'Apple', role: 'training', note: 'Apple Intelligence training opt-out.' },
  { id: 'ccbot', token: 'CCBot', vendor: 'Common Crawl', role: 'training', note: 'Common Crawl training corpus.' },
  { id: 'bytespider', token: 'Bytespider', vendor: 'ByteDance', role: 'training', note: 'ByteDance training crawler.' },
  { id: 'amazonbot', token: 'Amazonbot', vendor: 'Amazon', role: 'answer', note: 'Amazon/Alexa answer indexing.' },
  { id: 'meta-externalagent', token: 'Meta-ExternalAgent', vendor: 'Meta', role: 'training', note: 'Meta external training crawler.' },
  { id: 'baiduspider', token: 'Baiduspider', vendor: 'Baidu', role: 'search', note: 'Baidu web crawler (百度).' },
  { id: 'yisouspider', token: 'YisouSpider', vendor: 'Shenma', role: 'search', note: 'Shenma / 神马 (UC). Not the same crawler as Sogou.' },
  { id: 'sogou', token: 'Sogou web spider', vendor: 'Sogou', role: 'search', note: 'Sogou web spider (搜狗).' },
  { id: '360spider', token: '360Spider', vendor: 'Qihoo 360', role: 'search', note: '360 search crawler (360 搜索).' },
] as const

export const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'

/** User-agents used for the WAF differential. Not the full catalog — that would be a crawl. */
export const PROBE_BOTS = [
  { id: 'gptbot', token: 'GPTBot', userAgent: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot' },
  { id: 'claudebot', token: 'ClaudeBot', userAgent: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ClaudeBot/1.0; +claudebot@anthropic.com' },
] as const
