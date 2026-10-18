# Contributing to GeoCiteOps

Thanks for your interest. This document covers the conventions that keep the codebase reviewable and the CI green.

## Before you start

- **Open an issue first for anything substantial.** A PR that changes authorization, billing, or the Prisma schema needs a design conversation before code. Small bug fixes can go straight to a PR.
- **Search existing issues.** Duplicate reports slow everyone down.

## Branches

| Branch | Purpose |
| --- | --- |
| `main` | Released code. Protected: CI must be green before merge. |
| `feat/<scope>-<short-description>` | New capability, e.g. `feat/kg-similarity-view` |
| `fix/<scope>-<short-description>` | Bug fix, e.g. `fix/cookie-secure-localhost` |
| `chore/<short-description>` | Tooling, CI, docs, dependency bumps |

Keep branches short-lived. If a PR grows past a few hundred lines, consider splitting it.

## Commit messages

[Conventional Commits](https://www.conventionalcommits.org/), English or Chinese — pick one and stay consistent within a branch.

```
<type>(<scope>): <subject>

<body — why, not what. Reference issues with Closes #123.>
```

**Types:** `feat` · `fix` · `docs` · `refactor` · `perf` · `test` · `build` · `ci` · `chore`

```
fix(billing): 扫描批量上限从 500 降到 200，避免单次任务占满连接池
feat(kg): 增加相似实体检索视图
ci: CI 增加 web 类型闸门（vue-tsc）
```

## Tests are required

**New logic ships with tests.** CI runs `vitest run`, and the PR template asks you to paste the actual result line — not just tick a box.

```bash
pnpm test                          # full suite
pnpm test:watch                    # watch mode
pnpm exec vitest run tests/xyz.test.ts   # single file
```

### The `prisma generate` ordering rule

Run `pnpm db:generate` **before any `tsc` step** — locally and in CI:

```bash
pnpm db:generate
pnpm exec tsc -p tsconfig.build.json --noEmit
```

`@prisma/client` types (`Prisma.InputJsonValue` and friends) are generated into `node_modules/.prisma`. Skip the generate step and `tsc` reports 200+ phantom errors across files you never touched.

### What CI type-checks

`tsc --noEmit` over the full `tsconfig.json` is **not** the gate — that config also includes `tests/`, and the test files have never been type-tightened (vitest transpiles via esbuild without checking types, so they pass at runtime). The gate is:

```bash
pnpm exec tsc -p tsconfig.build.json --noEmit   # shipped code
pnpm --filter geociteops-web exec vue-tsc -b   # web
```

Both must pass before review.

### Known environment-dependent failures

A few suites fail for environment reasons, not logic, and are expected to fail on a machine without setup. Triage new failures against this list before assuming you caused them:

| Suite | Reason |
| --- | --- |
| `tests/e2e-citation-flow.test.ts` | Needs a live PostgreSQL. Its `beforeAll` calls `deleteMany` and wipes `citationEvent` / `citationQuery` / `workspace` — **never point `DATABASE_URL` at anything but a throwaway test database.** |
| `tests/zvec-smoke.test.ts` | zvec is an in-process native library; its temp-directory cleanup fails with `EBUSY` on Windows. Passes on Linux CI. |

## Database rules

> **Never run `pnpm db:push` or `prisma migrate deploy` against a database that holds data you care about.** The P0 migrations drop the `Workspace.apiKeyHash` column — irreversible, and it destroys every legacy SDK key if it runs before the carry-over script. Existing deployments must follow the ordered upgrade procedure in the README.

- Use `pnpm db:push` **only** for local throwaway databases.
- Schema changes go through a reviewed Prisma migration; never hand-edit `schema.prisma` without regenerating the client.
- Never commit `.env` or any real credential.

## Code style

- TypeScript `strict` mode is on. No `any` unless you can explain why in a comment.
- Match the surrounding file's style rather than your own — there is no formatter config in this repo, so consistency is manual.
- Comments explain **why**, not what. Chinese and English are both fine; match the file.
- Keep platform adapters behind the existing `PlatformChannel` interface. Adding a platform should not require touching call sites.

## Pull requests

Fill in the template, including the real `pnpm test` output. A PR description that says "tests pass" without evidence will be sent back.

CI requires, on `main`:

1. `pnpm exec tsc -p tsconfig.build.json --noEmit`
2. `pnpm --filter geociteops-web exec vue-tsc -b`
3. `pnpm test` against a dedicated pgvector database, after `prisma migrate deploy`

## Reporting bugs

Use the **Bug report** issue template. Include the version/commit, the deployment method (Compose vs. local pnpm), and reproduction steps. **Strip secrets, cookies, and internal addresses from any logs you paste.**

## License

Contributions are licensed under the [MIT License](./LICENSE).
