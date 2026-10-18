# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Status: pre-release.** The project is at `0.1.0`. Until `1.0.0`, minor bumps may contain breaking changes; anything relevant is listed under `Unreleased`.

## [Unreleased]

### Added

- **Closed-loop automation (M2 §3.3)** — "monitoring finds a weak point → one-click rewrite suggestion
  → human review + publish (suggestion written back to the page) → next run back-fills → Δ on a loop
  board". The loop anchor lives on `OptimizationTask` (10 columns + `AWAITING_VERIFICATION`/`VERIFIED`
  states): `baselineRunId`/`verifiedRunId` (named relations, `ON DELETE SET NULL`), `publishedAt`,
  the baseline/verification triples (`*SovMean` / `*MentionRate` / `*ValidSamples`) and `verifiedAt`.
  **Existing PUBLISHED tasks are not migrated** — the loop only covers tasks created from now on.
- **Optimization gate** — `isOptimizationsAllowed` (pure) + the org-level overload + `assertOptimizationsAllowed`
  refuse content optimizations only when the internal key `_optimizationsDisabled === true` **and**
  the merged `optimizationsPerMonth === 0`; a positive quota always wins (converted customers holding
  both an old TRIAL and a paid subscription). Enforced at six entry points before any LLM call or
  write (`content.optimize` / `atomize` / `generateFaq`, `diagnostic.actions.convert`,
  `kg.extractFromPage`, `citation.optimizeFromWeakPoint`) plus a fallback inside `taskService.create`;
  refusals write one `optimizations.denied` audit record. `_optimizationsDisabled` is injected by the
  **registration flow**, never by the product catalog, so editing catalog entitlements can't silently
  re-open the gate for new trials.
- **Query → page mapping** — `citation.queries.add` accepts `pageId?` (server writes
  `mappedPageUrl = page.url`) and new `citation.queries.setPageMapping`; both validate workspace
  ownership. Free-form URLs are not accepted: a suggestion could otherwise be written back to a page
  the workspace doesn't own. Stale mappings are rejected with "映射页面不存在，请重新关联".
- **Weak-point detection** — `citation.weakPoints(dateRange)` finds each ACTIVE query's most recent
  valid run (contains the query, COMPLETED/PARTIAL, at least one group with `validSamples>0`, ordered by
  `finishedAt`) and flags it when `brandMentionRate < 0.2` while some competitor exceeds `0.4`.
  Competitor mention rates share the brand denominator (`groupAggregate` → `competitorMentionRates`),
  and the response carries `optimizationsAllowed` computed by the same function as the hard assertion,
  so the UI's disabled state can't drift from the server's decision.
- **Suggestion generation (single entry)** — `rewriter.rewriteForQuery(pageContent, queryText, brand)`
  produces a whole-page draft; `citation.optimizeFromWeakPoint` is the only endpoint that generates it
  (other optimization entry points have no single-query page anchor). Generation failure is captured and
  marks the task `FAILED` with a reason instead of leaving a half-formed `PENDING` task.
- **Publish is one interactive transaction** — `REVIEWED → AWAITING_VERIFICATION` (no `PUBLISHED`
  intermediate state for loop tasks) + `publishedAt` + baseline triple + page write-back
  (`currentContent`/`publishedContent` ← suggestion, `lastPublishedAt`, `status=PUBLISHED`,
  `optimizedContent` cleared) + `result.originalContent`, all or nothing.
- **Verification backfill** — after each run finishes (scheduled and manual), tasks published **before**
  the run started move to `VERIFIED` with `verifiedRunId` + the verification triple. A run that started
  before the publish doesn't count, a query with no valid sample keeps waiting, the earliest
  `publishedAt` wins per query, and failures never interrupt run completion. The triple comes from the
  same aggregation helper as the trend chart, so Δ and the trend can't diverge.
- **Web** — `/console/w/:workspaceId/loop` loop board (query → baseline → action → verification → Δ →
  trend deep-link, with an explicit "Δ is not causal" note), a "薄弱查询" card on the reports page with
  one-click optimize (disabled with an upgrade hint when the gate is closed, and a "go map / re-map"
  hint when the mapping is missing or stale), query-library "关联页面", and `?queryId=` support on the
  SOV page.
- **Self-serve trial channel (M2 §3.0)** — `auth.register` (public, CSRF-guarded) opens a 7-day trial
  tenant in one transaction (User / Organization / Workspace / Order + OrderItem / Subscription) and
  signs the visitor straight in. `Organization.source='TRIAL'` and a `$0` order with `paidAt=null` are
  the zero-instrumentation anchors for the M4 conversion funnel.
