import type { PillarId } from './types.js'

/**
 * Nominal weights for the overall GEO score. They sum to 1.
 *
 * - Agent readiness (0.30): crawlers have to be able to fetch the site before anything else matters.
 * - Citations (0.35): a live mention / citation is the outcome the other pillars are in service of.
 * - Citability (0.20): whether the sampled pages are written so an answer engine can quote them.
 * - Structured signals (0.15): Schema.org and llms.txt. Lighter on purpose, because readiness already scores the same files.
 *
 * A pillar with no score (FAILED or SKIPPED) is dropped. The remaining nominal weights are scaled so they sum to 1.
 */
export const NOMINAL_WEIGHTS: Record<PillarId, number> = {
  agentReadiness: 0.3,
  citations: 0.35,
  citability: 0.2,
  structuredSignals: 0.15,
}

/**
 * Citation pillar, 0–100, only when at least one engine returned an answer:
 *   mentionRate × 45 + citationRate × 35 + rankScore × 20
 * rankScore is 1 at mean rank 1 and loses 0.25 per extra rank, floored at 0.
 * Samples where the brand was not mentioned do not enter the mean rank.
 */
export const CITATION_POINTS = { mention: 45, citation: 35, rank: 20 } as const

/**
 * Page composite inside the citability pillar:
 *   atomScore × 0.6 + passageCitability × 0.4
 * atomScore is the content optimizer's mean atom score (0–100).
 * passageCitability is the mean AI-friendliness score of the page's passages (0–100).
 * E-E-A-T is not guessed from HTML flags here; the optimizer still owns that check on a full rewrite.
 */
export const PAGE_BLEND = { atom: 0.6, citability: 0.4 } as const

/**
 * Structured signals, 0–100, from the embedded readiness checks:
 *   page.jsonld × 50 + llms.txt × 35 + llms-full.txt × 15
 * pass = 1, warn = 0.5, fail or missing = 0.
 * The generated llms.txt and JSON-LD are the fix the user can download. They do not add points.
 */
export const SIGNAL_POINTS = { jsonld: 50, llmsTxt: 35, llmsFull: 15 } as const

export const AUTO_QUERY_MIN = 5
export const AUTO_QUERY_MAX = 8
export const USER_QUERY_MAX = 10
export const PAGE_CAP = 5
export const ACTION_CAP = 10
