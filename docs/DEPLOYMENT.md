# Deployment Runbook — GeoCiteOps

Everything in this document **has not been executed yet**. It is the operator's checklist for the
steps that require a remote machine, a real GitHub repository, or an npm account. Nothing here
belongs in an automated pipeline.

Related: the acceptance criteria this runbook serves live in the M1 spec; the day-to-day dev
workflow is in [CONTRIBUTING.md](../CONTRIBUTING.md).

---

## 0. Before publishing: three things must be pinned

These are the values that are impossible to guess correctly and expensive to change after the fact.

| # | What to pin | Where | Why it matters |
| --- | --- | --- | --- |
| 1 | **GitHub owner / repo** | README badge URLs, `.github/workflows/docker.yml` | Image names come from `github.repository_owner`. The npm org (`geociteops`) is a *different* namespace — mixing them means republishing images later. |
| 2 | **npm org `geociteops`** | `sdk/package.json` name | If the org name is taken, fall back to `geociteops-dev` and update the README badges + SDK README. |
| 3 | **Demo account policy** | `.env` on the demo host | The demo account is shared and read-only. Decide the username, password rotation cadence, and whether the password is published on the demo homepage. |

> Pin #1 is already de-facto resolved: the existing remote is `letheliu/geociteops`, so ghcr images
> will be `ghcr.io/letheliu/geociteops-api` / `geociteops-web`. The npm org remains a separate
> namespace (`geociteops`).

### 0.1 Pre-release history handling (resolved 2026-10-18)

The development history before the public release contains internal working files (AI-assistant
skill directories, development journals, third-party excerpt notes). Per §7, that history is
**not** published: it stays in a local archived branch plus the original (pre-rename) remote,
which the owner keeps private. This public repository starts from a single fresh initial commit
and must never receive that history — in particular, never force-push replaced history onto a
repo that previously carried it: replaced commits stay reachable through the SHA APIs and any
forks/caches for a long time.

---

## 1. Container image build (remote, requires Docker)

Not verifiable on a machine without Docker. Run on the target host or any Linux box:

```bash
# Backend image
docker build -t geociteops-api:dev .

# Web image (build context must be the repo root)
docker build -t geociteops-web:dev -f web/Dockerfile .

# Both should succeed; expected risk: @zvec/zvec native bindings on node:22-slim.
# If the app container fails to load zvec, add the missing apt packages to the
# runtime stage of Dockerfile (see the risk table in the M1 spec).
```

Checklist:

- [ ] `pnpm install --frozen-lockfile` succeeds inside every stage (lockfile is committed)
- [ ] `prisma generate` runs before `tsc` — the Dockerfile ordering matters, see CONTRIBUTING
- [ ] `@zvec/bindings-linux-x64` resolves; no source build required
- [ ] `node dist/src/server.js` starts and does **not** abort on a missing `PAY_MOCK_SECRET`

---

## 2. Compose acceptance (remote) — M1 spec §5.1

> **Verified end-to-end on an internal Linux build host on 2026-10-17** — all §5.1 items pass,
> including volume persistence (probe file + non-empty zvec survive `down`/`up`, re-reset still
> writes vectors). The verification surfaced 9 repo bugs (Node 20→22, in-place prisma generate,
> pnpm global-bin PATH, entrypoint exec bit + CRLF, web/Dockerfile rewrite, migration chain
> rebuild, zvec schema fields, in-container pnpm script hangs) — all fixed on `main`.
> Caveat: that host reaches registry.npmjs.org at dial-up speeds, so verification builds apply
> `--registry=https://registry.npmmirror.com` to the install lines via sed on the verify copy
> only; the shipped Dockerfiles stay registry-default and GitHub Actions runners need no mirror.
> Local follow-ups after the zvec schema change: delete the dev machine's `data/zvec/`
> (collections created with the old schema stay old on disk), and re-baseline the dev database
> once for the squashed migration chain (`prisma migrate resolve` / reset flow).

From a **clean clone** on a fresh Linux machine:

```bash
git clone <repo> && cd geociteops
cp .env.example .env

# Mandatory: both secrets. Generate with
#   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# and paste one value into each.
vi .env      # CREDENTIAL_MASTER_KEY, PAY_MOCK_SECRET

docker compose up -d
```

Verification sequence:

> Why `tsx scripts/...` instead of `pnpm <script>`: pnpm 11 runs dependency-status /
> supply-chain checks against the registry before scripts — inside a container on a slow network
> this hangs for minutes or triggers an unexpected workspace install. The image ships `tsx`
> globally and its deps are frozen at build time; invoking scripts via `tsx` is deterministic.

- [ ] `docker compose ps` shows **four** services: `db`, `migrate` (exited 0), `app`, `web`
- [ ] `http://localhost:5170/login` opens
- [ ] `docker compose logs` contains no `ERROR`-level lines
- [ ] `docker compose exec app tsx scripts/admin-bootstrap.ts --username admin --password <pw>` succeeds
- [ ] Sign in at `/login`, forced password change, lands in `/admin`
- [ ] Load the demo dataset: `docker compose exec app tsx scripts/reset-demo.mjs`
      → prints the read-only demo account password **once**; record it
- [ ] Confirm the seed step reports a non-zero vector count, e.g.
      `✅ zvec 已写入 N 个实体向量（维度 1024，L2 归一化）` followed by `✅ 反查自检通过`

### Volume persistence (the part that silently breaks)

