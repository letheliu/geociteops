# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Status: pre-release.** The project is at `0.1.0`. Until `1.0.0`, minor bumps may contain breaking changes; anything relevant is listed under `Unreleased`.

## [Unreleased]

Nothing yet.

## [0.1.0] - 2026-10-17

First public release. This milestone (M1, "open-source credibility") is about making the project
runnable and credible for a stranger: clone it, run it, understand it.

### Added

- **Containerized one-command deployment** — four-service Docker Compose stack (`db` / `migrate` / `app` / `web`), multi-stage `Dockerfile` on `node:20-slim`, and `web/Dockerfile` building the Vue console into nginx. Three named volumes persist PostgreSQL, the zvec vector store (`zvec-data`), and uploaded files (`uploads`).
- **Demo environment reset** (`pnpm demo:reset`) — idempotently provisions the demo organization, workspace, and a read-only `ORG_VIEWER` account, truncates demo data, re-runs the seed, and upserts deterministic pseudo-embeddings for seeded knowledge-graph entities into zvec. Zero LLM dependency, so the demo dataset can be verified offline.
- **Deterministic vector generator** (`scripts/lib/deterministic-vector.ts`) — SHA-256 derived, L2-normalized unit vectors at `ZVEC_DIM`; determinism, dimension, and unit-norm are covered by 10 tests.
- **CI** — GitHub Actions with a typecheck gate (backend `tsc`, web `vue-tsc`) and a test job backed by a dedicated `pgvector` service and throwaway `zoomer_test` database that is migrated before the suite runs.
- **Image publishing** — `docker.yml` builds and pushes `linux/amd64` images to ghcr.io, tagged to match releases.
- **Community templates** — bug report and feature request forms, a PR template with a test-evidence checklist, and a `CONTRIBUTING.md` covering branches, commit style, and the `prisma generate`-before-`tsc` ordering rule.

### Changed

- **Repository hygiene** — internal AI-workflow skill copies (`.agents/`, `.codex/`, `.opencode/`, `.qwen/`, `.trae/`), internal development records (`.workbuddy/`, `docs/superpowers/`), third-party excerpt material (`docs/claude-seo-reference/`), private specs (`docs/specs/`), and competition-submission drafts are untracked and ignored.
- **Lockfile is now committed** — `pnpm-lock.yaml` was previously ignored; it is version-controlled, and CI plus all Docker stages install with `--frozen-lockfile`.
- **SDK renamed** — `@scope/geo-sdk` → `@geociteops/sdk`, aligning the package name with the repository and ghcr image names.
- **README (EN + zh-CN)** — Docker Compose quick start promoted to the primary path, session-cookie `Secure` behavior documented, CI / Docker / npm badges added.
- **`CREDENTIAL_MASTER_KEY` and `PAY_MOCK_SECRET` are marked mandatory** in `.env.example`, and Compose now fails fast when either is missing instead of letting the app crash-loop.

### Security

- `PAY_MOCK_SECRET` stays fail-closed: the server refuses to start without it. A default secret is public in source, and silently falling back to it would allow forged payment callbacks to mark orders paid.
- Workspace platform credentials remain envelope-encrypted (AES-256-GCM) under `CREDENTIAL_MASTER_KEY`.
- A pre-publication scan of the tracked tree confirms no private keys, no plaintext API keys, and no internal addresses. The single `sk-` pattern match in the repo is a deliberate envelope-leak test fixture.

[Unreleased]: https://github.com/letheliu/geociteops/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/letheliu/geociteops/releases/tag/v0.1.0
