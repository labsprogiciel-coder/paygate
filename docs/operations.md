# Operations

## Set up

```bash
npx wrangler d1 create paygate          # put the id in wrangler.jsonc
npx wrangler kv namespace create CACHE  # put the id in wrangler.jsonc
npm run db:migrate
npx wrangler secret put ADMIN_API_KEY            # 24+ random characters
npx wrangler secret put WEBHOOK_MASTER_SECRET    # 24+ random characters. Webhook secrets are derived from it: do not lose or change it
npx wrangler secret put PAWAPAY_API_TOKEN
npx wrangler secret put ALERT_WEBHOOK_URL        # Slack or Discord incoming webhook
npm run deploy
```

### Operator sign-in with Clerk

Optional; without it the console asks for `ADMIN_API_KEY`. With it, operators sign in with their own Clerk account and their actions are recorded under their Clerk user id. `ADMIN_API_KEY` keeps working for scripts and as a break-glass login ("Use the operator key instead"); leave it unset to allow Clerk only.

1. Create a Clerk application. In **Configure → Restrictions**, set sign-up to **Restricted** (or use an allowlist): only invited people should get accounts.
2. In `wrangler.jsonc` vars, set `CLERK_PUBLISHABLE_KEY` (`pk_live_…`, not a secret).
3. `npx wrangler secret put CLERK_SECRET_KEY` (`sk_live_…`; session keys are fetched from Clerk and cached), or instead `CLERK_JWT_KEY` with the PEM public key from **API keys → Show JWT public key** to check sessions with no network call.
4. Have each operator sign in once: the console shows their Clerk user id. Add it to `CLERK_OPERATOR_IDS` (comma-separated) and deploy. An empty list lets nobody in.
5. In Clerk, add the Worker's URL as an allowed origin for production instances. Session tokens are only accepted when issued for the Worker's own origin.

PI-SPI (optional): secrets `PI_SPI_ACCOUNT_ALIAS`, `PI_SP_API_CLIENT_ID`, `PI_SP_API_CLIENT_SECRET`, `PI_SPI_API_KEY`; vars `PI_SPI_PARTICIPANT`, `PI_SPI_BUSINESS_API_URL`, `PI_SP_API_OAUTH_URL`, then `PISPI_ENABLED`, `PISPI_POLL`, `PISPI_RTP`. Reading and sending are separate switches.

### Error reporting with Sentry

Optional; off until the secret is set. `npx wrangler secret put SENTRY_DSN` with the DSN of a Sentry project (Settings → Projects → Client Keys). Then:

- **What is sent:** unexpected errors (a request answered 500, a cron step that failed) tagged with where they happened (`where`, `method`, `path` with ids replaced by `:id`, or the cron `step`); and every critical or warning operator alert (unknown payout, wallet that cannot cover payouts, undeliverable webhook...) as a Sentry message, grouped by its title.
- **What is never sent:** request or response bodies, cookies, query strings, auth and signature headers. API keys, webhook secrets, bearer tokens and phone numbers are masked wherever they appear.
- Each event carries the Worker version as its release, and the environment `production` (with `LIVE=true`) or `sandbox-<mode>`.
- Branch previews have no secrets, so they never report.
- Errors only: no performance tracing.

### The books (Formance ledger)

Every money movement is also booked as a double-entry posting in `ledger_postings` (migration 0003), so the gateway always knows **whose money is in each shared wallet**. A completed collection credits its product, a payout that was sent is held, then paid out or released. Accounts per pool (a pawaPay country, or `PISPI` for the bank account):

| Account | Meaning |
|---|---|
| `tenants:{tenant}:{pool}:available` | what a product owns in the pool (tenant dashes become underscores) |
| `tenants:{tenant}:{pool}:held` | payouts sent and not final (processing or unknown) |
| `pool:{pool}:unallocated` | float the studio put in, or fees taken out, owned by no product |
| `world` | outside: customers, recipients, the studio's top-ups |

