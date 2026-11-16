/** Relative weights. The published score is normalized to 0–100. */
export const CHECK_WEIGHTS = {
  'robots.reachable': 8,
  'robots.answer-bots': 18,
  'robots.search-bots': 8,
  'llms.txt': 12,
  'llms-full.txt': 4,
  'llms.links': 6,
  sitemap: 10,
  'page.jsonld': 10,
  'page.meta-description': 4,
  'page.canonical': 4,
  'page.lang': 3,
  'page.open-graph': 4,
  'page.ssr-text': 10,
  'page.robots-directives': 12,
  markdown: 5,
  'access.http': 10,
  'access.bot-ua': 12,
} as const

export type CheckId = keyof typeof CHECK_WEIGHTS
