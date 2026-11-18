---
name: geo-health
description: Run a GEO health check for a brand and its official URL. Use when the user says "/geo health <brand> <url>", asks for a GEO score, or wants readiness, citations, citability, and schema in one report.
---

# GEO health

The user wants one GEO health report. Take the brand and the official URL from `/geo health <brand> <url>` or from the message. Industry, competitors, and questions are optional. Ask for the brand or the URL if either is missing.

1. Call `run_geo_health_check` with `brandName` and `siteUrl`. Pass competitors or queries only when the user supplied them.
2. If the result is still running, keep the job id and call `get_geo_health_report`. Do not start a second check.
3. Lead with the score and grade, then pillar scores and the top actions (impact, the fix, and how to verify it).
4. Use only numbers and engine names from the tool result. A skipped engine is not a zero. Say which engines did not run when the result lists them.
5. This tool needs `GEOCITEOPS_API_KEY`. If the tool says the key is missing, say that local mode can still audit the URL with `run_agent_readiness_audit`, and that the health check needs the API.