- **`REGISTRATION_ENABLED` × `BILLING_ENFORCEMENT`, linked fail-closed** — self-serve registration only
  works when both are `on`, because trial quotas and TTL hang off the entitlement machine. New public
  query `auth.registrationEnabled` drives the login-page entry and the `/register` closed notice.
- **Trial catalog seed** — idempotent `Product`(`code='TRIAL'`)/`ProductPlan` rows with
  `{maxWorkspaces:1, maxQueries:10, allowedPlatforms:[], monitorSampleCountMax:3}`; registration fails
  closed (no rows written) if the plan is missing, deactivated, or not a `SUBSCRIPTION`.
- **`monitorSampleCountMax` capacity key** — hard-checked `EntitlementGuard.checkMonitorSampleCountMax`
  at three points: registration clamp, `org.workspaces.update`, and `citation.runs.create` (manual
  override); the scheduler clamps instead of failing. Missing key means "unlimited".
- **Trial TTL snapshot keys** — `_graceDays` (90) and `_suppressReminder` in the subscription
  entitlements: expiry falls to a 90-day grace and the 15-day expiry reminders are skipped.
  Read-only retention after expiry (GRACE → EXPIRED + workspace `SUSPENDED`); data is never deleted.
- **Registration rate limiting** — shared sliding-window limiter (extracted from the login limiter)
  with a per-IP 3/hour and a global 50/24h window.
- **Web** — `/register` page, login-page entry gated by `auth.registrationEnabled`, trial banner in the
  console (days left / grace / expired), `PaymentMethod.TRIAL` label, and a "上限 N / —" quota row for
  `monitorSampleCountMax`.

### Security / cost

- Content optimization is refused for TRIAL tenants at six entry points (see "Optimization gate"),
  before any LLM call or database write, so a trial cannot burn platform LLM budget through
  optimization actions. Note the boundary: this closes the **six optimization actions**, not every
  platform-funded LLM feature.
- LLM query generation is refused for `TRIAL` organizations ("试用版请手动添加查询"), keeping platform
  LLM spend at zero for trials. Manual query entry stays open (soft `maxQueries` limit: audited and
  metered, never blocked).

M2 §3.1 "monitoring credibility". Monitoring used to mean "one fetch, one row"; it now means
"one **run** = N samples", and every reported number is a read-time aggregate over that run.

### Added

- **`CitationRun`** — one monitoring run: trigger, effective sample count, platform/query snapshot,
  unit counters, terminal status, and a unique `slotKey` (`{workspaceId}:{YYYY-MM-DD Asia/Shanghai}`)
  that guarantees at most one run per slot per day.
- **Per-workspace scheduling** — `DAILY` 02:00 and `WEEKLY` Sunday 03:00, both with
  `tz: 'Asia/Shanghai'`; per-query `scheduled` switch to opt out of timed runs only
  (`status: PAUSED` still excludes a query from every run, manual included).
- **Manual trigger** — `citation.runs.create` returns a `runId` immediately and samples in the
  background; poll `citation.runStatus`.
- **Run-oriented reporting** — `citation.runs.list` (physical runs plus synthesized
  `legacy:<date>` day buckets) and `citation.runs.samples` (per-run sample detail incl. `rawAnswer`).
- **`citation.trend`** — a trend series whose points are runs, with optional `queryId` / `platform`
  filters, a ≤366-day range, and `TrendChart` in the console (SOV share main line, mention/citation
  rate switch, ±`sovStdDev` band, PARTIAL markers, dashed legacy points).
- **Shared `fetchWithTimeout`** (default 30 s, `CITATION_FETCH_TIMEOUT_MS`) and a shared
  `sanitizeMessage` now used by both the monitoring and diagnostic modules.
- **Unit cap** — `MAX_RUN_UNITS = 400`; the effective N is clamped to `max(1, floor(400 / (Q×P)))`
  and the run records `N clamped 10→5: unit cap 400` rather than rejecting silently.

### Changed

- **Breaking — metric renaming.** The old `getSovScore` response field `sovScore` was in fact the
  *mention rate*, not share of voice. The share metric is now `sovMean`, and the mention/citation
  rates are `brandMentionRate` / `brandSourceCitationRate`. `getEffectComparison` returns the same
  aggregated shape for `before` / `after` / `delta`.
- **Breaking — micro → macro.** Rate metrics are averaged per `query × platform` group and then
  across groups (groups count equally regardless of sample count), instead of pooling raw events.
  `rankMedian` is a pooled median; `rankBest` is a true global minimum. Trend numbers therefore
  will not reproduce the previous per-day figures exactly.
- **Breaking — `trackQuery` / `batchTrack` removed.** Both ignored their input and blocked on the
  whole run. Use `citation.runs.create` instead.