```bash
# Put a file in the uploads volume
docker compose exec app sh -c 'echo "persistence probe" > /app/data/uploads/probe.txt'

# Prove the vector store is non-empty (not just "the volume exists")
docker compose exec app sh -c 'ls -la /app/data/zvec'

docker compose down
docker compose up -d

# Both must still be there:
docker compose exec app sh -c 'cat /app/data/uploads/probe.txt'
docker compose exec app sh -c 'ls -la /app/data/zvec'
```

- [ ] `probe.txt` survives
- [ ] zvec data survives
- [ ] Re-running `pnpm demo:reset` still reports a non-empty vector write

> Do **not** run `docker compose down -v` in the middle of this check — `-v` deletes the named
> volumes and would turn the test into a false pass by wiping both sides.

---

## 3. Demo site deployment — `demo.zoomer.top`

**Coexistence first.** The host already runs another application; do not disturb it. The compose
stack publishes only `5170`, and deliberately does **not** publish PostgreSQL to the host, so it
cannot collide with an existing 5432.

- [ ] `docker stats` confirms the geociteops total stays under **1.5 GB**
      (`db` 512m + `app` 768m + `web` 128m hard caps are set in `docker-compose.yml`)
- [ ] The existing application is still reachable afterwards

DNS and HTTPS:

- [ ] `demo.zoomer.top` A record → host public IP
- [ ] Host nginx terminates TLS (existing certbot) and proxies to `127.0.0.1:5170`
- [ ] `X-Forwarded-Proto` is forwarded — `web/nginx.conf` sets it, and the backend uses it when
      deciding whether to issue the session cookie
- [ ] `GEO_COOKIE_NAME` stays at the default `__Host-geo_sid` (HTTPS ⇒ the prefix is honored)

> Only set `GEO_COOKIE_NAME=geo_sid` for a **bare IP over plain HTTP** deployment. Over HTTPS the
> `__Host-` prefix is strictly more protective and should be left alone.

Demo behaviour to confirm by hand:

- [ ] The shared demo account (`ORG_VIEWER`) can sign in and browse the seed data
- [ ] A write attempt (run monitoring, optimize content, change settings) is **rejected
      server-side**, not merely hidden in the UI
- [ ] The homepage states that live monitoring / content optimization are unavailable on the demo,
      with the "self-host or contact us for a trial" wording

---

## 4. Daily reset cron — `pnpm demo:reset`

The demo account is shared, so visitors can leave state behind. A daily reset returns the tenant to
seed state.

```bash
# Verify manually first
docker compose exec app tsx scripts/reset-demo.mjs

# Then schedule it (host cron, 04:20 local — after the billing crons at 04:05-04:30
# are irrelevant here, but pick a quiet hour regardless)
crontab -e
```

```cron
20 4 * * * cd /opt/geociteops && docker compose exec -T app tsx scripts/reset-demo.mjs >> /var/log/geociteops-demo-reset.log 2>&1
```

- [ ] Manual run succeeds
- [ ] Cron entry installed
- [ ] Confirm the next scheduled run resets demo data to the seed state

Note: the demo account password is printed only on first creation. The script never re-prints it —
to change it, delete the account and re-run, or set `DEMO_ACCOUNT_PASSWORD` in `.env` first.

---

## 5. GitHub repository settings

Set after the repository is public (Settings → General / About):

| Field | Value |
| --- | --- |
| Description | AI citation intelligence and optimization platform for generative search |
| Website | `https://demo.zoomer.top` |
| Topics | `geo`, `generative-engine-optimization`, `llm-seo`, `ai-search`, `brand-monitoring`, `typescript` |

- [ ] Description set
- [ ] Website set
- [ ] All six topics added
- [ ] `main` branch protected, CI required to pass
- [ ] `ci.yml` badge shows **passing** — update the badge URL in both READMEs if the owner differs

---

## 6. npm publish — `@geociteops/sdk@0.1.0`

Publishing requires npm account access and is deliberately **not** automated.

Prerequisites:

- [ ] npm org `geociteops` exists and you can publish to it
- [ ] `npm whoami` confirms the right account

Then, from `sdk/`:

```bash
npm publish --dry-run   # must pass — CI runs this too
npm publish             # actual publish
npm view @geociteops/sdk version   # expect 0.1.0
```

- [ ] dry-run passes
- [ ] `npm view @geociteops/sdk` returns `0.1.0` (M1 spec §5.4)
- [ ] The README badge resolves on npmjs.com

---

## 7. Public release sequence

Per the M1 spec, history is **not** rewritten in place. The existing history stays in a private
backup; the public repository starts from a clean initial commit.

1. Verify §5's cleanup list is fully applied in the working tree
   (`git ls-files` must not list any of the internal paths)
2. Archive the current directory under a private name, e.g. `geociteops-private-archive`
3. Turn the existing public repo private (see §0.1), then delete and re-create it — or rename it
   aside and create a fresh repo — and make a **fresh initial commit** from the cleaned tree.
   Never force-push the new history onto the old repo (see §0.1 for why)
4. Open a PR to verify CI is green on the public remote before any promotion
5. Tag `v0.1.0` — the `docker.yml` workflow publishes images aligned to that tag

- [ ] Cleanup verified with `git ls-files`
- [ ] Private archive exists and is not the public remote
- [ ] Public repo created with §5 settings applied
- [ ] CI green on the public remote
- [ ] `v0.1.0` tagged
