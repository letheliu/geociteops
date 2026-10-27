# Metrics & Methodology

How every number in GeoCiteOps is computed — each metric documents its **definition, formula, evidence, and limitations**. If a number on screen is not covered here, it is a bug in documentation, not an extra feature.

Shared conventions:

- All day buckets use **Asia/Shanghai** natural days (`src/modules/citation-monitor/aggregate.ts`).
- Only `status = OK` monitoring samples enter every metric below. Failed samples are counted in sample counts, never in numerators.
- **Evidence tiering is a first-class principle**: a weaker evidence tier never silently upgrades a stronger claim (see [Citation attribution](#citation-attribution-tiers) and brand matching below).

## Brand mention & Share of Voice (SOV)

**Definition** — whether and how prominently the tracked brand appears in an AI answer, relative to competitors.

**Formula** (`src/modules/citation-monitor/analyzer.ts`):

- `brandMentioned` — the brand name matched in the answer via layered matching: **exact** name hit → **fuzzy** alias hit → **domain** hit. The match type is evidence: an answer that only mentions the brand's domain is still `mentioned`, but the tier is recorded.
- `sovScore = brandMentions / (brandMentions + competitorMentions)` per answer; `0` when nobody is mentioned.
- `rankInAnswer` — 1-based position of the brand among all positioned mentions; a mention without a locatable position ranks last.

**Aggregation** (`aggregate.ts`):

- Group level (query × platform): mean over *valid samples* (`OK` and `sovScore ≠ null`); `validSamples` is exposed next to every mean.
- Query level: **macro equal weight** across its query × platform groups — query importance does not grow with sample count.
- Period level: macro equal weight across days that have `validSamples > 0` (a day is a point, not a sample).

**Limitations** — SOV measures *presence among named brands*, not traffic or authority. Single-answer samples are noisy; medians and day-level points exist precisely so that one lucky answer cannot move a trend.

## Weak points

**Definition** — queries where the brand is systematically absent while a competitor is systematically present.

**Formula** (`src/modules/citation-monitor/weak-points.ts`): a query is weak when, on its baseline run, `brandMentionRate < 0.2` **and** some competitor's query-level mention rate `> 0.4` (constants for now). Baseline = the latest run that includes the query, finished `COMPLETED/PARTIAL`, with at least one valid sample for it.

**Limitations** — thresholds are heuristics tuned for actionability, not statistical tests; a query with no strong competitor never qualifies.

## Citation attribution tiers

**Definition** — how a URL cited by an AI answer is attributed to a page you manage.

**Formula** (`src/modules/citation-monitor/coverage.ts`):

| Tier | Rule |
| --- | --- |
| `EXACT` | cited URL equals the page URL byte for byte |
| `NORMALIZED` | equal after normalization: scheme, host case, leading `www.`, trailing slash (except root), and fragment are ignored; **path and query string are kept** |
| `DOMAIN` | host matches, path does not |

**Evidence** — `EXACT`/`NORMALIZED` count as *cited*; `DOMAIN` is domain-level evidence only: the engine cited your domain, but we cannot prove which page. Domain-level evidence **never** counts toward page coverage (same principle as "a declared User-Agent is not proof of identity").

**Limitations** — URL variants that differ only by query string (e.g. UTM tags) are conservatively treated as unproven-same-page, which can understate coverage for sites that circulate tagged links.

## Citation coverage & blind spots

**Definition** — which of your published pages AI engines actually cite, and which they never do.

**Formula** (`coverage.ts`, spec `docs/specs/引用覆盖-设计.md`):

- Universe = `ContentPage` rows with `status = PUBLISHED` (unpublished pages cannot be cited and are excluded from denominators).
- Window = OK samples with `capturedAt` inside the selected days.
- A page is **covered** iff it has ≥ 1 `EXACT`/`NORMALIZED` attribution in the window. Coverage rate = covered pages / universe.
- **Blind spot** = a published page with zero covered attributions in the window. `domain-only` = a blind spot whose domain *was* cited — the engine knows your domain but not that page.
- Per-platform coverage uses the same denominator; platforms with **no samples in the window are omitted entirely** — absence of evidence is not zero coverage.

## Intent miss (mapped-but-not-cited)

**Definition** — a query you mapped to a target page whose own answers never cite that page.

**Formula** — for each `ACTIVE` query with `mappedPageUrl`, count its OK samples whose cited URLs contain the mapped page at `EXACT`/`NORMALIZED`. Zero ⇒ `miss`. Complementary to weak points: weak points ask "is the brand mentioned", intent miss asks "did the answer land on the page you optimized".

## Loop Δ (closed-loop board)

**Definition** — the difference between baseline and the first valid post-publish run for an optimization task.

**Limitations** — Δ is an observation, **not a causal effect**: the query may have changed, the engine may have re-crawled unrelated content, and single-run noise applies. The board states this on the page; keep it stated wherever Δ is quoted.
