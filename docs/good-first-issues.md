# Good first issues

These are suggestions, not GitHub issues. If you want to work on one, open an issue first and say which item it is, so two people do not start the same change. See [CONTRIBUTING.md](../CONTRIBUTING.md) for branches, commits, and tests.

中文说明：下面是建议，不是已经建好的 issue。想做的话先开一个 issue，写明对应哪一条。

## Wire the Anthropic adapter

`src/modules/citation-monitor/platform-adapters/anthropic.ts` implements `PlatformAdapter`, and the demo seed even writes `anthropic` rows. `src/server.ts` does not `registry.register` it, and `REQUIRED_KEYS` in `src/platform/tenancy/credential-resolver.ts` has no `anthropic` entry, so the health check and the scheduler will never call it.

A first change is to register it the same way Gemini is registered, add the credential keys the adapter already reads (`ANTHROPIC_API_KEY`, and the optional base URL and model), and cover it with the same kind of registry test the other adapters have. Document the env vars in `.env.example` only after the code reads them.

## Open the latest report when the page loads

`web/src/views/geo-health/Check.vue` and `web/src/views/agent-readiness/Audit.vue` load history and wait for a click. After `pnpm demo:reset`, a reader lands on an empty form with the finished report one row below.

Opening the newest `SUCCEEDED` or `PARTIAL` row on mount would make the demo and a returning user land on the score. Keep the click behavior. Do not auto-start a new run.

## Check relative links in the docs

README files and `docs/` link to each other by relative path. A small script (or a CI step) that fails when a relative link points at a missing file would catch drift. Skip links that leave the repo (`http`, `https`, `mailto`). The gate in `.github/workflows/ci.yml` is the place to add it, next to the typecheck job, so it does not need Postgres.

## Let `DEMO_ACCOUNT_PASSWORD` reset an existing demo user

`scripts/reset-demo.mjs` prints a password only when it creates `demo-viewer`. If the user already exists, setting `DEMO_ACCOUNT_PASSWORD` does nothing, and the script says so. A daily demo reset cannot publish a known password without deleting the row by hand.

When the env var is set, update that user's password hash (and leave `mustChangePassword` false). When it is unset, keep today's behavior: do not invent a new password for an account that already exists.

## Fill in missing English UI strings

The console already has a dictionary. Chinese source strings are the keys, and `web/src/i18n/en-US.ts` holds the English. A string that is missing from that file stays Chinese when the locale is English.

A first change is to find `t("...")` calls whose key is absent from `en-US.ts` and add the English line. Leave report objects that already carry `{ en, zh }` alone.

## Document one deploy path you actually tried

[docs/deploy.md](./deploy.md) covers Compose, Render, Railway, and Zeabur. Compose is the path exercised in development. The hosted blueprints are templates. If you deploy one of them and a step is wrong (private DNS, the database plan slug, the Zeabur Dockerfile path), correct that section and say which host you used. Do not add a second deploy guide.
