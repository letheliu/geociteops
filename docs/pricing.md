# Editions

GeoCiteOps is open source. You can run it yourself at no license fee. The hosted and services rows below are how a paid offer would be shaped. They are not switches in this repository, and the prices are not set.

There is no docs site in this repo. This page is the edition description.

## Community

Self-hosted. [MIT licensed](../LICENSE). Docker Compose, the Render Blueprint, and the Railway and Zeabur templates are the install paths ([deploy](./deploy.md)).

You pay for the computer it runs on and for any model or search API you connect. The Agent Readiness audit, the citability and structured-signal parts of a GEO health check, `llms.txt`, and JSON-LD do not need those keys. Citation monitoring calls only the engines whose credentials you stored.

The engines registered in `src/server.ts` are DeepSeek, Doubao, Qwen, ERNIE, Perplexity, ChatGPT Search, Gemini, Kimi (Moonshot), and Tencent Yuanbao (Hunyuan API, not the Yuanbao app).

The in-app catalog, orders, and mock payments exist so someone can run GeoCiteOps as a multi-tenant service. They do nothing until `BILLING_ENFORCEMENT=on`.

## Cloud

A hosted subscription, run by the maintainer, so a team does not operate Postgres or the workers.

| | |
| --- | --- |
| Who it is for | A brand or an in-house SEO team that wants the console without hosting it |
| Includes | The Community feature set on shared infrastructure, backups, and a public status page |
| Price | TBD |
| Billing period | TBD |
| Data | TBD — say where the database lives before taking payment |

No payment link is wired up. Do not invent a number in the README or on a checkout page.

## Enterprise and agency

A commercial agreement around the same codebase. Not a flag you can turn on in `docker-compose.yml`.

| Offer | What it means |
| --- | --- |
| Private deploy | The stack runs in the customer's cloud account. They hold the database and the master key. |
| White-label | The console carries their name and domain. The open-source build does not theme itself per tenant. |
| SSO | The customer's identity provider signs users in. The open-source build uses usernames and passwords. |
| Support | A named contact and a response window, written into the agreement. |

Price: TBD.

## GEO audit service

A done-for-you pass over one brand: an Agent Readiness audit, a GEO health check, and a short list of pages to change. The customer can then keep using Community or Cloud to re-check on a schedule.

Price: TBD. Scope (one site, how many competitors, which engines) is agreed before the work starts.

## Contact

Replace this line with a real address before you publish the page anywhere but the repository:

`REPLACE_WITH_CONTACT_EMAIL`

Until then, open a GitHub issue: <https://github.com/letheliu/geociteops/issues/new>.
