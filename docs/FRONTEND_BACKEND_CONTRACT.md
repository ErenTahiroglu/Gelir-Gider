# Frontend–Backend Contract

**Status:** Pre-frontend backend foundation established (Checkpoint 7B.0).
Financial HTTP product surface is IN PROGRESS (7B.1–7B.9).
This document reflects **only currently implemented truth** plus clearly-labelled planned work.

---

## 1. Locked Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  Cloudflare Worker  (gelir-gider-api, single origin)             │
│                                                                  │
│   ┌───────────────────────────────────────────────────────────┐  │
│   │  Hono application                                         │  │
│   │  GET  /health, /ready                                     │  │
│   │  /auth/*   (WebAuthn/Passkey, session, bootstrap)         │  │
│   │  /budget-v2/*  (checkpoint timeline, decision center,     │  │
│   │                 recommendation feedback)                  │  │
│   │  [future] /transactions/*, /income/*, …  (7B.1–7B.9)     │  │
│   │  [future] static frontend assets served on same origin   │  │
│   └───────────────────────────────────────────────────────────┘  │
│                                │                                 │
│              ┌─────────────────┼─────────────────┐              │
│              ▼                 ▼                 ▼              │
│       Neon PostgreSQL    Cloudflare R2     Cloudflare            │
│       (DATABASE_URL)     (BACKUP_BUCKET)   Rate Limiter          │
│                                            (AUTH_RATE_LIMITER)   │
│                                            Cron triggers          │
│                                            (0 * * * * ; 17 2 * * *)│
└──────────────────────────────────────────────────────────────────┘
```

**Invariants that must never be broken:**

- There is exactly **one** Cloudflare Worker. There is no separate API origin.
- The future web frontend will be served as static assets on that **same** Worker/origin.
- There is no Vercel, Render, or any other adapter origin.
- There is no permissive CORS (`Access-Control-Allow-Origin: *`).
- The Worker is deployed via `wrangler deploy` from the monorepo root.
- Database: Neon PostgreSQL over `DATABASE_URL` (hyperdrive or direct connection string).
- Encrypted backups: Cloudflare R2 (`BACKUP_BUCKET` binding), AES-256-GCM.
- Cron schedules: hourly (`0 * * * *`) for notification scheduler + budget checkpoint
  processor; daily at 02:17 UTC (`17 2 * * *`) for encrypted database backup.

---

## 2. Session and Authentication Model

### Cookie

The session token is issued as an `__Host-` prefixed cookie:

```
Set-Cookie: __Host-gg_session=<base64url-token>;
            Path=/;
            Secure;
            HttpOnly;
            SameSite=Strict;
            Max-Age=2592000
```

**All of these attributes are mandatory and immutable:**

| Attribute | Value | Reason |
|-----------|-------|--------|
| `__Host-` prefix | required | Locks the cookie to the exact origin; rejects any `Domain` attribute |
| `Path=/` | required | Must accompany `__Host-` |
| `Secure` | required | HTTPS only; must accompany `__Host-` |
| `HttpOnly` | required | Not accessible to JavaScript |
| `SameSite=Strict` | required | Defence-in-depth against cross-site sends |
| No `Domain` attribute | required | `__Host-` enforces this; never add one |
| `Max-Age=2592000` | 30 days | Absolute session TTL |

On logout, the server clears the cookie with `Max-Age=0` and the same security flags.

### Authentication Method

- **WebAuthn / Passkey** (FIDO2) — no passwords.
- `WEBAUTHN_RP_ID`, `WEBAUTHN_RP_NAME`, `WEBAUTHN_ORIGIN` configured per deployment.
- Bootstrap: one-time operator token (`BOOTSTRAP_TOKEN_HASH`) seeds the first user.
- Recovery: time-limited recovery codes for emergency account access.

### Frontend Responsibility

- The frontend must **never** read or copy the session cookie value (it is `HttpOnly`).
- The frontend must send cookies on every API request (standard browser behavior with
  same-origin requests — no `credentials: "include"` is needed; same-origin is default).
- The frontend must **never** manufacture or forge the session cookie.

---

## 3. Same-Origin Mutation / CSRF Rule

> **Every POST, PUT, PATCH, or DELETE request must include an `Origin` header
> whose value exactly equals the application origin (`WEBAUTHN_ORIGIN`).**

This applies to **all** product routes including the existing `/auth/*` and `/budget-v2/*`
families and every future domain router.

**Details:**

- Enforced server-side by `sameOriginMutationGuard()` (`src/http/transport.ts`) on all
  `budgetV2Router` routes, and by an equivalent inline guard on all `/auth` POST routes.
- Safe methods (`GET`, `HEAD`, `OPTIONS`) are not checked.
- A request missing `Origin` or carrying a different `Origin` receives `403 INVALID_ORIGIN`
  before any auth check, rate limit, or body parsing.
- This is **not** a CORS mechanism. No `Access-Control-*` headers are added.
- The application origin is read from config (`WEBAUTHN_ORIGIN`), never hard-coded, so
  local development against `http://localhost:8787` works without any special handling.

**In-browser same-origin requests carry `Origin` automatically.** The guard is
defence-in-depth; it does not require the frontend to do anything special beyond being
served on the same origin.

---

## 4. Implemented Route Families

All routes respond with `Content-Type: application/json`.

### 4.1 Readiness Probes

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/health` | None | Returns `{"status":"ok","service":"gelir-gider-api"}` |
| `GET` | `/ready` | None | Executes `SELECT 1`; returns `{"status":"ready"}` or `{"status":"not_ready"}` + 503 |

These routes are intentionally public (no session required).

### 4.2 Authentication (`/auth/*`)

All POST routes on `/auth/*` require `Origin: <WEBAUTHN_ORIGIN>`, `Content-Type: application/json`,
and pass through the rate limiter for pre-auth paths.
All routes set `Cache-Control: no-store`.

| Method | Path | Auth Required | Description |
|--------|------|---------------|-------------|
| `POST` | `/auth/bootstrap/authorize` | Bootstrap token | One-time operator bootstrap: issues enrollment grant |
| `POST` | `/auth/recovery/authorize` | Recovery code | Emergency access: issues enrollment grant from recovery code |
| `POST` | `/auth/passkey/enrollment/options` | Enrollment grant | Returns WebAuthn registration options |
| `POST` | `/auth/passkey/enrollment/verify` | Enrollment grant | Completes passkey registration, creates session |
| `POST` | `/auth/passkey/authentication/options` | None (public) | Returns WebAuthn authentication options for a username |
| `POST` | `/auth/passkey/authentication/verify` | None (public) | Verifies passkey assertion, creates session |
| `GET` | `/auth/status` | None (public) | Returns bootstrapped status: `{"bootstrapped":bool}` |
| `GET` | `/auth/session` | Session cookie | Returns session info: `{"userId":"<uuid>","expiresAt":"<ISO>"}` |
| `POST` | `/auth/logout` | Session cookie | Revokes session, clears cookie; returns `{"ok":true}` |

### 4.3 Budget V2 (`/budget-v2/*`)

All routes require:
- `Origin: <WEBAUTHN_ORIGIN>` on mutating methods (POST)
- A valid session cookie (`__Host-gg_session`)
- User identity is derived **only** from the session — never from a body field, query param,
  path segment, or custom header

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/budget-v2/checkpoints` | Returns the authenticated user's checkpoint timeline |
| `GET` | `/budget-v2/checkpoints/:paymentEventId/decision-center` | Returns the Decision Center view for a checkpoint |
| `POST` | `/budget-v2/checkpoints/:paymentEventId/recommendations/:recommendationId/feedback` | Creates recommendation feedback (first revision) |
| `POST` | `/budget-v2/recommendations/:recommendationId/feedback/revisions` | Appends a new revision to existing recommendation feedback |

### 4.4 Transactions (`/transactions/*`)

All routes require:
- Session authentication (`__Host-gg_session` cookie)
- `Origin: <WEBAUTHN_ORIGIN>` on mutating methods (`POST`)
- User identity derived **strictly** from session (`c.get("auth").userId`)
- Mutating endpoints accept only direct/manual transaction kinds from the allowlist (`EXPENSE`, `INCOME`, `TRANSFER`, `MANUAL_EXPENSE`, `MANUAL_INCOME`, `MANUAL_TRANSFER`). Domain-owned kinds (such as credit card, income receipt, goal, campaign, midas, month-close) are rejected at the HTTP boundary (`400 TRANSACTION_INVALID_INPUT`).

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/transactions` | Keyset-paginated list of current effective transactions (`limit`, `status`, `kind`, `beforeOccurredAt`, `beforeTransactionId`) |
| `GET` | `/transactions/:transactionId` | Single canonical transaction current effective state |
| `GET` | `/transactions/:transactionId/revisions` | Keyset-paginated revision audit history (`limit`, `beforeRevisionNo`) |
| `POST` | `/transactions` | Creates a manual canonical transaction with atomic ledger posting |
| `POST` | `/transactions/:transactionId/revisions` | Appends a revision with atomic journal correction / replacement |
| `POST` | `/transactions/:transactionId/void` | Voids a transaction with atomic journal reversal |

### 4.5 Ledger (`/ledger/*`)

All routes are **READ-ONLY**. Raw journal write endpoints (`/ledger/entries`, `/ledger/post`, `/ledger/journal`, `/ledger/reverse`) are **not exposed** and do not exist on the HTTP surface.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/ledger/accounts` | List of ledger account balances (`includeArchived`, `asOf`) |
| `GET` | `/ledger/accounts/:accountId/balance` | Single ledger account balance (`asOf`) |

---

## 5. Budget V2 Request/Response Conventions

### 5.1 GET /budget-v2/checkpoints

**Query parameters:**

| Parameter | Type | Default | Max | Description |
|-----------|------|---------|-----|-------------|
| `limit` | integer string | 50 | 100 | Number of checkpoints to return. Absent = domain default (50). |

**Response shape** (status `200`):

```json
{
  "apiVersion": "budget-v2-v1",
  "limit": 50,
  "sharedMaxCheckpointAt": false,
  "checkpoints": [
    {
      "checkpointAt": "2026-09-10T00:00:00.000Z",
      "paymentEventId": "22222222-2222-4222-8222-222222222222",
      "...": "..."
    }
  ]
}
```

**`sharedMaxCheckpointAt` semantics:**
`true` when two or more of the authenticated user's **persisted** checkpoints share the same
maximum `checkpointAt` instant, computed over the **full** persisted history regardless of
the `limit` parameter. The frontend must not silently designate a single row as uniquely
"latest" when this is `true`.

### 5.2 POST feedback body

**Request headers required:**

```
Content-Type: application/json
Origin: <WEBAUTHN_ORIGIN>
Idempotency-Key: <1–128 character string, no leading/trailing whitespace>
Cookie: __Host-gg_session=<token>
```

**Create feedback body** (all keys required unless noted):

```json
{
  "expectedRecommendationFingerprint": "<64 lowercase hex chars>",
  "decision": "ACCEPT | MODIFY | IGNORE",
  "occurredAt": "2026-09-10T12:34:56.789Z",
  "modification": null | { "...": "..." }
}
```

**Update feedback (revision) body:**

```json
{
  "expectedRevisionNo": 1,
  "decision": "ACCEPT | MODIFY | IGNORE",
  "occurredAt": "2026-09-10T12:34:56.789Z",
  "modification": null | { "...": "..." }
}
```

**Closed body rule:** Extra keys in any POST body are rejected with `400 BUDGET_INVALID_INPUT`.
The frontend must send **only** the documented keys.

### 5.3 `occurredAt` — Canonical UTC Instant

All timestamps exchanged between frontend and backend must use the exact format:

```
YYYY-MM-DDTHH:mm:ss.sssZ
```

- Millisecond precision is **mandatory** (`.sssZ` suffix).
- The `Z` timezone designator is **mandatory**. No offsets (`+03:00`) accepted.
- The separator between date and time must be `T` (not a space).
- The value must round-trip through `new Date(value).toISOString() === value`.
- The frontend must supply the `occurredAt` from its own clock; the backend never
  substitutes the server clock for a client-supplied timestamp.

### 5.4 Checkpoint Semantics

Checkpoint read models may carry one of these temporal markers:

| Value | Meaning |
|-------|---------|
| `FROZEN_AT_CHECKPOINT` | Data reflects the state at the time the checkpoint was taken; does not change after persistence |
| `AS_OF_CHECKPOINT` | Computed from data as of the checkpoint instant; stable |
| `CURRENT` | Live data that may differ from the checkpoint |

The frontend must use `checkpointAt` for display and sorting, never assume ordering from
array position alone.

### 5.5 Error Envelope

All error responses (4xx and 5xx) use this envelope:

```json
{
  "error": {
    "code": "BUDGET_INVALID_INPUT",
    "message": "Invalid request"
  }
}
```

**Stable error codes (may be depended on by the frontend):**

| Code | Status | Description |
|------|--------|-------------|
| `BUDGET_INVALID_INPUT` | 400 | Malformed request: missing field, wrong type, extra key, or format violation |
| `BUDGET_CHECKPOINT_NOT_FOUND` | 404 | Referenced checkpoint does not exist or is not owned by this user |
| `BUDGET_RECOMMENDATION_NOT_FOUND` | 404 | Referenced recommendation does not exist |
| `BUDGET_RECOMMENDATION_NOT_ACTIVE` | 409 | Recommendation is no longer active |
| `BUDGET_RECOMMENDATION_STALE` | 409 | `expectedRecommendationFingerprint` does not match current state |
| `BUDGET_IDEMPOTENCY_CONFLICT` | 409 | `Idempotency-Key` was already used with a different request body |
| `BUDGET_REVISION_CONFLICT` | 409 | `expectedRevisionNo` does not match current revision |
| `INVALID_ORIGIN` | 403 | Missing or wrong `Origin` header on a mutating request |
| `UNAUTHENTICATED` | 401 | No valid session cookie |
| `NOT_FOUND` | 404 | Route does not exist |
| `INTERNAL_ERROR` | 500 | Unexpected server error |

### 5.6 Transactions & Ledger Request/Response Conventions

#### 5.6.1 GET /transactions

**Query parameters:**
- `limit`: integer string, 1–100 (default: 50)
- `status`: optional string, `ACTIVE` | `VOIDED`
- `kind`: optional canonical kind format (`/^[A-Z][A-Z0-9_]{0,63}$/`)
- `beforeOccurredAt`: optional canonical UTC instant string (`YYYY-MM-DDTHH:mm:ss.sssZ`)
- `beforeTransactionId`: optional UUID string (must be supplied if `beforeOccurredAt` is supplied, and vice versa)

**Response shape** (`200 OK`):
```json
{
  "transactions": [
    {
      "transactionId": "uuid",
      "kind": "MANUAL_EXPENSE",
      "status": "ACTIVE",
      "revisionNo": 1,
      "occurredAt": "2026-09-10T12:00:00.000Z",
      "payload": { "merchant": "Market" },
      "createdAt": "2026-09-10T12:00:00.000Z",
      "latestRevisionCreatedAt": "2026-09-10T12:00:00.000Z"
    }
  ],
  "nextCursor": {
    "beforeOccurredAt": "2026-09-10T12:00:00.000Z",
    "beforeTransactionId": "uuid"
  }
}
```
*Note: `nextCursor` is `null` when no further page exists. Sorting is `occurredAt DESC, transactionId DESC`.*

#### 5.6.2 GET /transactions/:transactionId
Returns `200 OK` with the single current effective transaction object, or `404 TRANSACTION_NOT_FOUND` if not found / owned by another user.

#### 5.6.3 GET /transactions/:transactionId/revisions
- `limit`: integer string, 1–100 (default: 50)
- `beforeRevisionNo`: optional integer `>= 1`
Returns `200 OK` with `{ "transactionId": "uuid", "revisions": [...], "nextCursor": { "beforeRevisionNo": number } | null }`.

#### 5.6.4 POST /transactions
- Headers: `Origin: <WEBAUTHN_ORIGIN>`, `Idempotency-Key: <key>`, `Cookie: __Host-gg_session=...`
- Closed Body:
```json
{
  "kind": "EXPENSE | INCOME | TRANSFER | MANUAL_EXPENSE | MANUAL_INCOME | MANUAL_TRANSFER",
  "occurredAt": "2026-09-10T12:00:00.000Z",
  "payload": { "key": "value" },
  "ledger": {
    "memo": "Optional memo",
    "lines": [
      { "accountId": "uuid", "side": "DEBIT", "amount": "150.75", "memo": "Line memo" },
      { "accountId": "uuid", "side": "CREDIT", "amount": "150.75" }
    ]
  }
}
```
- Response (`200 OK`): `{ "transactionId": "uuid", "revisionNo": 1, "operation": "CREATE", "idempotentReplay": boolean }`

#### 5.6.5 POST /transactions/:transactionId/revisions
- Headers: `Origin: <WEBAUTHN_ORIGIN>`, `Idempotency-Key: <key>`, `Cookie: __Host-gg_session=...`
- Closed Body:
```json
{
  "expectedRevisionNo": 1,
  "occurredAt": "2026-09-10T12:00:00.000Z",
  "payload": { "key": "value" },
  "reasonNote": "Optional note",
  "ledger": {
    "memo": "Updated memo",
    "lines": [
      { "accountId": "uuid", "side": "DEBIT", "amount": "200.00" },
      { "accountId": "uuid", "side": "CREDIT", "amount": "200.00" }
    ]
  }
}
```
- Response (`200 OK`): `{ "transactionId": "uuid", "revisionNo": 2, "operation": "UPDATE", "idempotentReplay": boolean }`

#### 5.6.6 POST /transactions/:transactionId/void
- Headers: `Origin: <WEBAUTHN_ORIGIN>`, `Idempotency-Key: <key>`, `Cookie: __Host-gg_session=...`
- Closed Body:
```json
{
  "expectedRevisionNo": 2,
  "reasonNote": "Optional note"
}
```
- Response (`200 OK`): `{ "transactionId": "uuid", "revisionNo": 3, "operation": "VOID", "idempotentReplay": boolean }`

#### 5.6.7 GET /ledger/accounts
- Query parameters: `includeArchived` (strict boolean `"true"` | `"false"`), `asOf` (optional UTC ISO instant)
- Response (`200 OK`): `{ "accounts": [ { "id": "uuid", "code": "...", "name": "...", "accountType": "...", "normalBalance": "DEBIT|CREDIT", "currency": "TRY", "balance": "150.75", "isArchived": false, ... } ] }`

#### 5.6.8 GET /ledger/accounts/:accountId/balance
- Query parameters: `asOf` (optional UTC ISO instant)
- Response (`200 OK`): `{ "accountId": "uuid", "currency": "TRY", "normalBalance": "DEBIT|CREDIT", "balance": "150.75", "asOf": "2026-09-10T12:00:00.000Z" }`

**Transaction & Ledger Error Codes:**
| Code | Status | Description |
|------|--------|-------------|
| `TRANSACTION_INVALID_INPUT` | 400 | Malformed body, disallowed transaction kind, numeric money, or invalid parameter |
| `TRANSACTION_NOT_FOUND` | 404 | Transaction not found or not owned by authenticated user |
| `TRANSACTION_IDEMPOTENCY_CONFLICT` | 409 | Idempotency-Key re-used with different payload |
| `TRANSACTION_REVISION_CONFLICT` | 409 | OCC mismatch on `expectedRevisionNo` |
| `TRANSACTION_ALREADY_VOIDED` | 409 | Transaction is already voided |
| `LEDGER_INVALID_INPUT` | 400 | Malformed ledger query or line parameters |
| `LEDGER_ACCOUNT_NOT_FOUND` | 404 | Ledger account not found or not owned by user |
| `LEDGER_UNBALANCED` | 400 | Debit and Credit amounts do not balance |
| `LEDGER_IDEMPOTENCY_CONFLICT` | 409 | Duplicate journal idempotency key |
| `LEDGER_CURRENCY_MISMATCH` | 400 | Multi-currency lines in single entry |

---

## 6. Exact-Money Rule

> **All monetary amounts are transmitted as decimal strings. The frontend must
> never convert money to or from JavaScript `number` (IEEE 754 float).**

**Encoding:**

- Amounts are transmitted as JSON strings, e.g. `"1234.56"` or `"-50.00"`.
- The string always has exactly two decimal places for Turkish Lira amounts.
- No scientific notation, no trailing zeros beyond two decimal places, no currency symbol.
- Server-side storage is integer cents (bigint); the API layer converts to/from decimal
  string at the boundary.

**Frontend obligations:**

- Parse money strings using a decimal library (e.g. `Decimal.js`, `big.js`) — never `parseFloat`.
- Display using locale-aware formatting from the decimal representation, not from a float.
- Never submit a money amount as a JSON number — always as a string.

---

## 7. Future Financial Route Inventory

> **⚠️ PLANNED — NOT YET IMPLEMENTED**
>
> The route families below do not exist in the current codebase. They must not be called by
> the frontend until the corresponding checkpoint (7B.x) is complete and merged.
> Route paths, request shapes, and response shapes may change before implementation.

The underlying domain **service** code exists for all of these domains. What is missing is
the HTTP adapter layer (route handlers, input validation, error mapping).

### 7B.2 — Income

```
PLANNED  GET   /income/sources/:id
PLANNED  GET   /income/sources              ?limit=&after=
PLANNED  POST  /income/sources              (create)
PLANNED  POST  /income/sources/:id/archive  (archive)

PLANNED  GET   /income/entitlements/:id
PLANNED  GET   /income/entitlements         ?sourceId=&limit=&after=
PLANNED  POST  /income/entitlements         (create)
PLANNED  POST  /income/entitlements/:id/revise  (revise)
PLANNED  POST  /income/entitlements/:id/void    (void)

PLANNED  GET   /income/receipts/:id
PLANNED  GET   /income/receipts             ?limit=&after=
PLANNED  POST  /income/receipts             (create)
PLANNED  POST  /income/receipts/:id/revise  (revise)
PLANNED  POST  /income/receipts/:id/void    (void)

PLANNED  GET   /income/reference            ?month=YYYY-MM
PLANNED  POST  /income/settlements          (create or revise)
```

### 7B.3 — Credit Cards

```
PLANNED  GET   /credit-cards/:id
PLANNED  GET   /credit-cards                ?status=&limit=&after=
PLANNED  POST  /credit-cards                (create)
PLANNED  POST  /credit-cards/:id            (update)
PLANNED  POST  /credit-cards/:id/archive    (archive)

PLANNED  GET   /credit-cards/:cardId/statements/:id
PLANNED  GET   /credit-cards/:cardId/statements  ?status=&cycleMonth=&limit=&after=
PLANNED  POST  /credit-cards/:cardId/statements  (create)
PLANNED  POST  /credit-cards/:cardId/statements/:id  (update)
PLANNED  POST  /credit-cards/:cardId/statements/:id/void  (void)
PLANNED  POST  /credit-cards/:cardId/statements/:id/pay   (pay)
PLANNED  POST  /credit-cards/:cardId/statements/:id/reopen  (reopen payment)
PLANNED  POST  /credit-cards/:cardId/statements/:id/reconcile  (reconcile)
```

### 7B.4 — People + Family

```
PLANNED  GET   /people/:id
PLANNED  GET   /people                      ?limit=&after=
PLANNED  POST  /people                      (create)
PLANNED  POST  /people/:id                  (update)
PLANNED  POST  /people/:id/archive          (archive)

PLANNED  GET   /people/:personId/obligations/:id
PLANNED  GET   /people/:personId/obligations  ?type=&limit=&after=
PLANNED  POST  /people/:personId/receivables    (record receivable)
PLANNED  POST  /people/:personId/payables       (record payable expense)
PLANNED  POST  /people/:personId/obligations/:id  (update)
PLANNED  POST  /people/:personId/obligations/:id/void  (void)

PLANNED  GET   /people/:personId/settlements/:id
PLANNED  GET   /people/:personId/settlements  ?limit=&after=
PLANNED  POST  /people/:personId/receivable-settlements  (settle receivable)
PLANNED  POST  /people/:personId/payable-settlements     (settle payable)
PLANNED  POST  /people/:personId/settlements/:id/void    (void settlement)
```

### 7B.5 — Rewards

```
PLANNED  GET   /rewards/accounts/:id
PLANNED  GET   /rewards/accounts        ?status=&limit=&after=
PLANNED  POST  /rewards/accounts        (create)
PLANNED  POST  /rewards/accounts/:id/archive  (archive)
```

### 7B.6 — Campaigns

```
PLANNED  GET   /campaigns/:id
PLANNED  GET   /campaigns               ?limit=&after=
PLANNED  POST  /campaigns               (create period)
PLANNED  POST  /campaigns/:id/amend     (amend period)

PLANNED  GET   /campaigns/:id/progress

PLANNED  GET   /campaigns/review-candidates/:id
PLANNED  GET   /campaigns/review-candidates    ?limit=&after=
PLANNED  POST  /campaigns/review-candidates    (create)
PLANNED  POST  /campaigns/review-candidates/:id/apply    (apply)
PLANNED  POST  /campaigns/review-candidates/:id/dismiss  (dismiss)
```

### 7B.7 — Short-Term Goals + Midas + Long-Term Investment

```
PLANNED  GET   /short-term-goals/:id
PLANNED  GET   /short-term-goals        ?limit=&after=
PLANNED  POST  /short-term-goals        (create)
PLANNED  POST  /short-term-goals/:id    (update)
PLANNED  POST  /short-term-goals/:id/complete  (complete)
PLANNED  POST  /short-term-goals/:id/cancel    (cancel)
PLANNED  POST  /short-term-goals/reorder       (reorder)
PLANNED  POST  /short-term-goals/:id/fund      (fund)
PLANNED  POST  /short-term-goals/:id/release   (release funding)

PLANNED  GET   /midas/liquidity
PLANNED  GET   /midas/transfers         ?limit=&after=
PLANNED  POST  /midas/transfers         (allocate transfer)
PLANNED  POST  /midas/transfers/:id/reverse  (reverse transfer)

PLANNED  GET   /long-term/tasks/:id
PLANNED  GET   /long-term/tasks         ?status=&limit=&after=
PLANNED  POST  /long-term/tasks         (allocate investment)
PLANNED  POST  /long-term/tasks/:id/mark-sent   (mark sent)
PLANNED  POST  /long-term/tasks/:id/reopen      (reopen)
PLANNED  POST  /long-term/tasks/:id/cancel      (cancel)
```

### 7B.8 — Month-Close

```
PLANNED  GET   /month-close/:id
PLANNED  GET   /month-close             ?limit=&after=
PLANNED  POST  /month-close             (close month)
```

### 7B.9 — Notifications + Imports

```
PLANNED  GET   /notifications/subscriptions/:id
PLANNED  GET   /notifications/subscriptions  ?status=&limit=&after=
PLANNED  POST  /notifications/subscriptions  (register push subscription)
PLANNED  POST  /notifications/subscriptions/:id/disable  (disable)

PLANNED  GET   /notifications/events/:id
PLANNED  GET   /notifications/events    ?date=YYYY-MM-DD&limit=&after=

PLANNED  GET   /imports/batches/:id
PLANNED  GET   /imports/batches         ?limit=&after=
PLANNED  POST  /imports/batches         (stage batch)
PLANNED  GET   /imports/batches/:id/preview
PLANNED  POST  /imports/batches/:batchId/rows/:rowId/resolve  (resolve row)
PLANNED  POST  /imports/batches/:id/apply  (apply ready rows)

PLANNED  GET   /imports/rows/:id
PLANNED  GET   /imports/rows            ?batchId=&status=&limit=&after=
```

---

## 8. System/Operator-Only Operations

The following capabilities exist in the codebase but are **deliberately not exposed as
product HTTP routes**. They must never be callable by the frontend or treated as product API.

| Capability | Why not exposed |
|-----------|----------------|
| Raw ledger posting (`postJournalEntry`) | Internal infrastructure; financial integrity requires domain-level orchestration |
| Database migrations (`applyMigrations`) | Operator-only; run via Drizzle CLI at deploy time |
| Encrypted backup / restore (`runDatabaseBackup`, restore) | Operator-only; triggered by Cloudflare cron or manual operator command |
| Cron handler execution (notification scheduler, checkpoint processor, backup) | System-internal; invoked by Cloudflare scheduler, not HTTP |
| Notification scheduler invocation (`runNotificationScheduler`) | System-internal |
| Budget checkpoint processing (`processPendingBudgetV2CheckpointRequests`) | System-internal; triggered hourly by cron |
| Checkpoint report construction / forging | Internal to the checkpoint processor; never a direct HTTP action |
| Arbitrary recommendation execution | Recommendation outcomes are derived by the domain; no "force execute" endpoint |
| Ledger account creation / archival (`createLedgerAccount`, `archiveLedgerAccount`) | Infrastructure; provisioned inside domain service transactions, not directly |
| Merchant alias resolution (`resolveCanonicalMerchantName`) | Internal; resolved by campaign domain during purchase processing |

---

## 9. Proposed 7B.1–7B.9 Implementation Sequence

This sequence is derived from the completed domain source inventory. Later checkpoints
depend on earlier ones where noted.

| Checkpoint | Domain Family | Dependencies | Notes |
|-----------|--------------|-------------|-------|
| **7B.1** | Transactions + Ledger (read model first) | None | Core financial primitive. Read-only HTTP surface is lowest risk. Write surface (create/revise/void canonical transaction) follows read. |
| **7B.2** | Income (sources, entitlements, receipts, settlements) | 7B.1 ledger read | Settlement state references ledger balances. |
| **7B.3** | Credit Cards (cards, statements, payments, reconciliation) | 7B.1 | High-value; purchase split reads reference people (7B.4) but core card/statement lifecycle is independent. |
| **7B.4** | People + Family (persons, obligations, settlements) | 7B.3 for split obligations | Independent person CRUD; obligation ledger provisioning needs ledger (7B.1). |
| **7B.5** | Rewards (accounts, events) | 7B.3 | Reward events source from credit card purchases. |
| **7B.6** | Campaigns (periods, review candidates, progress) | 7B.5 | Campaign reward crediting depends on rewards domain. |
| **7B.7** | Short-Term Goals + Midas + Long-Term Investment | 7B.1 ledger | Liquidity group; Midas and long-term transfers post ledger entries. |
| **7B.8** | Month-Close | 7B.1–7B.7 | Month-close formula reads across all financial domains; should be last in the financial group. |
| **7B.9** | Notifications + Imports | 7B.3 for notification events | Web-push subscription management; batch CSV import staging and resolution. |

---

## 10. Security Response Headers

The following headers are set globally on every response:

| Header | Value |
|--------|-------|
| `X-Content-Type-Options` | `nosniff` |
| `X-Frame-Options` | `DENY` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `X-Request-Id` | Per-request UUID (also returned in response) |

`Cache-Control: no-store` is additionally set on all `/auth/*` routes.

---

## 11. Backend Code Freeze Status

> **PRE-FRONTEND BACKEND CODE FREEZE: NOT YET COMPLETE**

The backend is fully implemented at the domain service layer. The HTTP product surface for
financial domains (7B.1–7B.9) is IN PROGRESS and must be completed and verified before
the pre-frontend backend code freeze can be declared.

The freeze declaration will be made explicitly in a future checkpoint delivery. Do not
infer it from this document.
