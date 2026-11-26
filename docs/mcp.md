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

Optional Streamable HTTP, bound to localhost:

```bash
npx @geociteops/mcp --http --port 3333
```

Point the client at `http://127.0.0.1:3333/mcp`. The Host header must match the bind address. `--host 0.0.0.0` turns that check off; do not expose that port.

## Environment

| Variable | Required | Purpose |
| --- | --- | --- |
| `GEOCITEOPS_API_URL` | no | API base URL. Default `http://localhost:4000`. |
| `GEOCITEOPS_API_KEY` | no | Workspace API key (`x-api-key`). The key already selects its workspace. |
| `GEOCITEOPS_WORKSPACE_ID` | no | Sent as `x-workspace-id`. The API ignores it on the API-key channel. |
| `GEOCITEOPS_PREFER_LOCAL` | no | `1` or `true` forces in-process readiness, `llms.txt`, and JSON-LD even when a key is set. |

Create the key in the console when the workspace is created. It is shown once.

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
| `run_citation_check` | Runs one query on the configured engines, or on `platforms` you pass (`deepseek`, `doubao`, `qwen`, `ernie`, `perplexity`, `chatgpt`, `gemini`, `kimi`, `yuanbao`). Adds unknown query text to the library. `kimi` is Moonshot. `yuanbao` is the Hunyuan API, not the Yuanbao app. |
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

## Follow-ups

- Publish `@geociteops/mcp` to npm (manual, same as the SDK).
- Score and rewrite content in-process. That needs an LLM path that does not boot the API.
- Extract a knowledge graph in-process, same constraint.
- Publish the audit / `llms.txt` / JSON-LD engines as their own package if a second consumer appears.
- Put an auth layer on Streamable HTTP before binding it anywhere but localhost.
- List this plugin in a marketplace other than this repository.
