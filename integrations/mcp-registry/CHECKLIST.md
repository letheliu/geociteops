# MCP registry checklist

This folder prepares a listing for `@geociteops/mcp`. Nothing here is submitted by CI, and this change does not publish to npm.

| File | Who reads it |
| --- | --- |
| [`server.json`](./server.json) | Official MCP Registry. Schema `2025-12-11`. Server name `io.github.letheliu/geociteops`. |
| [`smithery.yaml`](./smithery.yaml) | Copy of the root [`smithery.yaml`](../../smithery.yaml). Smithery reads the root file. Keep the two identical. |

`mcp/package.json` sets `mcpName` to the same server name. The registry checks that field on the **published** npm tarball, not on the git file.

## Before you submit

Do these yourself. Do not automate them from this repo.

1. Publish `@geociteops/mcp` at the version in `server.json` (`0.1.0`) to the public npm registry. `pnpm 11` refuses packages published less than a day ago, so do not bump unrelated dependencies in the same change. The publish steps already live in [docs/DEPLOYMENT.md](../../docs/DEPLOYMENT.md). A dry-run is in CI and does not upload.
2. Confirm the published `package.json` contains `"mcpName": "io.github.letheliu/geociteops"`. If you publish a newer version, bump `version` in `server.json`, in `mcp/package.json`, and in the `packages[0].version` field together. A published registry version cannot be edited.
3. Install the registry CLI and log in with GitHub as `letheliu` (the `io.github.letheliu` namespace). From the registry quickstart: `mcp-publisher login github`, then `mcp-publisher publish integrations/mcp-registry/server.json`.
4. Submit the Smithery listing from the GitHub repository. The root `smithery.yaml` starts `npx -y @geociteops/mcp`, so step 1 has to have finished or Smithery's install will not resolve the package. The API key in the config schema is optional because three tools run locally.
5. Spot-check the listing text. It may say the server talks to DeepSeek, Doubao, Qwen, ERNIE, Perplexity, ChatGPT Search, Gemini, Kimi (Moonshot), and Yuanbao through a GeoCiteOps API. Yuanbao is the Hunyuan API, not the Yuanbao consumer app. Do not claim Anthropic; that adapter file is not registered.

## After it is listed

- The official registry page and the Smithery page are the two links worth adding to `docs/mcp.md`.
- A later package version needs a new `server.json` version and a new `mcp-publisher publish`. Publishing the same version twice is rejected.
