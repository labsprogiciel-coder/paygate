# API

Base URL: your Paygate Worker. All bodies are JSON. Amounts are whole **XOF** (no minor unit). Times are Unix milliseconds.

## Authentication

Every `/v1` call carries `Authorization: Bearer pgk_<id>_<secret>`. The operator creates your key (shown once). A revoked key and a suspended account both answer `401`.

## Errors

```json
{ "error": { "code": "amount_out_of_bounds", "message": "This amount is outside the provider limits", "min": 100, "max": 1000000 } }
```

`code` is stable and meant for programs. Some codes carry extra fields (`min`/`max`, `codeInstructions`, `wallet`).

| Status | Codes |
|---|---|
| 400 | `invalid_request` `invalid_json` `invalid_reference` `invalid_amount` `invalid_currency` `invalid_rail` `invalid_operator` `invalid_phone` `invalid_payer_alias` `invalid_metadata` `invalid_url` `invalid_expiry` `invalid_pre_auth_code` `invalid_country` `country_required` |
| 401 | `unauthorized` |
| 404 | `not_found` |
| 409 | `idempotency_conflict` |
| 413 | `payload_too_large` |
| 422 | `wallet_not_enabled` `provider_unavailable` `amount_out_of_bounds` `amount_too_large` `pre_auth_code_required` `redirect_urls_required` `no_webhook` |
| 429 | `rtp_limit` `rate_limited` |
| 5xx | `internal`, or the request failed before anything was recorded |

## Rate limits

Each account has two budgets per minute: **60 writes** (every `POST`: creating a collection or a disbursement, a test webhook) and **600 reads** (every `GET`). Going over answers `429 rate_limited` with a `Retry-After` header (seconds) and `retryAfter` in the error; nothing is created. Wait that long, then retry with the **same `reference`**, so a retry can never make a second payment. The counters are approximate (counted per Cloudflare location); they stop runaway loops, they are not a quota to plan against. Polling a payment is a read: prefer webhooks.

## Collections (money in)

`POST /v1/collections`

| Field | |
|---|---|
| `reference` | **Required.** Your own id, 3–64 of `A-Za-z0-9_-`. It makes the call safe to retry: the same reference with the same details returns the same payment (`200`); with different details, `409`. |
| `amount` | **Required.** Whole XOF, at least 100, at most your account limit. |
| `rail` | `mobile_money` (default), `pispi_qr`, `pispi_rtp`. |
| `operator`, `phone` | mobile money: `orange`, `wave`, `moov`; the payer's E.164 number (CIV +225, SEN +221, BFA +226). |
| `payerAlias` | `pispi_rtp`: the customer's PI-SPI alias (a UUID). |
| `preAuthCode` | Providers that need a one-time code first (Orange Burkina Faso). Without it you get `422 pre_auth_code_required` with `codeInstructions` to show the customer. |
| `successUrl`, `failedUrl` | Providers that send the customer to their app (Wave). Required there. https only. |
| `expiresInSeconds` | 60–86400. Defaults: 15 min mobile money, 1 h payment request, 3 h QR. |
| `metadata` | An object, up to 2 KB, returned as given. |

Creating it also starts it, so you get `201` with the payment, `status: "processing"`:

```json
{
  "id": "pg8a5e0f696285f16e8", "object": "collection", "reference": "order-1", "rail": "mobile_money",
  "status": "processing", "amount": 5000, "currency": "XOF", "operator": "orange", "counterparty": "+2250700000001",
  "nextStep": null, "authUrl": null, "qr": null,
  "method": { "authType": "PROVIDER_AUTH", "instructions": { "en": ["Dial *144#"], "fr": ["Composez *144#"] }, "codeInstructions": null },
  "failure": null, "metadata": null, "createdAt": 1791982814330, "expiresAt": 1791983714330, "settledAt": null, "refund": null
}
```

What to show the customer while `processing`: `method.instructions` (approve on the phone), `authUrl` (send them there), or `qr` (render a PI-SPI dynamic QR from its fields).

`GET /v1/collections/{id or reference}` · `GET /v1/collections?reference=…` · `GET /v1/collections?status=&limit=&before=` · `GET /v1/collections/{id}/events`

A read also asks the provider if the payment is still open (at most every 4 seconds), so you can poll. Webhooks are the better way.

## Disbursements (money out)

`POST /v1/disbursements` takes `reference`, `amount`, `operator`, `phone`, `metadata` (mobile money only). It is sent once. Answers `201` with `completed`, `processing` (accepted, settles later), `failed` (nothing was sent), or **`unknown`**.

`unknown` means the request may or may not have reached the provider. **It is not retried.** An operator is alerted and checks the provider. Do not pay the person another way or send it again until the status moves: when it does, you get a webhook. If it ends `failed`, make a new disbursement with a **new** reference.

Reads are the same as for collections, under `/v1/disbursements`.

## Statuses

| Status | Meaning | Final? |
|---|---|---|
| `processing` | Started; waiting for the customer or the provider | no |
| `completed` | The money moved | yes (but see `late`) |
| `failed` | It did not happen; `failure` says why, in words a customer can read | no: it can still complete **late** |
| `expired` | Collections: the window passed unpaid | no: a late payment is honoured |
| `unknown` | Disbursements: outcome unknown, a person decides | no |

