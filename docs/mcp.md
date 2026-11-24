# Use GeoCiteOps in Claude Code, Cursor, and other MCP clients

`@geociteops/mcp` is a [Model Context Protocol](https://modelcontextprotocol.io) server. An editor that speaks MCP can run the same GEO workflows as the console: health checks, agent readiness, citation checks, content optimization, JSON-LD, `llms.txt`, and knowledge-graph extraction.

The server talks to your GeoCiteOps API through [`@geociteops/sdk`](../sdk/README.md). Three tools also run in-process, with no API and no database, so you can try them before the stack is up.

## Install

Node.js 22 or newer.

### Claude Code

Register the server:

```bash
claude mcp add --transport stdio geociteops \
  --env GEOCITEOPS_API_URL=http://localhost:4000 \
  --env GEOCITEOPS_API_KEY=<workspace-api-key> \
  -- npx -y @geociteops/mcp
```

Leave `GEOCITEOPS_API_KEY` unset to use the local tools only.

Install the skill pack from this repository. Claude Code names the skills `/geociteops:geo-audit`, `/geociteops:geo-health`, `/geociteops:geo-optimize`, `/geociteops:geo-llms-txt`, and `/geociteops:geo-schema`. Saying `/geo audit <url>` in the prompt is enough: the skill descriptions match that phrasing.

```bash
claude plugin marketplace add letheliu/geociteops
claude plugin install geociteops@geociteops
```

From a checkout of this repo, the same marketplace is the local directory:

```bash
claude plugin marketplace add .
claude plugin install geociteops@geociteops
```

The plugin asks for the API URL, the workspace API key, and an optional workspace id, then starts `npx -y @geociteops/mcp`. The manifest is `integrations/claude-code/.claude-plugin/plugin.json`.

### Cursor

Copy [integrations/cursor/mcp.json](../integrations/cursor/mcp.json) into the project `.cursor/mcp.json`, or merge the `mcpServers` entry into the one you already have. Put the workspace API key in the `env` block. An empty key selects local mode.

### Claude Desktop

Merge [integrations/claude-desktop/claude_desktop_config.json](../integrations/claude-desktop/claude_desktop_config.json) into `claude_desktop_config.json`:

| OS | File |
| --- | --- |
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| Linux | `~/.config/Claude/claude_desktop_config.json` |

Restart Claude Desktop after saving.

### Any other MCP client

Use the stdio command `npx -y @geociteops/mcp`. A generic `mcpServers` snippet is in [integrations/mcp/client.example.json](../integrations/mcp/client.example.json).

Streamable HTTP requires `Authorization: Bearer <workspace token>` on every request. stdio does not. The token is a workspace API credential created in the console. It is stored as a SHA-256 hash, shown once, and carries `read` and/or `run-checks` (`run-checks` includes read). `*` remains the full-access scope used by the key created with a new workspace.

```bash
npx @geociteops/mcp --http --port 3333 --host 127.0.0.1
```

Point a local client at `http://127.0.0.1:3333/mcp` and send the bearer token. The Host header must match the bind address. For WorkBuddy, put TLS in front of this process and set the connector URL to `https://<your-host>/mcp`. `--host 0.0.0.0` turns the Host check off; only do that behind the proxy.

The MCP process checks the token by calling `GET {GEOCITEOPS_API_URL}/mcp/token`. That route never returns the token. A missing, unknown, or revoked token is `401` with `{"error":"invalid_token"}`. More than the per-token limit is `429`. The default is 60 requests per minute per token (30 when `DEMO_MODE` is on), overridable with `GEOCITEOPS_MCP_RATE_LIMIT` on the MCP process and `MCP_TOKEN_RATE_LIMIT` on the API (default 120, or 30 in demo mode).

`read` can list queries, fetch reports, read share of voice, and generate `llms.txt` or JSON-LD without storing them. `run-checks` can start health checks, citation checks, rewrites, and knowledge-graph extraction. Those write to the workspace. Health checks, citation checks, rewrites, and extraction call a paid model. `optimize_content` and `extract_knowledge_graph` are marked destructive because they can replace stored page content.

`DEMO_MODE=on` keeps both the API and this server read-only. A `run-checks` token still cannot start those tools.

stdio keeps using `GEOCITEOPS_API_KEY` from the environment. It does not require a bearer header. In demo mode the same read-only rule applies.

## Environment

| Variable | Required | Purpose |
| --- | --- | --- |
| `GEOCITEOPS_API_URL` | no | API base URL. Default `http://localhost:4000`. |
| `GEOCITEOPS_API_KEY` | stdio only | Workspace API key (`x-api-key`). HTTP ignores this and uses the caller's bearer token. |
| `GEOCITEOPS_WORKSPACE_ID` | no | Sent as `x-workspace-id`. The API ignores it on the API-key channel. |
| `GEOCITEOPS_PREFER_LOCAL` | no | `1` or `true` forces in-process readiness, `llms.txt`, and JSON-LD even when a key is set. |
| `GEOCITEOPS_MCP_RATE_LIMIT` | no | HTTP requests allowed per token per minute. Default 60, or 30 in `DEMO_MODE`. |
| `DEMO_MODE` | no | `on` makes this process refuse tools that write, call a model, or fetch a site. |

Create tokens under API credentials in the console. Pick `read`, `run-checks`, or both. The full token is shown once. The key created with a new workspace is still scope `*`.

## What runs without a server

| Tool | Local behavior |
| --- | --- |
| `run_agent_readiness_audit` | Fetches the public URL and scores it with the same audit the API worker runs. |
| `generate_llms_txt` | Builds `llms.txt` from a brand, tagline, and sections, or validates markdown / a live `/llms.txt`. |
| `generate_schema` | Builds and validates Schema.org JSON-LD. |

These import the existing modules at build time. They are not copied. A separate shared package is only worth publishing if a second runtime needs the same engines.

Stored reports, citation runs, rewrites, and knowledge-graph extraction need the API. The queue and the workspace LLM do that work. A local citability score and a local extractor are follow-ups.

With an API key, readiness audits and generated `llms.txt` / JSON-LD are stored on the workspace. `GEOCITEOPS_PREFER_LOCAL=1` skips that.

## Tools

Each tool returns a short text summary and a JSON object. Clients that support `structuredContent` also get the object.

| Tool | What it does |
| --- | --- |
| `run_geo_health_check` | Starts a health check and polls. Returns the score, pillar scores, and top actions. |
| `get_geo_health_report` | Fetches a check by id. `format` `markdown` or `json` exports the stored report. |
| `run_agent_readiness_audit` | Audits one public URL. |
| `get_agent_readiness_report` | Fetches a stored audit by id. Local audits are not stored. |
| `list_queries` | Lists active queries in the library. |
| `add_queries` | Adds up to 20 queries. Each item is a string or `{ queryText, source, pageId }`. |
| `run_citation_check` | Runs one query on the configured engines, or on `platforms` you pass. Adds unknown query text to the library. |
| `get_share_of_voice` | Share of voice for a date range. Defaults to the last 30 days. |
| `optimize_content` | Atomize, score, and rewrite `text`, a public `url`, or a stored `pageId`. |
| `generate_schema` | JSON-LD for a registry type. Pass `pageUrl` to store the six types the API accepts. |
| `generate_llms_txt` | Generate from structured fields, or validate `text` / `url`. |
| `extract_knowledge_graph` | Extract entities and relations from `pageId`, `text`, or a public `url`. |

### Long-running jobs

`run_geo_health_check`, `run_agent_readiness_audit` (remote), and `run_citation_check` poll for `waitMs` milliseconds (default 45000, maximum 180000). `waitMs: 0` returns as soon as the job is queued.

If the job is still running, the result includes the id and a `followUp` field. Call `get_geo_health_report` or `get_agent_readiness_report` with that id. Citation runs return `runId`; call `run_citation_check` again only to start a new run. While a client sends a progress token, the server emits `notifications/progress`.

Raw model answers are not included in citation results.

## Prompts and resources

Prompts:

- `geo-audit` with `url` — audit that URL and summarize the fixes.
- `improve-citations` with `brand` — share of voice, the query library, and the next fixes. The prompt tells the model not to invent rates.

Resources, when an API key is set:

- `geociteops://reports/geo-health/latest`
- `geociteops://reports/agent-readiness/latest`

Without a key, each resource explains that stored reports live on the server.

## Develop

From the repository:

```bash
pnpm install
pnpm --filter ./mcp build          # writes mcp/dist/cli.js
node mcp/dist/cli.js --help
pnpm exec vitest run mcp sdk/src/client.test.ts
```

`npx @geociteops/mcp` runs `dist/cli.js`. The package is not published from CI. Dry-run is in the typecheck job. Publish steps are in [DEPLOYMENT.md](./DEPLOYMENT.md).

The files for a later MCP Registry and Smithery listing are in [integrations/mcp-registry/](../integrations/mcp-registry/CHECKLIST.md). They are not submitted from this repo.

## WorkBuddy

The listing packet is in [integrations/workbuddy/](../integrations/workbuddy/README.md). It uses WorkBuddy's user-supplied token mode (`auth_mode: "token"`), not OAuth. Nothing in that directory is submitted from this repo.

## Follow-ups

- Publish `@geociteops/mcp` to npm (manual, same as the SDK).
- Score and rewrite content in-process. That needs an LLM path that does not boot the API.
- Extract a knowledge graph in-process, same constraint.
- Publish the audit / `llms.txt` / JSON-LD engines as their own package if a second consumer appears.
- List this plugin in a marketplace other than this repository.
- OAuth 2.1 for WorkBuddy's `auth_mode: "server-side"` / `auth_type: "mcp_oauth"`. The current session-and-API-key stack has no authorization server, so this was not added. A later change needs, on HTTPS:
  - `GET /.well-known/oauth-protected-resource` (RFC 9728), and `401` responses with `WWW-Authenticate` pointing at `resource_metadata`
  - `GET /.well-known/oauth-authorization-server`
  - `POST /oauth/register` (RFC 7591), allowing `client_name` `WorkBuddy Connector` and `CodeBuddy`, and redirect hosts `*.workbuddy.cn`, `*.codebuddy.cn`, `*.workbuddy.ai`, `copilot.tencent.com`, `staging-codebuddy.tencent.com`
  - `GET /oauth/authorize` with PKCE S256
  - `POST /oauth/token` issuing an access token and a refresh token
  - scopes `read` and `run-checks`, and a refresh lifetime of at least 30 days
  - a second connector `source`, because one WorkBuddy connector has one `auth_mode`