- **Copy to Formance (optional).** Set the var or secret `FORMANCE_URL` (the stack, e.g. `https://<org>-<stack>.<region>.formance.cloud`) and the secrets `FORMANCE_CLIENT_ID` / `FORMANCE_CLIENT_SECRET`. Optional: `FORMANCE_LEDGER` (default `paygate`, created on first use) and `FORMANCE_TOKEN_URL` (default `/api/auth/oauth/token`). The cron sends unposted postings every minute; each posting's reference is the Formance reference, so a retry never books twice. If Formance is down, payments are untouched and postings wait.
- **Records, does not refuse (yet).** Every script allows an overdraft, so a product paying out more than it collected shows a **negative** balance instead of being refused. Enforcing it (Formance refusing the hold) is the next step, once the books have run clean.
- **First run:** after `npm run db:migrate`, open Providers → Books → **Rebuild from payments** to book the history. Then book the studio's float as an adjustment (**Book an adjustment…**, e.g. "opening float", positive), so each wallet's difference comes to zero. Book provider fees the same way (negative). An adjustment can't be edited: book the opposite to undo one.
- **Formance refusing us** (401, 403, 429, 5xx) stops the sweep until the next minute, so postings don't lose their tries; a 401 fetches a new token. A posting that still fails 10 times is left for a person: fix the access, then Providers → Books → **Retry stuck postings**.
- **Every day at 03:00 UTC** the cron alerts when a wallet and its books differ, when postings are stuck on their way to Formance (after 10 tries), or when Formance and the journal disagree.

## Add a product

```bash
A='Authorization: Bearer <ADMIN_API_KEY>'
curl -X POST $GW/admin/tenants -H "$A" -H 'content-type: application/json' -d '{"id":"courtly","name":"Courtly","webhookUrl":"https://courtly.example/paygate"}'
curl -X POST $GW/admin/tenants/courtly/keys -H "$A" -d '{"label":"prod"}'      # give the key to the product (shown once)
curl $GW/admin/tenants/courtly/webhook-secret -H "$A"                          # and the secret it verifies webhooks with
```

Set `maxAmount` per product if it should be lower than `DEFAULT_MAX_AMOUNT`.

## Modes

| `PROVIDER_MODE` | `LIVE` | |
|---|---|---|
| `sandbox` | `false` | Nothing moves; the last digits of the phone number pick the outcome (`…0000` refused, `…0002` fails, `…9999` stays pending, `…5555` network error, otherwise completes). For development. |
| `pawapay` | `false` | pawaPay's **sandbox** (`api.sandbox.pawapay.io`): no money moves. |
| `pawapay` | `true` | Real money. Refused with the sandbox URL; unsigned callbacks refused. |

Unsafe combinations stop the Worker (it answers 500 to everything) rather than run.

## Before going live

1. In the pawaPay dashboard set the **deposit and payout callback URLs** to `/callbacks/pawapay/deposits` and `/callbacks/pawapay/payouts`, with **signed callbacks on**. With `LIVE=true` an unsigned callback settles nothing (the cron still does, every minute).
2. Run a collection and a payout through the **pawaPay sandbox** (`PROVIDER_MODE=pawapay`, `LIVE=false`) and check `GET /admin/provider-events` to see what a real callback looks like.
3. Set a **minimum wallet balance** per wallet in pawaPay's settlement settings, so a settlement cannot empty the float. Top-ups are a bank transfer and take days.
4. Watch the alert channel for the first week. Alerts to expect to act on: *outcome unknown*, *callback for a payment we don't know*, *webhook undeliverable*, *wallet low/critical*, *payment completed after being reported failed*, *PI-SPI payment does not match*.

## What the cron does (every minute)

1. Delivers due webhooks.
2. Asks the provider about open payments not looked at for a minute; sends a disbursement that was recorded but never sent; looks again, hourly, at failed or expired payments of the last day (a week for PI-SPI) in case they completed late.
3. Every fifth minute: checks the wallets (alerts at most once per 12 hours per country and level).
4. Copies new ledger postings to Formance, if it is set up. At 03:00 UTC: checks the books against the wallets and Formance.

## Runbook

| Alert | Do |
|---|---|
| **Disbursement outcome unknown** | Look the payment up at pawaPay (`GET /admin/payments/{id}` shows its provider id). Then `POST /admin/payments/{id}/resolve` with `completed` or `failed` and a note. Never send it again. |
| **Completed after being reported failed** | The customer was charged (collection) or the recipient paid (disbursement) after the product was told otherwise. Tell the product's owner; they may have refunded or re-paid. |
| **Callback for a payment the gateway does not know** | Read `GET /admin/provider-events`. Usually a different environment pointing at the same pawaPay account, or a payment started elsewhere. |
| **Webhook undeliverable** | Fix the product's endpoint, then `POST /admin/webhooks/{id}/retry`. |
| **PI-SPI payment does not match** | The customer paid the wrong amount or by another route. Nothing was settled. Refund or complete by hand, then `resolve`. |
| **Wallet low / critical** | Top up that country's wallet at pawaPay. |

## Known limits

- One operator key; no UI.
- A tenant's webhook is delivered from the cron and after each request, so a quiet gateway delivers within a minute at worst.
- Reading a payment at most every 4 seconds per payment reaches the provider; there is no per-tenant rate limit yet.
