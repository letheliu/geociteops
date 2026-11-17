# GeoCiteOps Claude Code plugin

Skills:

| You can say | Claude Code command | Tool |
| --- | --- | --- |
| `/geo audit <url>` | `/geociteops:geo-audit` | `run_agent_readiness_audit` |
| `/geo health <brand> <url>` | `/geociteops:geo-health` | `run_geo_health_check` |
| `/geo optimize <url>` | `/geociteops:geo-optimize` | `optimize_content` |
| `/geo llms-txt <url>` | `/geociteops:geo-llms-txt` | `generate_llms_txt` |
| `/geo schema <url>` | `/geociteops:geo-schema` | `generate_schema` |

## Install

From the GitHub repository:

```bash
claude plugin marketplace add letheliu/geociteops
claude plugin install geociteops@geociteops
```

From a local checkout:

```bash
claude plugin marketplace add .
claude plugin install geociteops@geociteops
```

The plugin starts `npx -y @geociteops/mcp` and asks for the API URL, the workspace API key, and an optional workspace id. Leave the key empty to use the local tools.

To register the server without the skill pack:

```bash
claude mcp add --transport stdio geociteops \
  --env GEOCITEOPS_API_URL=http://localhost:4000 \
  --env GEOCITEOPS_API_KEY=<workspace-api-key> \
  -- npx -y @geociteops/mcp
```

See [docs/mcp.md](../../docs/mcp.md).