- **Sampling no longer pins `temperature`.** `temperature: 0` was removed from every adapter request
  body: it made N identical samples deterministic and defeated the purpose of sampling. Variance now
  comes from platform retrieval and model non-determinism.
- **Failures are isolated to a sample.** A failed or timed-out sample is stored as a `FAILED` row
  (`rawAnswer: ''`, `brandMentioned: false`, `sovScore: null`, sanitized `analysis.error`) instead of
  being silently dropped. Runs end as `COMPLETED` / `PARTIAL` / `FAILED`; only runs with at least
  one OK sample enter the trend.
- **Legacy data is readable, not rewritten.** Events predating `CitationRun` (`runId = null`) are
  synthesized into per-day buckets at read time and suppressed on days that already have a physical
  run. `getReport` stays sample-level but now filters to OK rows.

### Removed

- `src/modules/citation-monitor/metrics.ts` — no business callers; its micro averages are superseded
  by the aggregation layer.

### Security

- `failureReason` on both runs and samples, and the `analysis.error` object, pass through the shared
  sanitizer, so platform error text containing credentials is masked before it reaches the database.
- `citation.runStatus` / `runs.samples` scope lookups by `ctx.workspace.id`; a run id from another
  workspace returns `NOT_FOUND` rather than another workspace's data.

## [0.1.0] - 2026-10-17

First public release. This milestone (M1, "open-source credibility") is about making the project
runnable and credible for a stranger: clone it, run it, understand it.

### Added

- **Containerized one-command deployment** — four-service Docker Compose stack (`db` / `migrate` / `app` / `web`), multi-stage `Dockerfile` on `node:20-slim`, and `web/Dockerfile` building the Vue console into nginx. Three named volumes persist PostgreSQL, the zvec vector store (`zvec-data`), and uploaded files (`uploads`).
- **Demo environment reset** (`pnpm demo:reset`) — idempotently provisions the demo organization, workspace, and a read-only `ORG_VIEWER` account, truncates demo data, re-runs the seed, and upserts deterministic pseudo-embeddings for seeded knowledge-graph entities into zvec. Zero LLM dependency, so the demo dataset can be verified offline.
- **Deterministic vector generator** (`scripts/lib/deterministic-vector.ts`) — SHA-256 derived, L2-normalized unit vectors at `ZVEC_DIM`; determinism, dimension, and unit-norm are covered by 10 tests.
- **CI** — GitHub Actions with a typecheck gate (backend `tsc`, web `vue-tsc`) and a test job backed by a dedicated `pgvector` service and throwaway `zoomer_test` database that is migrated before the suite runs.
- **Image publishing** — `docker.yml` builds and pushes `linux/amd64` images to ghcr.io, tagged to match releases.
- **Community templates** — bug report and feature request forms, a PR template with a test-evidence checklist, and a `CONTRIBUTING.md` covering branches, commit style, and the `prisma generate`-before-`tsc` ordering rule.

### Changed

- **Repository hygiene** — internal AI-workflow skill copies (`.agents/`, `.codex/`, `.opencode/`, `.qwen/`, `.trae/`), internal development records (`.workbuddy/`, `docs/superpowers/`), third-party excerpt material (`docs/claude-seo-reference/`), private specs (`docs/specs/`), and competition-submission drafts are untracked and ignored.
- **Lockfile is now committed** — `pnpm-lock.yaml` was previously ignored; it is version-controlled, and CI plus all Docker stages install with `--frozen-lockfile`.
- **SDK renamed** — `@scope/geo-sdk` → `@geociteops/sdk`, aligning the package name with the repository and ghcr image names.
- **README (EN + zh-CN)** — Docker Compose quick start promoted to the primary path, session-cookie `Secure` behavior documented, CI / Docker / npm badges added.
- **`CREDENTIAL_MASTER_KEY` and `PAY_MOCK_SECRET` are marked mandatory** in `.env.example`, and Compose now fails fast when either is missing instead of letting the app crash-loop.

### Security

- `PAY_MOCK_SECRET` stays fail-closed: the server refuses to start without it. A default secret is public in source, and silently falling back to it would allow forged payment callbacks to mark orders paid.
- Workspace platform credentials remain envelope-encrypted (AES-256-GCM) under `CREDENTIAL_MASTER_KEY`.
- A pre-publication scan of the tracked tree confirms no private keys, no plaintext API keys, and no internal addresses. The single `sk-` pattern match in the repo is a deliberate envelope-leak test fixture.

[Unreleased]: https://github.com/letheliu/geociteops/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/letheliu/geociteops/releases/tag/v0.1.0
