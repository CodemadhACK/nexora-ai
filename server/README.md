# Nexora platform backend

The source of truth for identity, plans, credits, entitlements, AI routing and
payments. The browser holds no provider keys, no prices and no entitlements it
can act on — it asks this service, and this service decides.

```bash
npm install
cp .env.example .env       # then set APP_ENCRYPTION_KEY
npm run seed               # plans, models, routing, prompts, first admin
npm start                  # http://localhost:4000
npm test                   # 47 tests, node:test, no runner to install
```

## Required configuration

`APP_ENCRYPTION_KEY` is mandatory and the process refuses to boot without it:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

It encrypts every stored provider API key with AES-256-GCM. **Losing it makes
every stored key undecryptable** — back it up with your other secrets.

## Architecture

```
browser ──> /api/* ──> route ──> service ──> node:sqlite
                                    │
                                    └──> aiRouter ──> providers/ ──> vendor API
```

`providers/` is the repo's existing Electron provider layer, reused rather than
reimplemented. It already speaks a neutral message shape, retries, and
normalises vendor errors, and it is covered by the root project's tests.

| Layer | Responsibility |
|---|---|
| `routes/` | HTTP shape, validation, authorisation. No business rules. |
| `services/` | Credits, entitlements, AI routing, Cashfree, auth. |
| `lib/` | Crypto, errors, audit, validators. No database access except audit. |
| `db/` | Schema, migration, seed. One connection, re-entrant transactions. |

## Things that are load-bearing

**Credits are a ledger.** `users.credit_balance` is a cache. There is no exported
function that writes it without an immutable `credit_transactions` row in the
same transaction. `record()` is the only writer.

**`transaction()` is re-entrant.** Activating a payment opens a transaction and
then calls the credit ledger, which opens one of its own. SQLite has no nested
`BEGIN`, so a depth counter joins the outer transaction instead. A nested failure
rolls the whole thing back — deliberately not `SAVEPOINT`, which would let an
inner failure be swallowed while the outer commits.

**Webhooks are idempotent twice over.** `webhook_events` has a UNIQUE constraint
on the dedupe key, and credit grants carry `idempotency_key = order:<id>`. Either
alone handles the common case; both together survive a webhook redelivered
concurrently with a return-url poll.

**A frontend redirect is never proof of payment.** Activation happens only after
a signature-verified webhook or a server-to-server order fetch returns `PAID`.

**Secrets are write-only.** Provider keys and gateway credentials go in
encrypted and come back masked (`••••••••••••A82K`). No role can read them back,
and the audit log records that a key rotated, never its value.

## Cashfree

Built against the current API, not from memory:

| What | Where |
|---|---|
| Create order | `POST {base}/pg/orders`, header `x-api-version: 2026-01-01` |
| Verify order | `GET {base}/pg/orders/{order_id}` |
| Payments | `GET {base}/pg/orders/{order_id}/payments` |
| Refund | `POST {base}/pg/orders/{order_id}/refunds` |
| Webhook signature | `base64(HMAC-SHA256(timestamp + rawBody, secret))` |
| Webhook headers | `x-webhook-signature`, `x-webhook-timestamp` |
| Events handled | `PAYMENT_SUCCESS_WEBHOOK`, `PAYMENT_FAILED_WEBHOOK`, `PAYMENT_USER_DROPPED_WEBHOOK`, `REFUND_STATUS_WEBHOOK` |

Point your Cashfree dashboard at `POST /api/webhooks/cashfree`. That route is
mounted **before** the JSON body parser and reads the raw bytes — re-serialising
parsed JSON changes them and the signature would never verify.

Sandbox and production credentials must never be mixed; `CASHFREE_MODE` selects
the base URL and the admin console shows which is active.

## Two-factor authentication

TOTP (RFC 6238) implemented on node:crypto's HMAC, verified against the RFC's
own published test vectors in `test/features.test.js`. Three properties matter:

- **Enrolment is two-step.** `2fa/setup` stores an *unconfirmed* secret;
  `2fa/enable` needs a working code before anything gates a login. A secret that
  gated login before being proven would lock a user out on a mistyped QR scan.
- **Codes cannot be replayed.** The accepted time step is persisted, and anything
  at or below it is refused — including the code used to finish enrolment.
- **A challenge is not a session.** A correct password on a 2FA account returns a
  short-lived challenge token that grants nothing until a code is supplied.

Recovery codes are single-use and stored only as SHA-256 hashes.

## Email

`SMTP_HOST` selects nodemailer; without it a log transport prints each message,
so verification and reset links stay usable in development. Mail is queued to
`notifications` and drained by a background worker, so a request never blocks on
SMTP and a failure is visible in the admin console rather than lost.

Payment and security mail is transactional and deliberately not opt-out.

## Résumé parsing

| Format | How |
|---|---|
| PDF | delegated to the repo's own `resume-pdf.js` — it already strips page markers, collapses text-layer whitespace, and names the password-protected and scanned cases |
| DOCX | read directly: a .docx is a ZIP, and node:zlib supplies the only hard part |
| TXT / MD | as-is |

Uploads arrive as base64 in JSON rather than multipart — one endpoint, no
body-parser dependency, 8 MB cap applied to the decoded bytes.

## Google sign-in

Optional. Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and
`GOOGLE_REDIRECT_URI` (which must match the authorised redirect URI in the Google
console exactly). ID tokens are verified by `google-auth-library`, not by
hand-parsing a JWT.

Account linking is the delicate part. Signing in with Google on an email that
already has a password account links the identity **only if that email is
already verified**; otherwise it is refused with an explanation. Linking to an
unverified email in either direction is an account-takeover path.

## Roles

`SUPER_ADMIN` > `ADMIN` > `SUPPORT` > `USER`, checked by rank. `SUPPORT` can read
the admin console but every write demands `ADMIN`. Role changes, provider-secret
writes, refunds and account deletion additionally require re-authentication.

## Tests

`npm test` covers what a reviewer would otherwise have to take on trust:

- a forged webhook signature grants nothing, and is still logged
- a redelivered webhook does not double-grant credits or duplicate a subscription
- a client claiming `priceMinor: 100, credits: 1000000` gets the plan's real price
- credits cannot go negative, and every move leaves a ledger row
- an expired subscription stops granting access without a cron job
- a disabled feature flag overrides the plan
- a failed AI call charges the user nothing and does not leak the provider's error
- wrong-password and no-such-account are indistinguishable
- a suspended user's live session dies immediately
- a nested transaction joins the outer one instead of throwing
- TOTP matches all six RFC 6238 SHA-1 vectors, and a code cannot be replayed
- an unconfirmed 2FA secret does not gate login
- a recovery code works once and is then spent
- a .docx is unzipped correctly and an oversized upload is refused before parsing
- an opted-out marketing email is skipped while a security one still sends
