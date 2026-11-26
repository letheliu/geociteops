# WorkBuddy listing packet

This directory prepares a GeoCiteOps listing for [WorkBuddy 开放平台](https://open.workbuddy.cn). It follows the current docs:

- [连接器](https://open.workbuddy.cn/docs/connector) — MCP + user-supplied token (`auth_mode: "token"`, `minWorkbuddyVersion` `4.23.0`)
- [技能](https://open.workbuddy.cn/docs/skill)
- [专家](https://open.workbuddy.cn/docs/expert)
- [开放平台概述](https://open.workbuddy.cn/docs/what-is-open-platform) and the [开发者公约](https://open.workbuddy.cn/docs/developer-agreement)

Nothing here is uploaded, submitted, or published by this repository. OAuth (`auth_mode: "server-side"`) is not implemented. One connector has one auth mode, so OAuth would be a second `source` later. The endpoint list is in [docs/mcp.md](../../docs/mcp.md).

The example brand in every sample is Acme Draw at `https://acmedraw.example`.

## What is in the tree

| Path | Uploaded as |
| --- | --- |
| `connector/` | One connector zip. `source` is `geociteops`. |
| `skills/*/` | One skill-market zip each. |
| `expert/` | One expert zip, plus the connector skills copied in at build time. |
| `connector/icon.svg` | Connector icon, the compass mark from the repo logo. |
| `expert/avatars/expert.png` | 512×512 expert avatar. It is not the compass mark. Regenerate with `node integrations/workbuddy/scripts/render-avatar.mjs`. |

`connector/mcp.json` asks the user for `API_BASE_URL` and `API_KEY` and sends `Authorization: Bearer ${API_KEY}` to `${API_BASE_URL}/mcp`. The key field is `type: "password"`. No real token is stored in these files.

## Build the zips

From the repository root:

```bash
node integrations/workbuddy/build-zips.mjs
```

Outputs land in `integrations/workbuddy/dist/` (gitignored):

- `geociteops-connector.zip`
- `geociteops-skill-geo-health-check.zip`
- `geociteops-skill-agent-readiness-audit.zip`
- `geociteops-skill-llms-txt-jsonld.zip`
- `geociteops-expert.zip`

## Before you upload

1. Deploy the API and run `npx @geociteops/mcp --http` behind HTTPS. `GEOCITEOPS_API_URL` on that process must reach `GET /mcp/token`. Do not put the MCP port on the public internet without TLS.
2. In the GeoCiteOps console, open **API 凭证**, create a token, and choose **只读（read）** or also **运行检查（run-checks）**. Copy it once. It is not shown again. Do not paste it into this repo, the zip, or a chat log.
3. In `expert/.mcp.json`, replace `https://mcp.example.com/mcp` with `https://<your-host>/mcp`.
4. In `expert/.codebuddy-plugin/plugin.json`, replace `maintainers@geociteops.example` with a mailbox you actually read.
5. Rebuild the zips after those two edits.

Leave `DEMO_MODE` off on the host you use for the review test. Demo mode is read-only and will refuse the health check.

## Console steps (do these by hand)

1. Register at [https://open.workbuddy.cn](https://open.workbuddy.cn) and finish developer or company verification. The overview page lists this as step 1 and 2.
2. Open **连接器** and create a connector. Upload `geociteops-connector.zip`. If the parser rejects it, compare the zip root with [the connector package layout](https://open.workbuddy.cn/docs/connector) (`connector-meta.json`, `mcp.json`, `token-schema.json`, `icon.svg`, `skills/*/SKILL.md`). The docs say to mail openworkbuddy@tencent.com or use the community QR on the homepage when that still fails.
3. Create the test environment the console offers. Connect with the token form. Use the HTTPS origin as **API 地址** and the console token as **API 令牌**.
4. In that test chat, run one read (for example list the query library or fetch a stored report) and one `run-checks` call (a GEO health check, or `llms.txt` generation that should be stored). Confirm a `read` token is refused for the health check, and that a revoked token returns an auth error rather than data. Confirm the product does not print the token.
5. Open **技能**, choose **添加技能**, and upload each skill zip.
6. Open **专家** and upload `geociteops-expert.zip`. The avatar must stay 512×512 and under 500KB. The Chinese `displayDescription` is 40 characters, which is the documented minimum. `defaultInitPrompt` matches the first quick prompt.
7. Read the [开发者公约](https://open.workbuddy.cn/docs/developer-agreement) again before submit: the name and description match the tools, the demo data is labeled fictional, there is no production secret, and the connector icon and the expert avatar are different drawings. The health check can spend model money. Say that in the review notes.
8. Submit the connector, the skills, and the expert for review. After approval they stay unpublished until you click publish. This repository does not do that click.
9. Domain allow-listing (`*.workbuddy.cn`, `*.codebuddy.cn`, `*.workbuddy.ai`, `copilot.tencent.com`, `staging-codebuddy.tencent.com`, client names `WorkBuddy Connector` and `CodeBuddy`) is only required for OAuth. Skip it for this token connector.

Token mode does not refresh. When a user revokes the token in the console, the next call fails and they must paste a new one.