**Late completions.** A provider can report a payment after we called it failed or expired (a slow request, a customer who pays after the window). Money is the provider's truth, so it becomes `completed` and you get `payment.completed` with `"late": true` and `"previousStatus": "failed"`. If you already told the customer it failed, or refunded them, you must act on this.

## Webhooks

Set a URL with the operator. Events:

| Type | When |
|---|---|
| `payment.completed` | the money moved (`late` is true if it had been reported failed or expired) |
| `payment.failed` | it did not happen |
| `payment.expired` | a collection's window ended unpaid |
| `payment.unknown` | a disbursement's outcome is unknown: do nothing, wait |
| `payment.mismatch` | PI-SPI: a payment arrived for the wrong amount or by the wrong route; nothing was settled, an operator looks |
| `payment.refunded` | PI-SPI: an operator sent the money back to the payer and it is irrevocable; `data.refund.status` is `refunded` |
| `ping` | `POST /v1/webhooks/test` |

```json
{ "id": "evt_pg8a5e…_1", "type": "payment.completed", "createdAt": 1791982830000, "previousStatus": "processing", "late": false, "data": { …the payment… } }
```

- **At least once.** Dedupe on `id` (also in the `Paygate-Event-Id` header). Order is not guaranteed across payments; `data.status` is always the state at the time of the event, so when in doubt `GET` the payment.
- **Acknowledge with any 2xx.** Anything else is retried after 10 s, 1 min, 5 min, 30 min, 2 h, 6 h, 24 h; then the event is dead and an operator is alerted (they can requeue it).
- **Verify the signature.** Header `Paygate-Signature: t=<unix seconds>,v1=<hex>`, the HMAC-SHA256 of `<t>.<raw body>` with your webhook secret. Check it on the **raw** body, reject if `t` is more than 5 minutes old, compare in constant time. [`src/signing.ts`](../src/signing.ts) does it (copy it).
- Redirects are not followed.

## Other endpoints

- `GET /v1/methods?rail=mobile_money&operator=orange&phone=+225…&direction=collect|disburse&amount=` — whether that way of paying works for that number, with limits and instructions. Ask before you show a customer an option. `?rail=pispi_qr` / `pispi_rtp` say if PI-SPI is on (and whether a person must confirm QR payments).
- `GET /v1/float` — the shared payout wallet per country: balance, the floor, what is committed, last-24 h flows, cover in days. It is the whole gateway's, not yours alone. Payouts you hold back on your side (waiting for your own approval) are not in it: add them.
- `GET /v1/me` — your account, limits, whether the gateway is live, and `wallets`: every account money can go through (`CIV:PAWAPAY`, `SEN:PAWAPAY`, `BFA:PAWAPAY`, `CIV:PISPI`, …), with whether you may `collect` and `payout` through each.

## Wallets

Every payment goes through one wallet: a mobile money payment through the pawaPay wallet of the phone's country (`SEN:PAWAPAY` for a +221 number), a PI-SPI payment through the PI-SPI account (`CIV:PISPI`). Your account may use only the wallets the operator enabled for it, per direction. Anything else is refused with `422 wallet_not_enabled` (with `wallet`) before anything is recorded or sent; `GET /v1/methods` answers `available: false` with the reason first. A repeat of a payment you already made (same reference) still answers, whatever has changed since.

## PI-SPI notes

- `pispi_qr`: the gateway returns `qr` (`alias`, `countryCode`, `qrType: "DYNAMIC"`, `referenceLabel`, `amount`). Render it as a PI-SPI dynamic QR; the `referenceLabel` is what ties the bank payment to this payment.
- Settlement is by PI-SPI's own record of received payments, never the customer's word: irrevocable, on our alias, the right category, **exactly** the amount. Otherwise `payment.mismatch`. One bank payment settles one payment only.
- With polling off (`PISPI_POLL`), nothing settles automatically: an operator confirms with `POST /admin/payments/{id}/resolve`.
- `pispi_rtp` sends the customer a payment request. A customer is sent at most 3 per day.
- **Which country.** A PI-SPI account collects in one country. Send `country` (`CIV`, `SEN`, `BFA`, or `CI`, `SN`, `BF`) to pick the account. Leave it out while your account has PI-SPI in one country only. With two or more, a request without it gets `400 country_required` (with `countries`). The QR's `alias` and `countryCode` are that account's. `GET /v1/methods?rail=pispi_qr&country=SEN` says whether it is available, and which `wallet` it uses. `country` is part of the request for idempotency when you send it.
- **Refunds.** An operator can send a received PI-SPI payment back to its payer, in full (PI-SPI returns the whole amount; there is no partial refund). Ask the operator; products cannot start one. While it is on its way the payment's `refund` is `{ "status": "pending", "requestedAt": … }`; once it is irrevocable it is `"refunded"` with `refundedAt`, and you get `payment.refunded`. If PI-SPI rejects it, `refund.status` is `"failed"` and the operator decides what next. The payment's own `status` stays `completed`: the money did arrive. A refund of a mismatched payment (wrong amount) shows the same way on that payment.

