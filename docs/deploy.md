# Deploy GeoCiteOps

GeoCiteOps is a self-hosted app. These are the paths that do not need a custom server build: Docker Compose on a machine you control, a Render Blueprint, a Railway project imported from the Compose file, and a Zeabur template. None of them publish the npm packages or turn on billing.

The fictional public demo is a separate switch, [`DEMO_MODE`](#public-demo). Leave it off for a normal install.

## Required environment variables

Generate each secret with:

```bash
openssl rand -hex 32
```

`CREDENTIAL_MASTER_KEY` must be exactly 64 hex characters. `PAY_MOCK_SECRET` is any long random string. The process exits on startup if either is missing or, for the master key, malformed. Do not commit either value.

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | yes | Postgres URL. Compose sets this for you and points it at the `db` service. |
| `CREDENTIAL_MASTER_KEY` | yes | 64-hex AES-256 key for workspace platform credentials. |
| `PAY_MOCK_SECRET` | yes | Signs mock payment callbacks. Fail-closed: a missing value aborts startup. |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | compose | Defaults `geo` / `geo_secret` / `geo`. Change the password before any shared host. |
| `GEO_COOKIE_NAME` | no | Default `__Host-geo_sid` (requires HTTPS, or localhost). Plain HTTP on a bare IP needs `geo_sid`. |
| `BILLING_ENFORCEMENT` | no | Default `off`. See the note under [public demo](#public-demo). |
| `REGISTRATION_ENABLED` | no | Default `off`. Must be `on` together with billing enforcement to allow self-serve signup. |
| `DEMO_MODE` | no | Default off. `on` seeds Acme Draw and locks the instance down. |
| `DEMO_ACCOUNT_PASSWORD` | demo | Password for `demo-viewer`. If unset, the first seed prints a random one once. |
| `DEMO_PUBLIC_PASSWORD_HINT` | no | Text shown on the sign-in page. Not filled from the password. |
| `GEO_RUN_MIGRATIONS` | platforms | Set to `1` when the API container is the only process (no Compose `migrate` service). |
| `GEO_API_UPSTREAM` | platforms | `host:port` the web container proxies to. Default `app:4000`. |
| `OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, `DOUBAO_API_KEY`, `QWEN_API_KEY`, `ERNIE_API_KEY`, `ERNIE_SECRET_KEY`, `PERPLEXITY_API_KEY`, `GEMINI_API_KEY` | no | Empty means that engine is not called. A demo host should leave them empty. |
| `MCP_TOKEN_RATE_LIMIT` | no | Requests per minute for `GET /mcp/token`, per token hash. Default 120, or 30 when `DEMO_MODE` is on. |

The full commented list is [`.env.example`](../.env.example). Day-2 operations (image publish, npm publish, upgrading an old database) stay in [DEPLOYMENT.md](./DEPLOYMENT.md).

## Docker Compose

Docker with the Compose plugin is enough. No local Node and no local Postgres.

```bash
git clone https://github.com/letheliu/geociteops.git
cd geociteops
cp .env.example .env
# set CREDENTIAL_MASTER_KEY and PAY_MOCK_SECRET
docker compose up -d
```

Four services come up: `db` (Postgres 16 + pgvector), `migrate` (one-shot `prisma migrate deploy`), `app` (API and workers), `web` (nginx). Open `http://localhost:5170/login`.

Create an administrator after the API is healthy:

```bash
docker compose exec app tsx scripts/admin-bootstrap.ts --username admin --password '<your-password>'
```

Load the fictional dataset (this does not turn on read-only mode):

```bash
docker compose exec app tsx scripts/reset-demo.mjs
```

Sign in as `demo-viewer`. The command prints the password once when it creates the user. It is not stored in plaintext.

`docker compose down` keeps the named volumes `pgdata`, `zvec-data`, and `uploads`. `docker compose down -v` deletes them.

The web container proxies `/trpc`, `/files`, `/health`, and `/webhooks` to `app:4000`. That hostname is the Compose service name. `GET /mcp/token` is on the API too. It checks the bearer token the MCP HTTP process presents. It does not echo the token.

WorkBuddy does not talk to that route. It talks to `@geociteops/mcp --http`, which you run behind HTTPS. Give that process `GEOCITEOPS_API_URL` pointing at this API. Issue the caller's token in the console (`read` and/or `run-checks`) and have WorkBuddy send it as `Authorization: Bearer`. See [docs/mcp.md](./mcp.md) and [integrations/workbuddy/README.md](../integrations/workbuddy/README.md). In `DEMO_MODE` the MCP tools that write, call a model, or fetch a site stay off.

## Render

[`render.yaml`](../render.yaml) is a Blueprint. After this file is on the default branch, the button opens Render with the Blueprint filled in:

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/letheliu/geociteops)

What it defines:

- A Render Postgres 16 database. The Prisma schema does not use a `vector` column. Embeddings live in the in-process zvec store, so the managed database does not need pgvector.
- A private Docker service `app` from the root `Dockerfile`. `GEO_RUN_MIGRATIONS=1` runs `prisma migrate deploy` before the server listens. A disk mounted at `/app/data` holds zvec and uploads.
- A public Docker service `web` from `web/Dockerfile`. It listens on Render's `PORT` and proxies to `app:4000`.

On the Blueprint form, paste a 64-hex `CREDENTIAL_MASTER_KEY` and a random `PAY_MOCK_SECRET`. Render will not invent a valid master key. Leave `DEMO_MODE` as `off` unless you want the [public demo](#public-demo).

The first deploy builds both images, which takes a while. `GET /health` on the API returns `{"status":"ok"}`. The console URL is the `web` service.

If the console loads and API calls return 502, Render's private hostname for the API is not `app`. Set `GEO_API_UPSTREAM` on the web service to the host and port Render shows for the private service, including the port (`name:4000`).

The database plan slug in the Blueprint is `basic-256mb`. Change it in the Blueprint before applying if your workspace uses a different plan name. That slug is Render's, not a GeoCiteOps price.

## Railway

Railway does not run Compose as a single container. Import [`docker-compose.yml`](../docker-compose.yml) onto an empty project canvas (Railway turns each service into its own service and maps volumes). Set `CREDENTIAL_MASTER_KEY` and `PAY_MOCK_SECRET` in shared variables before the API starts.

[`deploy/railway/railway.toml`](../deploy/railway/railway.toml) is only for an API service created from the Dockerfile by itself. It does not include Postgres or the console. Prefer the Compose import.

Railway's one-click button needs a template code from their dashboard. This repo cannot mint that code. After you publish the imported project as a template, put this in the README and replace `TEMPLATE_CODE`:

```md
[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new/template/TEMPLATE_CODE)
```

Until then the README badge links at the Railway section of this file. Private DNS inside Railway may not be the Compose name `app`. If the console cannot reach the API, set `GEO_API_UPSTREAM` on the web service.

Give the API service `GEO_RUN_MIGRATIONS=1` if you did not import the `migrate` service.

## Zeabur

[`deploy/zeabur/template.yaml`](../deploy/zeabur/template.yaml) is a Zeabur template resource: Postgres (the `pgvector/pgvector:pg16` image, same as Compose), the API built from GitHub repo id `1423810956` (`letheliu/geociteops`), and the console. Zeabur does not deploy a Compose file directly.

Deploy from a machine where you are logged in to Zeabur:

```bash
npx zeabur template deploy -f deploy/zeabur/template.yaml
```

Check the web service after the first deploy. Its build context has to stay the repository root, and its Dockerfile has to be `web/Dockerfile`. The root `Dockerfile` is the API. If Zeabur ignores the `dockerfileName` field, set that path in the service settings and redeploy. The API service uses the root `Dockerfile`.

`GEO_API_UPSTREAM` is wired to the API service's internal hostname on port 4000. `CREDENTIAL_MASTER_KEY` and `PAY_MOCK_SECRET` are template variables the user fills in. They are not generated as hex for you.

A marketplace button exists only after you publish the template. Zeabur's dashboard gives you the snippet. Replace `YOUR_TEMPLATE_CODE`:

```md
[![Deploy on Zeabur](https://zeabur.com/button.svg)](https://zeabur.com/templates/YOUR_TEMPLATE_CODE)
```

## Public demo

`DEMO_MODE=on` is the switch for a host you are willing to put on the public internet.

What it does:

1. On boot, if the workspace domain (`DEMO_WORKSPACE_DOMAIN`, default `acmedraw.example`) has no citation queries, it runs `tsx scripts/reset-demo.mjs`. That seeds the fictional brand **Acme Draw** (`https://acmedraw.example`) and the competitors **Northwind Ink** (`northwind.example`), **Lumen Sketch** (`lumen.example`), and **Harbor Paint** (`harbor.example`). A later restart does not wipe the database. Run `pnpm demo:reset` yourself when you want a fresh copy.
2. Every tRPC mutation is rejected except `auth.login` and `auth.logout`. Queries still read the seeded workspace. The demo user is an `ORG_VIEWER`, and demo mode also blocks a platform admin or an API key from writing.
3. The citation scheduler, diagnostic workers, agent-readiness worker, and GEO health worker do not start. Stored schedules remain visible and do not fire, so the process does not call model APIs or crawl sites. The LLM client is a stub that throws if something calls it anyway.
4. Payment callbacks return 403.
5. The HTTP limit is 60 requests per minute per IP. Login attempts are 5 per minute per IP. Login limiting is in-process, so it is per container.
6. The sign-in page shows the username (`DEMO_USERNAME`, default `demo-viewer`) and, only if you set it, `DEMO_PUBLIC_PASSWORD_HINT`. The page never receives `DEMO_ACCOUNT_PASSWORD`.
7. MCP tools that write workspace data, call a model, or fetch a site are refused, including when the bearer token includes `run-checks`. Report reads still work.

Set the password in the host's secret store before the first boot:

```bash
DEMO_MODE=on
DEMO_ACCOUNT_PASSWORD='<choose-a-password-of-at-least-10-characters>'
# optional, only if visitors should see a note or the password on the form
DEMO_PUBLIC_PASSWORD_HINT='<same password, or "ask the host">'
```

Leave `BILLING_ENFORCEMENT=off`. With enforcement on, an organization that has no subscription cannot read its workspace, and the demo would look empty. Leave the engine API keys empty.

Accepted on-values are `on`, `true`, `1`, and `yes`. `off` and an unset variable keep the normal install.

The README's public URL is the placeholder `https://YOUR_DEMO_HOST`. Replace that text after you publish a host. This repository does not deploy one.

Compose:

```bash
# in .env
DEMO_MODE=on
DEMO_ACCOUNT_PASSWORD=...
docker compose up -d
```

The first boot seeds. `GET /health` includes `"demoMode": true`. The login card names `demo-viewer`.

## What you still do by hand

- Choose and store `CREDENTIAL_MASTER_KEY`, `PAY_MOCK_SECRET`, and, for a demo, `DEMO_ACCOUNT_PASSWORD`.
- Point DNS at the web service and keep HTTPS so the default `__Host-geo_sid` cookie works.
- Publish the Railway and Zeabur templates if you want their marketplace buttons. The Render button works from `render.yaml` on the default branch.
- Replace `https://YOUR_DEMO_HOST` in `README.md` (and the same line in `README.zh-CN.md` if you want them to match) after the demo is actually up.
- Run `pnpm demo:reset` on a schedule if the public data should be rebuilt every day. A process restart does not do that.
