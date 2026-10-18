<div align="center">

<img src="./docs/assets/geociteops-logo.svg" alt="GeoCiteOps" width="720" />

# GeoCiteOps

**AI citation intelligence and optimization platform for generative search.**

Track how AI answer engines mention your brand, improve the content they can cite, and publish the structured signals they need to understand you.

English · [简体中文](./README.zh-CN.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![CI](https://github.com/letheliu/geociteops/actions/workflows/ci.yml/badge.svg)](https://github.com/letheliu/geociteops/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-%3E%3D22-green)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.5-blue.svg)](https://www.typescriptlang.org/)
[![SDK](https://img.shields.io/npm/v/@geociteops/sdk)](https://www.npmjs.com/package/@geociteops/sdk)
[![Docker](https://img.shields.io/badge/docker-ghcr.io%2Fletheliu%2Fgeociteops--api-blue)](https://github.com/letheliu/geociteops/pkgs/container/geociteops-api)

</div>

---

GeoCiteOps is an end-to-end **Generative Engine Optimization (GEO)** platform. It helps teams understand whether AI search engines cite their brand, then closes the loop with content optimization, Schema.org output, `llms.txt`, and a brand knowledge graph.

> GEO improves how likely your content is to be cited by AI answer engines, just as SEO improves visibility on search results pages.

## Demo

<!--
  Demo recording slot — asciinema SVG cast (preferred over GIF: does not bloat the repo).

  How to record (with the stack running locally):

    asciinema rec -c "pnpm demo:reset && pnpm dev" demo.cast
    svg-term --in=demo.cast --out=docs/assets/demo.svg --theme=monokai

  Save the artifact to docs/assets/demo.svg, then uncomment the line below:

  <img src="./docs/assets/demo.svg" alt="GeoCiteOps demo: citation monitoring to SOV report" width="800" />

  Live read-only demo: https://geo.gsgroup.club
-->

## Why GeoCiteOps

| Need | What GeoCiteOps provides |
| --- | --- |
| Know where your brand appears | Run the same query across major AI engines and compare mentions, citations, URLs, rank position, and Share of Voice (SOV). |
| Make content easier to cite | Break long-form pages into citable atoms, score them, rewrite weak segments, and generate FAQ-style answers. |
| Publish machine-readable context | Generate Schema.org JSON-LD, `llms.txt`, and knowledge graph exports for AI crawlers and downstream systems. |

## Core Capabilities

| Area | Highlights |
| --- | --- |
| Citation monitoring | DeepSeek, Doubao, Qwen, ERNIE, ChatGPT Search, Perplexity, Gemini, and Anthropic/Claude adapters. |
| Content optimization | Atomization, AI-friendliness scoring, rewriting, FAQ generation, and E-E-A-T checks. |
| Structured signals | Schema.org builders for `SoftwareApplication`, `Organization`, `FAQPage`, and more, plus `llms.txt` generation. |
| Knowledge graph | Entity and relation extraction with JSON / RDF export. |
| Multi-tenant runtime | Workspace isolation, per-workspace platform credentials, API keys, and typed SDK access. |

## Architecture

```text
┌──────────────────────────────────────────────────────┐
│ Web Console (Vue 3 + Naive UI + Vite)                │
│ Dashboard · Query Library · Reports · Content · KG   │
├──────────────────────────────────────────────────────┤
│ API Gateway (Fastify + tRPC)                         │
│ workspace · citation · content · tasks · schema · kg │
├──────────────────────────────────────────────────────┤
│ Core Services                                        │
│ Citation Monitor + Platform Adapters                 │
│ Content Optimizer (atomize → score → rewrite)        │
│ Schema Generator (JSON-LD + llms.txt)                │
│ Knowledge Graph (entity / relation extraction)       │
│ LLM Provider · Vector Store (Zvec) · Queue (pg-boss) │
├──────────────────────────────────────────────────────┤
│ PostgreSQL + pgvector                                │
└──────────────────────────────────────────────────────┘
```

## Quick Start

### Option A — Docker Compose (recommended)

**Prerequisites:** Docker with the Compose plugin. Nothing else — no local Node, no local PostgreSQL.

```bash
git clone https://github.com/letheliu/geociteops.git
cd geociteops

cp .env.example .env
```

Then edit `.env` and set **two mandatory secrets** — the stack will refuse to start without them:

```bash
# Generate a value for each (run twice, use one result per variable):
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

| Variable | Why it is mandatory |
| --- | --- |
| `CREDENTIAL_MASTER_KEY` | 64-hex envelope-encryption key for workspace platform credentials. Missing or malformed → startup aborts. |
| `PAY_MOCK_SECRET` | Mock payment callback signing secret. **Fail-closed** (`src/server.ts:109`): missing → the app process terminates on boot, because a default secret is public in source and silently falling back to it would let anyone forge a PAID callback. |

Then bring the stack up:

```bash
docker compose up -d
```

The stack runs four services — `db` (PostgreSQL + pgvector), `migrate` (one-shot `prisma migrate deploy`), `app` (API + all background workers), and `web` (nginx serving the built console). Open **http://localhost:5170/login**.

> Deploying to your own server (demo site, DNS + HTTPS, daily reset cron, ghcr images, npm publish)?
> See [docs/DEPLOYMENT.md](./docs/DEPLOYMENT.md).

Create your first platform administrator, then sign in:

```bash
docker compose exec app tsx scripts/admin-bootstrap.ts --username admin --password <your-password>
```

The first sign-in forces a password change, after which you land in the `/admin` back office. From there: create an Organization + Workspace, then click "进入" on the workspace to use the console. The workspace API key is displayed **once** at creation — save it for SDK use.

Persistent data lives in three named volumes, so `docker compose down && docker compose up -d` keeps your database, the vector store (`zvec-data`), and uploaded files (`uploads`).

To load the built-in demo dataset (seed data plus deterministic demo vectors in the vector store):

```bash
docker compose exec app tsx scripts/reset-demo.mjs
```

It prints a read-only demo account password once — keep it, it is not stored in plaintext.

### ⚠️ Session cookies and plain HTTP

The session cookie is named `__Host-geo_sid` by default (`src/platform/identity/cookie.ts`). The `__Host-` prefix **forces `Secure`**, which means browsers reject it over plain HTTP — silently, with no error in the UI: you sign in and land straight back on the login page.

| Deployment | What to do |
| --- | --- |
| `http://localhost:5170` | Works as-is. Browsers treat localhost as a secure context. |
| Bare IP over HTTP, e.g. `http://203.0.113.10:5170` | **Set `GEO_COOKIE_NAME=geo_sid`** in `.env` (drop the `__Host-` prefix), or put the deployment behind HTTPS. |
| HTTPS (e.g. `geo.gsgroup.club`) | Keep the default `__Host-geo_sid` — it is strictly more protective. |

### Option B — Local development with pnpm

**Prerequisites:** Node.js 20+, pnpm 11+, and a PostgreSQL with pgvector reachable by you.

```bash
git clone https://github.com/letheliu/geociteops.git
cd geociteops

pnpm install                       # lockfile is committed — CI and Docker use --frozen-lockfile
cp .env.example .env               # point DATABASE_URL at your own Postgres, set the two secrets above

# Generate the Prisma client. This MUST run before any tsc step:
# the client types (Prisma.InputJsonValue & friends) are produced by `prisma generate`,
# and without them tsc reports 200+ phantom errors.
pnpm db:generate

# Fresh database only — see the upgrade warning below, never db:push an existing one
pnpm db:push

pnpm dev                           # API on http://localhost:4000
pnpm dev:web                       # console on http://localhost:5170 (optional, second terminal)
```

### Platform account and sign-in

The web console no longer offers self-service sign-up: create the first super administrator after deployment, then sign in at `/login`.

```bash
# Create a SUPER_ADMIN (interactive password prompt; or non-interactive: --username admin --password <pw>)
pnpm admin:bootstrap --username admin --password <your-password>
```

Then:

1. Open the web console at `http://localhost:5170/login` and sign in with that account.
2. The first sign-in forces a password change; once completed you land in the `/admin` platform back office.
3. Create an organization + workspace under "Workspace 管理"; the workspace API key is shown **once** on creation — save it for SDK use.
4. Click "进入" on a workspace to use the full console. The "员工账号" page manages platform roles (OPERATOR etc.); all actions are recorded in "审计日志".

### ToB P0 changes at a glance

- **Console access now requires a platform account** (session cookie); public registration/setup routes were removed, and the legacy `localStorage['geo-api-key']` injection is deprecated.
- **The SDK / server-to-server channel is unchanged**: still send the workspace API key via the `x-api-key` header (keys are issued once at workspace creation in `/admin`).
- **`CREDENTIAL_MASTER_KEY` is required** (64-hex): workspace platform credentials are stored with envelope encryption (AES-256-GCM); without it, credential writes and workspace creation fail.
- Demo data seeding: `pnpm tsx scripts/seed-demo.mjs` (requires `CREDENTIAL_MASTER_KEY` in `.env`).

### Upgrading an existing deployment (P0)

> ⚠️ **Never run `pnpm db:push` (or `prisma migrate deploy` from scratch) against an existing database.** The P0 schema drops the `Workspace.apiKeyHash` column; applying it before the carry-over script runs deletes every legacy SDK key **permanently** (the drop is irreversible). Follow the ordered steps below.

Databases created before the ToB P0 migrations must be upgraded in exactly this order:

```bash
# Step 1 — Apply migration A only (identity tables; apiKeyHash still present,
#          organizationId added as nullable). Do NOT let migration B run yet.
npx prisma db execute --file prisma/migrations/20261013124327_tob_p0_identity_tables/migration.sql --schema prisma/schema.prisma
npx prisma migrate resolve --applied 20261013124327_tob_p0_identity_tables

# Step 2 — Carry over data (idempotent, safe to re-run):
#          organization backfill, apiKeyHash → ApiCredential (key hashes unchanged,
#          so existing SDK integrations keep working), platformConfig envelope encryption.
#          Requires CREDENTIAL_MASTER_KEY (64-hex) in .env.
pnpm tsx scripts/migrate-tob-p0.ts

# Step 3 — Apply migration B (tightens Workspace: drops apiKeyHash, organizationId NOT NULL)
npx prisma db execute --file prisma/migrations/20261013133000_tob_p0_tighten_workspace/migration.sql --schema prisma/schema.prisma
npx prisma migrate resolve --applied 20261013133000_tob_p0_tighten_workspace
```

Notes:

- Step 2 is the only moment legacy API keys are carried over; a second run should report `0/0/0` for all three steps (idempotency check).
- `prisma db execute` + `migrate resolve` is used deliberately instead of a single `prisma migrate deploy`, because deploy applies migrations A and B back-to-back and would drop `apiKeyHash` before the carry-over happens. If your environment supports it, you may use `prisma migrate deploy` for step 3 only (after step 2) to apply and record the remaining migration.
- Both migrations end up recorded in `_prisma_migrations`, so future `prisma migrate deploy` runs work normally afterwards.

## ToB P1: organizations and the customer console

P1 turns organizations into real tenants: customer accounts sign in to their own `/console`, and workspace access is decided per membership instead of per platform role.

### P1 changes at a glance

- **Authorization is now split by actor type** (enforced server-side on every request via `x-workspace-id` resolution):
  - Platform staff: `SUPER_ADMIN` reaches every workspace; `OPERATOR` only workspaces assigned to them (assignment lives in the same `WorkspaceMember` table with `access='OPERATE'`); `FINANCE`/`SUPPORT` have no GEO workspace access.
  - Customers: `ORG_OWNER` sees every workspace of their organization; `ORG_MEMBER`/`ORG_VIEWER` only workspaces granted via `WorkspaceMember`, with the effective access being `min(org-role cap, member access)` — an `ORG_VIEWER` is always read-only even when granted `OPERATE`, and a member downgraded to `VIEW` (or removed) is cut off on the very next request of an in-flight session (authorization is resolved live, never cached in the session).
- **New `org.*` API namespace** (customer console backend): org info, member management, per-org workspace management, and API credential issue/revoke — write endpoints require `ORG_OWNER`; cross-organization attempts are rejected before any service is touched.
- **Operator assignment UI** lives in the platform back office: `/admin/workspaces/:id` (WorkspaceDetail) → assign/unassign operators (`isPrimary` marks the responsible consultant).

### Customer sign-in and console pages

1. The platform creates the organization + `ORG_OWNER` account (`pnpm admin:bootstrap` is for platform SUPER_ADMIN only; org owners are provisioned platform-side, e.g. via `createOrgUser`/migration tooling).
2. The owner signs in at `/login` — customer accounts land on `/console` (platform staff still land on `/admin`).
3. `/console` home lists only the workspaces the account is authorized for; switching is one click. Settings offer three pages:
   - **Organization info** — read for everyone; editable by the owner.
   - **Members** — owner creates `ORG_MEMBER`/`ORG_VIEWER` accounts (username auto-generated as `member_<org-prefix>` when not supplied; the initial password is shown once and forces a password change), grants per-workspace access (VIEW/OPERATE), disables accounts, resets passwords.
   - **Credentials (SDK keys)** — owner issues and revokes workspace API keys; the plaintext key is shown exactly once. SDK usage itself is unchanged (`x-api-key` header).

### Consultant assignment (platform side)

`/admin/workspaces/:id` shows and manages the operators assigned to a workspace. Until an `OPERATOR` is assigned, they see no workspaces in `me()` and every `x-workspace-id` request is rejected with `UNAUTHORIZED` — assignment takes effect immediately (same session).

## ToB P2: commerce (catalog, orders, payments, metered entitlements)

P2 completes the commercial loop: service catalog → customer order (amounts and plan snapshot frozen at creation) → payment confirmation (bank-transfer voucher / contract credit / online callback) → asynchronous activation → subscription and quotas in effect → expiry grace and suspension → renewal recovery → refund clawback and manual invoicing.

### Order-to-cash flow

**Customer side (`/console`) — four entries:**

| Page | Purpose |
| --- | --- |
| Marketplace (`/console/services`) | Browse the catalog and place orders (subscription / add-on / professional service); pay via bank transfer, contract credit (opened by the platform), or online payment (WeChat/Alipay QR; mock channels in P2) |
| My orders (`/console/orders`) | Order list and detail: status timeline, voucher upload for bank transfers, refund requests, payee account info |
| My services (`/console/billing`) | Subscription cards (status, period) and quota progress (limits + current-month usage) |
| Invoices (`/console/invoices`) | Request invoices per order; view/download invoice files |

**Platform side (`/admin`) — six entries:**

| Page | Purpose |
| --- | --- |
| Catalog (`/admin/catalog`) | Maintain products and plans (price / billing period / entitlement declarations / delivery milestone templates) |
| Orders (`/admin/orders`) | Full order view, order-on-behalf (price changes require a reason), contract-credit opening (fulfill first, collect later) |
| Order detail (`/admin/orders/:id`) | Status timeline, amounts, voucher and payment transactions |
| Payments (`/admin/payments`) | Bank-transfer voucher queue + contract-credit receivables queue; confirm / reject (FINANCE permission) |
| Refunds (`/admin/refunds`) | Pending approval queue (suggested amount via proration); approve-and-execute (online via channel refund) or reject |
| Invoices (`/admin/invoices`) | Process invoice requests and upload invoice PDFs |

Typical flow: the customer orders in the marketplace → pays by bank transfer (reference = order no.) and uploads the voucher → finance confirms in the payments workbench → the system activates automatically (subscription / delivery record / add-on + entitlement recompute; the first workspace is created if the organization has none) → quotas show up under "My services". Contract-credit orders are opened by an operator in order management (fulfill first, collect later; `dueAt` recorded), with finance confirming later in the receivables queue. Online payments are driven by channel callbacks (idempotent per transaction number), with a 04:30 reconciliation cron as the safety net.

### `BILLING_ENFORCEMENT` rollout order

Once `BILLING_ENFORCEMENT=on`, service-state checks and quota enforcement (§3.3 matrix) apply in full: organizations without an active subscription lose business read/write; expired subscriptions enter a grace period (default 7 days, configurable via `SUBSCRIPTION_GRACE_DAYS`) that is read-only; after grace, all workspaces of the organization are suspended, and renewal restores them automatically. **Gift subscriptions must be granted to existing organizations before flipping the switch** — otherwise existing customers are cut off immediately by "no active service":

```bash
# 1. Commerce table migrations (see "Commerce table migrations" below)
# 2. Grant a 90-day gift subscription to every organization without an active one
#    (idempotent, safe to re-run): the second run should report granted=0 and
#    skipped=<total organizations>
pnpm gift:grant
pnpm gift:grant
# 3. After verifying the results, set BILLING_ENFORCEMENT=on in .env and restart
```

### Payment channel configuration (mock in P2)

| Variable | Required | Purpose |
| --- | --- | --- |
| `PAY_MOCK_SECRET` | yes | Secret for mock WeChat/Alipay callback signature verification (sha256(rawBody+secret)). Fail-closed: the server refuses to start without it — the default secret is public in source, and silently falling back to it would allow forged callbacks to mark orders PAID without payment |
| `PAYMENT_BANK_INFO` | no | Payee account for bank transfers (JSON: `accountName`/`accountNo`/`bankName`). Shown on the customer's order detail when set; otherwise the UI shows "contact your consultant for payment info" |

Real WeChat Pay v3 / Alipay Open Platform SDKs remain a follow-up item (the interface is already isolated: `PaymentChannel`'s createPayment / verifyCallback / queryOrder / refund); implementations will be switched via env with the interface shape unchanged.

### Commerce table migrations (existing deployments)

Follow the same discipline as "Upgrading an existing deployment (P0)" above: **never run `pnpm db:push` against an existing database**. Once the two P0 migrations are recorded, the P2 commerce tables (Product / ProductPlan / Order / OrderItem / OrderEvent / PaymentTransaction / RefundTransaction / Subscription / OrganizationEntitlement / UsageRecord / ServiceDelivery / Invoice) apply through regular incremental migrations:

```bash
npx prisma migrate deploy
```

### Daily billing jobs (cron)

| Job | Time | Purpose |
| --- | --- | --- |
| `order.reconcile` | 04:05 | Reconciliation alert: orders stuck in PAID for >1h (detection net for lost activation jobs) |
| `order.expire` | 04:10 | Auto-cancel orders unpaid for 7 days |
| `subscription.expire-check` | 04:15 | Expiry check: reminder audit for subscriptions ending within 15 days → ACTIVE→GRACE on end → GRACE→EXPIRED with workspace suspension after grace (organization-level aggregation) → orphan restore for "subscription expired" suspensions |
| `payment.reconcile` | 04:30 | Online payment reconciliation: scan WeChat/Alipay PENDING transactions, query the channel, and idempotently back-fill SUCCESS ones by transaction number |

## Configuration

All runtime settings live in `.env`; use [.env.example](./.env.example) as the template.

| Group | Variables |
| --- | --- |
| Database | `DATABASE_URL` |
| Service | `PORT` |
| Internal LLM | `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `EMBEDDING_MODEL`, `CHAT_MODEL` |
| Vector store | `ZVEC_DATA_PATH`, `ZVEC_DIM`, `VECTOR_SIMILARITY_THRESHOLD` |
| Monitored platforms | `DEEPSEEK_*`, `DOUBAO_*`, `QWEN_*`, `ERNIE_*`, `PERPLEXITY_*`, `GEMINI_*`, `OPENAI_SEARCH_MODEL` |
| Matching | `FUZZY_MATCH_THRESHOLD` |
| Platform security | `CREDENTIAL_MASTER_KEY` (required), `CORS_ORIGINS`, `GEO_COOKIE_NAME`, `SESSION_IDLE_PLATFORM_HOURS`, `BILLING_ENFORCEMENT` |
| Commerce & billing (P2) | `PAY_MOCK_SECRET` (required), `PAYMENT_BANK_INFO`, `SUBSCRIPTION_GRACE_DAYS` |

Per-workspace platform credentials are stored in `workspace.platformConfig` with envelope encryption (master key: `CREDENTIAL_MASTER_KEY`) and read by adapters at runtime.

## SDK

```ts
import { createGeoClient } from '@geociteops/sdk'

const geo = createGeoClient({
  serviceUrl: 'http://localhost:4000',
  apiKey: '<your-workspace-api-key>',
})

// Track a query across all configured platforms
const report = await geo.citation.runMonitor.mutate({ queryId: '...' })

// Optimize a content page
const task = await geo.content.optimize.mutate({ pageId: '...' })
```

## Project Structure

```text
src/
├── core/                 # DB, LLM, tRPC, vector store, queue, workspace/auth
├── modules/
│   ├── citation-monitor/ # platform adapters, analyzer, SOV metrics, query library
│   ├── content-optimizer/# atomizer, scoring, rewriter, FAQ, E-E-A-T, orchestrator
│   ├── schema-generator/ # JSON-LD builder, llms.txt builder, validator, registry
│   └── knowledge-graph/  # extractor, repository, exporter
├── workers/              # citation scheduler (pg-boss)
└── router.ts             # root tRPC router
sdk/                      # typed tRPC client (@geociteops/sdk)
web/                      # Vue 3 admin console (geo-web)
prisma/                   # schema.prisma
```

## Testing

```bash
pnpm test
pnpm test:watch
```

## Roadmap

- [x] Citation monitoring across 8 AI engines
- [x] Content atomization, scoring, and rewriting
- [x] JSON-LD and `llms.txt` generation
- [x] Knowledge graph extraction and export
- [x] Containerized one-command deployment (Docker Compose, four services)
- [ ] Closed-loop automation: monitoring → optimization suggestion → publish
- [ ] More platforms and richer SOV analytics

## Contributing

Issues and pull requests are welcome. Please open an issue first to discuss large changes — see [CONTRIBUTING.md](./CONTRIBUTING.md) for branch naming, commit style, and the test requirements for new code. By contributing, you agree that your contributions are licensed under the MIT License.

## License

[MIT](./LICENSE) © 2026 letheliu