## Operator API (`Authorization: Bearer <ADMIN_API_KEY or an operator's Clerk session token>`)

A Clerk session that is valid but not in `CLERK_OPERATOR_IDS` gets `403 not_operator` with its `userId`.

| | |
|---|---|
| `POST /admin/tenants` | `{ id, name, webhookUrl?, maxAmount?, idNamespace?, logo? }`. `logo` is the product's logo for the console: a PNG, JPEG or WebP `data:` URL of at most 48 KB (never SVG); `null` removes it |
| `PATCH /admin/tenants/{id}` | `{ webhookUrl?, maxAmount?, status?, name?, logo? }` (`status`: `active` / `suspended`) |
| `POST /admin/tenants/{id}/keys` | `{ label? }` → `{ id, key }`, shown once |
| `DELETE /admin/tenants/{id}/keys/{keyId}` | revoke |
| `GET /admin/tenants/{id}/webhook-secret` | the secret your product verifies with; `POST` rotates it |
| `GET /admin/payments?status=&tenant=&kind=&limit=&before=` | with the detail tenants never see (`walletId` among it); newest first, `limit` 1–100 (default 50). Returns `{ data, total, next }`: pass `next` as `before` for the next page |
| `GET /admin/ledger` | the books: per wallet (`pool` is the wallet id: `CIV:PAWAPAY`, `SEN:PAWAPAY`, `BFA:PAWAPAY`, `CIV:PISPI`, …) each tenant's `available` and `held`, `unallocated`, `total`, the provider `wallet`, `difference` (wallet − total), and `formance` (its total, when set up); plus the `outbox` (`pending`, `stuck`) |
| `POST /admin/ledger/backfill` | books every payment's missing postings (idempotent) → `{ payments, added }` |
| `POST /admin/ledger/retry` | gives postings stuck on their way to Formance (10 failed tries) their tries back → `{ reset }` |
| `POST /admin/ledger/adjustments` | `{ pool, amount, note }` (`pool` a wallet id, e.g. `CIV:PAWAPAY`): money owned by no product, positive for float put in, negative for fees or losses taken out |
| `GET /admin/payments/stats?tenant=&kind=` | the payments page's headline: `completed` `{ n, amount }`, `settled` and `successRate` for the last 24 h; `processing` and `unknown` `{ n, amount }` for everything still open, whatever its age |
| `GET /admin/payments/{id}` | with its full history |
| `POST /admin/payments/{id}/resolve` | `{ outcome: "completed" \| "failed", note }` for an `unknown` payout or a manually confirmed PI-SPI payment |
| `POST /admin/payments/{id}/return` | `{ reason }`: sends a received PI-SPI payment back to its payer, in full (a completed one, or one that arrived for the wrong amount). `GET /admin/payments/{id}` says whether it can (`returnable`) and how it stands (`returnStatus`: `requested`, `initiated`, `returned`, `rejected`). Needs `PISPI_RETURNS`. |
| `GET /admin/wallets` | the wallets registry: each wallet (`id` `<country>:<rail>`, `rail`, `country`, `label`, `status` `active`/`off`, `secrets_prefix`) with the `tenants` that may use it and how (`collect`, `payout`) |
| `POST /admin/wallets` | `{ id, label?, secretsPrefix? }`: registers a wallet, e.g. `SEN:PISPI` for a second PI-SPI account. It starts enabled for no product; products created later get it |
| `PATCH /admin/wallets/{id}` | `{ status?, label? }`. `off`: no product can start a payment through it; payments already on their way still settle |
| `GET /admin/tenants/{id}/wallets` | every wallet with whether this product may `collect` and `payout` through it |
| `PUT /admin/tenants/{id}/wallets/{walletId}` | `{ collect, payout }`, both required. A new product starts with every active wallet, both ways |
| `GET /admin/webhooks/dead`, `POST /admin/webhooks/{id}/retry` | undeliverable events |
| `GET /admin/float`, `GET /admin/provider-events` | wallets; the last 100 provider callbacks as received |
| `GET /admin/events?source=&problems=1&tenant=&payment=&before=&limit=` | one feed, newest first: payment status changes (`payment`), provider callbacks (`callback`), webhooks to tenants (`webhook`). `source` is a comma-separated list; `problems=1` keeps what needs a person (failed, unknown, mismatch, late payments; rejected callbacks; dead webhooks); pass the response's `next` as `before` for the next page |
| `GET /admin/providers` | every PSP: `channels` (each operator per country, `collect`/`payout` as `{ status, min, max }` or null when not on the account; null with `channelsError` when the configuration cannot be read), `accounts` (pawaPay payout wallets per country with balance, status and cover; PI-SPI's receiving alias, masked) and `accountsNote`, plus `last24h` totals |
| `GET /admin/attention` | `{ unknown, deadWebhooks, rejectedCallbacks24h }` |

## Provider callbacks (not for products)

`POST /callbacks/pawapay/deposits` and `/callbacks/pawapay/payouts`: set these in the pawaPay dashboard, with **signed callbacks on**.
