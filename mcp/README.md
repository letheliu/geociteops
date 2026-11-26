# @geociteops/mcp

MCP server for [GeoCiteOps](https://github.com/letheliu/geociteops). Claude Code, Cursor, Claude Desktop, and any other MCP client can run GEO health checks, agent readiness audits, citation checks, content optimization, JSON-LD, `llms.txt`, and knowledge-graph extraction.

The remote tools call your GeoCiteOps API through `@geociteops/sdk`. Agent readiness, `llms.txt`, and JSON-LD also run in-process when `GEOCITEOPS_API_KEY` is unset.

HTTP mode is different: every request needs `Authorization: Bearer` with a workspace token. Create that token in the console (`read` or `run-checks`). stdio still reads `GEOCITEOPS_API_KEY` from the environment. See [docs/mcp.md](../docs/mcp.md).

Requires Node.js 22+.

## Install

```bash
claude mcp add --transport stdio geociteops \
  --env GEOCITEOPS_API_URL=http://localhost:4000 \
  --env GEOCITEOPS_API_KEY=<workspace-api-key> \
  -- npx -y @geociteops/mcp
```

Cursor, Claude Desktop, and a generic client snippet are in the repository under `integrations/`. The full guide is [docs/mcp.md](https://github.com/letheliu/geociteops/blob/main/docs/mcp.md).

Claude Code skills (`/geociteops:geo-audit`, and the health, optimize, llms.txt, and schema skills) install from this repo:

```bash
claude plugin marketplace add letheliu/geociteops
claude plugin install geociteops@geociteops
```

## Environment

| Variable | Required | Purpose |
| --- | --- | --- |
| `GEOCITEOPS_API_URL` | no | API base URL. Default `http://localhost:4000`. |
| `GEOCITEOPS_API_KEY` | no | Workspace API key. Omit it for local tools only. |
| `GEOCITEOPS_WORKSPACE_ID` | no | Optional `x-workspace-id`. A workspace API key already selects its workspace. |
| `GEOCITEOPS_PREFER_LOCAL` | no | `1` or `true` keeps readiness, `llms.txt`, and JSON-LD in-process. |

## Run

```bash
npx @geociteops/mcp                 # stdio
npx @geociteops/mcp --http          # Streamable HTTP on 127.0.0.1:3333/mcp
npx @geociteops/mcp --help
```

## Tools

`run_geo_health_check`, `get_geo_health_report`, `run_agent_readiness_audit`, `get_agent_readiness_report`, `list_queries`, `add_queries`, `run_citation_check`, `get_share_of_voice`, `optimize_content`, `generate_schema`, `generate_llms_txt`, `extract_knowledge_graph`.

Long jobs poll for `waitMs` (default 45 seconds) and return the job id if they are still running. Prompts: `geo-audit`, `improve-citations`. Resources: `geociteops://reports/geo-health/latest` and `geociteops://reports/agent-readiness/latest`.

## License

[MIT](https://github.com/letheliu/geociteops/blob/main/LICENSE) © 2026 letheliu
