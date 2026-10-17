# @geociteops/sdk

Typed tRPC client for the [GeoCiteOps](https://github.com/letheliu/geociteops) API.

GeoCiteOps is a Generative Engine Optimization (GEO) platform: it monitors how AI answer engines
mention your brand, optimizes the content those engines can cite, and publishes structured signals
(Schema.org, `llms.txt`, knowledge graph) for AI crawlers.

This package gives you a fully typed client for the workspace API — no hand-written request builders,
no drift between the server router and your editor.

## Install

```bash
npm install @geociteops/sdk
```

Requires Node.js 20+.

> **This package ships TypeScript source.** The entry point is `src/index.ts`, not compiled
> JavaScript — that is deliberate: the exported types are inferred directly from the server's
> tRPC router tree, which is where the end-to-end typing comes from (see `sdk/tsconfig.json`
> for the full rationale). Practical consequence: consume it with a bundler that transpiles
> TypeScript in dependencies (Vite, esbuild, tsup, webpack with a TS loader). Plain
> `node` cannot execute it directly — run it through `tsx` or precompile it first.

## Usage

```ts
import { createGeoClient } from '@geociteops/sdk'

const geo = createGeoClient({
  serviceUrl: 'http://localhost:4000',
  apiKey: '<your-workspace-api-key>',
})

// Track a query across all configured AI platforms
const report = await geo.citation.runMonitor.mutate({ queryId: '...' })

// Optimize a content page
const task = await geo.content.optimize.mutate({ pageId: '...' })
```

## Authentication

Server-to-server calls authenticate with a **workspace API key** sent as the `x-api-key` header.
Keys are issued in the console under Workspace settings and displayed **exactly once** — store it
wherever you keep secrets.

| Call style | Header |
| --- | --- |
| Server-to-server (SDK) | `x-api-key: <workspace-api-key>` plus `x-workspace-id: <workspace-id>` |
| Browser console session | Session cookie issued by `/login` |

## Options

| Option | Required | Description |
| --- | --- | --- |
| `serviceUrl` | yes | Base URL of your GeoCiteOps API, e.g. `http://localhost:4000` |
| `apiKey` | yes | Workspace API key |
| `workspaceId` | no | Convenience default for `x-workspace-id`; can also be passed per call |

## Self-hosting

The SDK talks to any self-hosted instance. See the
[repository README](https://github.com/letheliu/geociteops#quick-start) for the Docker Compose
quick start.

## Status

`0.1.0` — pre-1.0. Minor releases may contain breaking changes; check the
[CHANGELOG](https://github.com/letheliu/geociteops/blob/main/CHANGELOG.md) before upgrading.

## License

[MIT](./LICENSE) © 2026 letheliu
