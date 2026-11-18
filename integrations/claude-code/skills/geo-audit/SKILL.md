---
name: geo-audit
description: Audit a public URL for AI crawler readiness (robots.txt, llms.txt, sitemap, JSON-LD, markdown, bot access). Use when the user says "/geo audit <url>", asks whether AI crawlers can read a site, or asks for an Agent Readiness audit.
---

# GEO audit

The user wants an Agent Readiness audit. The URL is the argument after `/geo audit`, or the URL they named.

1. Call the GeoCiteOps MCP tool `run_agent_readiness_audit` with that URL.
2. If the result has a job id and no score, call `get_agent_readiness_report` with that id. Say so if it is still running.
3. Lead with the score and grade, then the highest-impact fixes and the verify step for each.
4. Use only checks, scores, and URLs that are in the tool result. Do not add crawlers or findings the audit did not return.
5. This tool works with no API key. Say when the result is `mode: local`, because that audit was not stored.
