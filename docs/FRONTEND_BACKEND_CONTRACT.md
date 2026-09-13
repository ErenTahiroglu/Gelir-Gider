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

All exposed routes are **READ-ONLY** in Checkpoint 7B.1-R1.
Generic mutation routes (`POST /transactions`, `POST /transactions/:transactionId/revisions`, `POST /transactions/:transactionId/void`) are **NOT IMPLEMENTED / NOT YET EXPOSED** at the HTTP boundary. Specialized financial domains (Income, Credit Cards, People, Rewards, Campaigns, Goals, Midas, Long-Term Investment, Month-Close, Imports) retain strict mutation authority over their own transactions and ledger accounts to prevent domain bypass.

All routes require:
- Session authentication (`__Host-gg_session` cookie)
- User identity derived **strictly** from session (`c.get("auth").userId`)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/transactions` | Keyset-paginated list of current effective transactions (`limit`, `status`, `kind`, `beforeOccurredAt`, `beforeTransactionId`) |
| `GET` | `/transactions/:transactionId` | Single canonical transaction current effective state |
| `GET` | `/transactions/:transactionId/revisions` | Keyset-paginated revision audit history (`limit`, `beforeRevisionNo`) |

### 4.5 Ledger (`/ledger/*`)

Exposes safe **ledger account definition metadata provisioning** (`POST /ledger/accounts`) and bounded balance reads (`GET /ledger/accounts`, `GET /ledger/accounts/:accountId/balance`). Raw journal write endpoints (`/ledger/entries`, `/ledger/post`, `/ledger/journal`, `/ledger/reverse`) and transaction mutations remain **strictly forbidden** and do not exist on the HTTP surface.

All routes require:
- Session authentication (`__Host-gg_session` cookie)
- User identity derived **strictly** from session (`c.get("auth").userId`)
- Mutating methods (`POST`) require `sameOriginMutationGuard()` with `Origin: <WEBAUTHN_ORIGIN>` and strict closed bodies.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/ledger/accounts` | List of ledger account balances (`includeArchived`, `asOf`) |
| `GET` | `/ledger/accounts/:accountId/balance` | Single ledger account balance (`asOf`) |
| `POST` | `/ledger/accounts` | Safe product ledger account provisioning (`ASSET` \| `INCOME`) with natural-key replay |

### 4.6 Income (`/income/*`)

Specialized domain for income management (sources, monthly entitlements, realized receipts, attribution settlements, and baseline monthly reference income). All mutating endpoints are guarded with `sameOriginMutationGuard()` and require session authentication.

All routes require:
- Session authentication (`__Host-gg_session` cookie)
- User identity derived **strictly** from session (`c.get("auth").userId`)
- Mutating methods (POST) require `Origin: <WEBAUTHN_ORIGIN>` and closed bodies.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/income/sources` | Keyset-paginated list of income sources (`limit`, `includeArchived`, `beforeCreatedAt`, `beforeSourceId`) |
| `GET` | `/income/sources/:sourceId` | Single income source detail |
| `POST` | `/income/sources` | Create income source with natural-key replay against `(userId, code)` |
| `POST` | `/income/sources/:sourceId/archive` | State-idempotently archive an income source |
| `GET` | `/income/entitlements` | Keyset-paginated list of income entitlements (`sourceId`, `periodMonthFrom`, `periodMonthUntil`, `overdueAsOf`, `limit`, `beforePeriodMonth`, `beforeEntitlementId`) |
| `GET` | `/income/entitlements/:entitlementId` | Single income entitlement detail (`overdueAsOf`) |
| `POST` | `/income/entitlements` | Create expected monthly entitlement (`Idempotency-Key` required; creates audit transaction with ZERO ledger movement) |
| `POST` | `/income/entitlements/:entitlementId/revisions` | Revise expected monthly entitlement (`Idempotency-Key`, `expectedRevisionNo` required) |
| `POST` | `/income/entitlements/:entitlementId/void` | Void expected monthly entitlement (`Idempotency-Key`, `expectedRevisionNo` required; blocked if active settlements exist) |
| `GET` | `/income/receipts` | Keyset-paginated list of realized income receipts (`sourceId`, `from`, `to`, `includeVoided`, `limit`, `beforeReceivedAt`, `beforeIncomeReceiptId`) |
| `GET` | `/income/receipts/:incomeReceiptId` | Single realized income receipt detail |
| `POST` | `/income/receipts` | Create realized cash receipt (`Idempotency-Key` required; posts atomic double-entry journal effect) |
| `POST` | `/income/receipts/:incomeReceiptId/revisions` | Revise realized cash receipt (`Idempotency-Key`, `expectedRevisionNo` required; reverses old journal and posts corrected journal atomically) |
| `POST` | `/income/receipts/:incomeReceiptId/void` | Void realized cash receipt (`Idempotency-Key`, `expectedRevisionNo` required; reverses journal effect; blocked if active settlements exist) |
| `GET` | `/income/receipts/:incomeReceiptId/settlement` | Get receipt settlement breakdown and allocations |
| `POST` | `/income/receipts/:incomeReceiptId/settlement` | Create receipt-to-entitlement settlement attribution (`Idempotency-Key` required; ZERO ledger movement) |
| `POST` | `/income/receipts/:incomeReceiptId/settlement/revisions` | Revise settlement attribution / clear with `allocations: []` (`Idempotency-Key`, `expectedRevisionNo` required) |
| `GET` | `/income/reference` | Calculate baseline monthly reference income (`asOf=YYYY-MM-DD`; NOT realized cash) |

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

### 5.6 Transactions & Ledger Read Conventions (Checkpoint 7B.1-R1)

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
      "kind": "EXPENSE",
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

#### 5.6.4 Direct Manual Mutations (POST /transactions, POST /transactions/:id/revisions, POST /transactions/:id/void)
- **Status:** `NOT IMPLEMENTED / NOT YET EXPOSED` (Returns `404 NOT_FOUND`).
- Specialized domains retain mutation authority.

#### 5.6.5 GET /ledger/accounts
- Query parameters: `includeArchived` (strict boolean `"true"` | `"false"`), `asOf` (optional UTC ISO instant)
- Response (`200 OK`): `{ "accounts": [ { "accountId": "uuid", "code": "...", "name": "...", "accountType": "...", "normalBalance": "DEBIT|CREDIT", "currency": "TRY", "balance": "150.75", "archived": false } ] }`

#### 5.6.6 GET /ledger/accounts/:accountId/balance
- Query parameters: `asOf` (optional UTC ISO instant)
- Response (`200 OK`): `{ "accountId": "uuid", "currency": "TRY", "normalBalance": "DEBIT|CREDIT", "balance": "150.75", "asOf": "2026-09-10T12:00:00.000Z" }`

#### 5.6.7 POST /ledger/accounts (Checkpoint 7B.2-R1)
- **Purpose:** Safe product-level ledger account definition creation. Required for fresh users to provision accounts needed by Income (or other product surfaces) without direct DB or internal service intervention.
- **Allowed Account Types:** Strictly `"ASSET"` | `"INCOME"`. (`"LIABILITY"`, `"EQUITY"`, `"EXPENSE"` are rejected at this boundary).
- **Derived Domain Values:**
  - `normalBalance`: Derived by domain as `DEBIT` for `ASSET`, `CREDIT` for `INCOME`.
  - `currency`: Derived from authenticated user's base currency (`users.currency`).
- **Namespace Protection:**
  - Client provides alias `code` (1..60 characters, alphanumeric/underscore).
  - Server prepends `USR_` prefix, guaranteeing stored code is `USR_<ALIAS>` (5..64 characters, satisfying `^[A-Z][A-Z0-9_]{1,63}$`) and strictly disjoint from system namespaces (`SYS_*`, `CC_*`, `PRCV_*`, `PPAY_*`).
- **Body (Strictly Closed):**
  ```json
  {
    "code": "CASH",
    "name": "Main Cash Wallet",
    "accountType": "ASSET"
  }
  ```
  Reject `userId`, `currency`, `normalBalance`, `balance`, `openingBalance`, `amount`, `debit`, `credit`, `journal`, etc.
- **Natural-Key Replay Contract:**
  - First create -> `idempotentReplay: false`.
  - Exact retry (same normalized code, name, accountType) -> `idempotentReplay: true`, resolves existing account.
  - Same code with changed definition (name or accountType) -> `409 LEDGER_ACCOUNT_CODE_CONFLICT`.
- **Zero Financial Effect:**
  - Changes ONLY ledger account metadata. Creates ZERO canonical transactions, transaction revisions, journal entries, or journal lines. Initial account balance is `"0.00"`.
- **Response (`200 OK`):**
  ```json
  {
    "accountId": "44444444-4444-4444-8444-444444444444",
    "code": "USR_CASH",
    "name": "Main Cash Wallet",
    "accountType": "ASSET",
    "normalBalance": "DEBIT",
    "currency": "TRY",
    "archived": false,
    "idempotentReplay": false
  }
  ```
- **Fresh-User Income Setup Sequence:**
  1. `POST /ledger/accounts` with `{ "code": "CASH", "name": "Cash Wallet", "accountType": "ASSET" }` -> returns `accountId` (`ASSET`/`DEBIT`).
  2. `POST /ledger/accounts` with `{ "code": "SALARY", "name": "Salary Income", "accountType": "INCOME" }` -> returns `accountId` (`INCOME`/`CREDIT`).
  3. `POST /income/sources` referencing `incomeLedgerAccountId` from step 2.
  4. `POST /income/receipts` referencing `destinationAccountId` from step 1.
- **Account Archive Status:** `ACCOUNT ARCHIVE — NOT YET EXPOSED`. Active Income Source references and cross-domain dependencies require comprehensive reference validation before exposing an archive HTTP endpoint.

### 5.7 Income Product Surface (Checkpoint 7B.2)

All routes require session authentication (`__Host-gg_session` cookie) with user identity strictly bound to `c.get("auth").userId`. Mutating POST endpoints require `Origin: <WEBAUTHN_ORIGIN>` and closed bodies.

#### 5.7.1 Income Sources
- **`GET /income/sources`**: Keyset pagination with `limit` (default 50, max 100), `includeArchived` (strict `"true"` | `"false"`), `beforeCreatedAt` (ISO UTC instant), and `beforeSourceId` (UUID). Ordered `createdAt DESC, id DESC`.
- **`GET /income/sources/:sourceId`**: Single source detail. Returns 404 for missing or other user's source.
- **`POST /income/sources`**: Create income source with **natural-key replay** against `(userId, normalized code)`.
  - Body (closed): `{ code, name, nature ("REGULAR"|"EXTRA"|"SUPPORT"), referenceMethod ("FIXED_MONTHLY"|"SEASONAL_ANNUALIZED"|"ROLLING_MEDIAN"|"EXCLUDED"), expectedMonthlyAmount?, seasonalMonthsPerYear?, rollingMedianMonths?, incomeLedgerAccountId, activeFrom ("YYYY-MM-DD"), activeUntil? }`
  - Replay semantics: First valid create -> `idempotentReplay: false`. Exact retry with identical definition -> `idempotentReplay: true`. Different definition with same code -> `409 INCOME_SOURCE_CODE_CONFLICT`.
  - Account validation: `incomeLedgerAccountId` must belong to the user, have `accountType: "INCOME"`, `normalBalance: "CREDIT"`, matching currency, and unarchived.
- **`POST /income/sources/:sourceId/archive`**: State-idempotent archive. Repeated calls return the archived source safely.

#### 5.7.2 Income Entitlements
- **`GET /income/entitlements`**: Keyset pagination with `limit` (default 50, max 100), `sourceId`, `periodMonthFrom`, `periodMonthUntil`, `overdueAsOf` (`YYYY-MM-DD`), `beforePeriodMonth`, `beforeEntitlementId`. Ordered `periodMonth DESC, id DESC`.
- **`GET /income/entitlements/:entitlementId`**: Single entitlement detail with optional `overdueAsOf=YYYY-MM-DD`.
- **`POST /income/entitlements`**: Create monthly entitlement.
  - Header: `Idempotency-Key` (required).
  - Body: `{ sourceId, periodMonth ("YYYY-MM-01"), amount, expectedReceiptOn? ("YYYY-MM-DD"), note? }`
  - Zero ledger movement: creates canonical audit transaction only (NO journal entry, NO ledger movement).
- **`POST /income/entitlements/:entitlementId/revisions`**: Revise entitlement.
  - Header: `Idempotency-Key`.
  - Body: `{ expectedRevisionNo, amount, expectedReceiptOn?, note?, reasonNote? }`
- **`POST /income/entitlements/:entitlementId/void`**: Void entitlement.
  - Header: `Idempotency-Key`.
  - Body: `{ expectedRevisionNo, reasonNote? }`
  - Blocked with `409 INCOME_SETTLEMENT_CONFLICT` if active settlement allocations exist.

#### 5.7.3 Realized Income Receipts
- **`GET /income/receipts`**: Keyset pagination with `limit` (default 50, max 100), `sourceId`, `from`, `to` (UTC ISO instants), `includeVoided` (strict `"true"` | `"false"`), `beforeReceivedAt`, `beforeIncomeReceiptId`. Ordered `receivedAt DESC, id DESC`.
- **`GET /income/receipts/:incomeReceiptId`**: Single realized receipt detail.
- **`POST /income/receipts`**: Authoritative cash entry.
  - Header: `Idempotency-Key`.
  - Body: `{ sourceId, receivedAt (UTC ISO instant), amount, destinationAccountId, note? }`
  - Accounting effect: Atomically creates canonical transaction + posts DEBIT `destinationAccountId` (ASSET) and CREDIT `source.incomeLedgerAccountId` (INCOME).
- **`POST /income/receipts/:incomeReceiptId/revisions`**: Revise realized receipt.
  - Header: `Idempotency-Key`.
  - Body: `{ expectedRevisionNo, receivedAt, amount, destinationAccountId, note?, reasonNote? }`
  - Atomically reverses old journal entry and posts corrected journal entry.
- **`POST /income/receipts/:incomeReceiptId/void`**: Void realized receipt.
  - Header: `Idempotency-Key`.
  - Body: `{ expectedRevisionNo, reasonNote? }`
  - Reverses active journal entry. Blocked with `409 INCOME_SETTLEMENT_CONFLICT` if active settlement allocations exist.

#### 5.7.4 Receipt-to-Entitlement Settlements
- **`GET /income/receipts/:incomeReceiptId/settlement`**: Returns `{ incomeReceiptId, receiptAmount, allocatedAmount, unallocatedAmount, revisionNo, allocations: [ { entitlementId, periodMonth, entitlementAmount, allocatedAmount, entitlementOutstandingAfterAllReceipts } ] }`.
- **`POST /income/receipts/:incomeReceiptId/settlement`**: Create settlement attribution.
  - Header: `Idempotency-Key`.
  - Body: `{ allocations: [ { entitlementId, amount } ], note? }`
  - Enforces receipt cap, per-entitlement caps, and source compatibility. Zero ledger movement.
- **`POST /income/receipts/:incomeReceiptId/settlement/revisions`**: Revise settlement attribution.
  - Header: `Idempotency-Key`.
  - Body: `{ expectedRevisionNo, allocations: [ { entitlementId, amount } ], note?, reasonNote? }`
  - Passing `allocations: []` clears allocations, which allows subsequent voiding of the receipt or entitlement.

#### 5.7.5 Monthly Reference Income
- **`GET /income/reference?asOf=YYYY-MM-DD`**: Calculates baseline reference income.
  - Response: `{ asOf, currency, total, sources: [ { sourceId, code, name, nature, referenceMethod, referenceAmount } ] }`
  - Reference income is a baseline calculation and is NOT realized income or cash received.

**Income Error Codes:**
| Code | Status | Description |
|------|--------|-------------|
| `INCOME_INVALID_INPUT` | 400 | Malformed parameter, invalid format, or closed-body rejection |
| `INCOME_SOURCE_NOT_FOUND` | 404 | Income source not found or owned by another user |
| `INCOME_ENTITLEMENT_NOT_FOUND` | 404 | Income entitlement not found or owned by another user |
| `INCOME_RECEIPT_NOT_FOUND` | 404 | Income receipt not found or owned by another user |
| `INCOME_SETTLEMENT_NOT_FOUND` | 404 | Income settlement batch not found |
| `INCOME_SOURCE_CODE_CONFLICT` | 409 | Income source code exists with different definition |
| `INCOME_SOURCE_ARCHIVED` | 409 | Mutation rejected because income source is archived |
| `INCOME_IDEMPOTENCY_CONFLICT` | 409 | Replay with different payload on same idempotency key |
| `INCOME_ENTITLEMENT_PERIOD_CONFLICT` | 409 | Entitlement already exists for same source and periodMonth |
| `INCOME_ENTITLEMENT_REVISION_CONFLICT`| 409 | Stale expectedRevisionNo on entitlement revision/void |
| `INCOME_ENTITLEMENT_ALREADY_VOIDED` | 409 | Cannot mutate an already voided entitlement |
| `INCOME_RECEIPT_REVISION_CONFLICT` | 409 | Stale expectedRevisionNo on receipt revision/void |
| `INCOME_RECEIPT_ALREADY_VOIDED` | 409 | Cannot mutate an already voided receipt |
| `INCOME_SETTLEMENT_CONFLICT` | 409 | Settlement cap exceeded or active settlement blocks void |
| `INCOME_SETTLEMENT_ALREADY_EXISTS` | 409 | Settlement batch exists; use revision endpoint |
| `INCOME_SETTLEMENT_REVISION_CONFLICT` | 409 | Stale expectedRevisionNo on settlement revision |
| `INCOME_LEDGER_ACCOUNT_INVALID` | 400 | Account does not exist, not owned, or wrong type/currency |

### 5.8 Credit Cards Product Surface (Checkpoint 7B.3)

All routes require session authentication (`__Host-gg_session` cookie) with user identity strictly bound to `c.get("auth").userId`. Mutating POST endpoints require `Origin: <WEBAUTHN_ORIGIN>` and closed bodies.

#### 5.8.1 Credit Cards
- **`GET /credit-cards`**: Bounded list of user's credit cards. Query parameters: `status` (`"ACTIVE"` | `"ARCHIVED"`), `limit` (default 50, max 100), `after` (opaque stateless keyset cursor). Ordered `createdAt ASC, id ASC`.
  - Response: `{ cards: [ { cardId, userId, code, status, revisionNo, displayName, issuer, statementDay, dueDay, creditLimit, lastFour, note, createdAt, liabilityAccountId, liveLiabilityBalance } ], limit, hasMore, nextCursor }`.
- **`GET /credit-cards/:id`**: Single card record. Returns 404 for missing or another user's card.
- **`POST /credit-cards`**: Create a new credit card.
  - Header: `Idempotency-Key` (required).
  - Body (closed): `{ code, displayName (max 120), issuer (max 120), statementDay (1..31), dueDay (1..31), creditLimit, lastFour? (4 digits), note? (max 500), occurredAt }`
  - Automatically provisions ledger links and credit card system accounts.
- **`POST /credit-cards/:id`**: Update credit card with OCC.
  - Header: `Idempotency-Key` (required).
  - Body (closed): `{ expectedRevisionNo, displayName (max 120), issuer (max 120), statementDay, dueDay, creditLimit, lastFour?, note? (max 500), changeReason? (max 500), occurredAt }`
- **`POST /credit-cards/:id/archive`**: Archive credit card.
  - Header: `Idempotency-Key` (required).
  - Body (closed): `{ expectedRevisionNo, changeReason?, occurredAt }`

#### 5.8.2 Statements
- **`GET /credit-cards/:cardId/statements`**: List statements for a card. Query parameters: `status` (`"OPEN"` | `"PAID"` | `"VOID"`), `cycleMonth` (`YYYY-MM`), `limit` (default 50, max 100), `after` (opaque stateless keyset cursor). Ordered `cycleYear DESC, cycleMonth DESC, id ASC`.
  - Response: `{ statements: [ { statementId, cardId, userId, cycleYear, cycleMonth, status, revisionNo, statementAmount, statementDate, dueDate, reservePlacement, reserveAmount, reserveSatisfied, note } ], limit, hasMore, nextCursor }`.
- **`GET /credit-cards/:cardId/statements/:id`**: Single statement record. Returns 404 if not found or card/user mismatch.
- **`POST /credit-cards/:cardId/statements`**: Create monthly statement.
  - Header: `Idempotency-Key` (required).
  - Body (closed): `{ midasAccountId, cycleMonth ("YYYY-MM"), statementAmount, reservePlacement ("MIDAS_FUND"|"OUTSIDE_MIDAS"), note?, occurredAt }`
- **`POST /credit-cards/:cardId/statements/:id`**: Update open statement with OCC.
  - Header: `Idempotency-Key` (required).
  - Body (closed): `{ expectedRevisionNo, statementAmount, reservePlacement, note?, reasonNote?, occurredAt }`
- **`POST /credit-cards/:cardId/statements/:id/void`**: Void open statement.
  - Header: `Idempotency-Key` (required).
  - Body (closed): `{ expectedRevisionNo, reasonNote?, occurredAt }`

#### 5.8.3 Statement Payment & Reopen (Economic Lifecycle)
- **`POST /credit-cards/:cardId/statements/:id/pay`**: Execute statement payment.
  - Header: `Idempotency-Key` (required).
  - Body (closed): `{ expectedRevisionNo, paymentAmount?, paymentMethod?, paymentAssetAccountId?, outsidePaymentAssetAccountId?, occurredAt }`
  - Posts journal entry (DR Credit Card Liability, CR Payment Asset Account), transitions statement to `PAID`, records payment event, and enqueues Budget V2 checkpoint request.
- **`POST /credit-cards/:cardId/statements/:id/reopen`**: Reopen statement payment (reversal).
  - Header: `Idempotency-Key` (required).
  - Body (closed): `{ expectedRevisionNo, reasonNote?, occurredAt }`
  - Posts reversal journal entry, transitions statement back to `OPEN`, records reversal event.

#### 5.8.4 Payment-Readiness & Reconciliation
- **`GET /credit-cards/:cardId/statements/:id/readiness`**: Pure read-only payment-readiness calculation.
  - Returns `{ readiness: { statementId, cardId, statementAmount, cardLiabilityBalance, reservePlacement ("MIDAS_FUND"|"OUTSIDE_MIDAS"), reserveAmount, liabilityCoverage ("READY"|"SHORTFALL"), liabilityAfterPayment } }`.
- **`GET /credit-cards/:cardId/statements/:id/reconciliation`**: Stored component decomposition. Optional `?asOf=` timestamp query.
  - Returns `{ reconciliation: { statementId, status, revisionNo, statementRevisionId, reconciledStatementAmount, staleReason, components, personalAmount, externalAmountsByPerson } }`.
- **`POST /credit-cards/:cardId/statements/:id/reconcile`**: Persist explicit statement reconciliation mutation.
  - Header: `Idempotency-Key` (required).
  - Body (closed): `{ statementRevisionId, components: [ { componentNo, componentType ("PURCHASE"|"ADJUSTMENT"), amount, ownership ("PERSONAL"|"EXTERNAL_PERSON"), personId?, purchaseEventId?, purchaseSplitRevisionId?, adjustmentKind?, note? } ], expectedRevisionNo?, occurredAt? }`
- **`POST /credit-cards/:cardId/statements/:id/reconcile/void`**: Void statement reconciliation.
  - Header: `Idempotency-Key` (required).
  - Body (closed): `{ expectedRevisionNo, occurredAt? }`

#### 5.8.5 Unshared Purchases (Product Lifecycle)
- **`GET /credit-cards/:cardId/purchases`**: List unshared purchases for a card (excludes opening balance events). Query parameters: `purchaseCategory` (aliases `budgetCategory` and `category` supported; supplying more than one category alias in the same request returns `400 CREDIT_CARD_INVALID_INPUT`), `status` (`"POSTED"` | `"VOID"`), `purchaseDateFrom` / `fromDate` (`YYYY-MM-DD`), `purchaseDateUntil` / `toDate` (`YYYY-MM-DD`), `limit` (default 50, max 100), `after` (opaque stateless keyset cursor). Ordered `purchaseDate DESC, occurredAt DESC, id ASC`.
  - Response: `{ purchases: [ { eventId, cardId, userId, eventType ("PURCHASE"), status ("POSTED"|"VOID"), revisionNo, amount, personalExpenseAmount, externalReceivableAmount, split, purchaseDate, purchaseCategory, shortTermGoalId, merchant, description, installmentCount, canonicalTransactionId, canonicalRevisionId, journalEntryId, occurredAt, createdAt } ], limit, hasMore, nextCursor }`.
- **`GET /credit-cards/:cardId/purchases/:id`**: Single purchase record. Returns only eventType `PURCHASE`. If the event ID corresponds to an opening balance or non-purchase event, returns `404 CREDIT_CARD_PURCHASE_NOT_FOUND` without leaking event type (opening balances are isolated under `/credit-cards/:cardId/opening-balance`).
- **`POST /credit-cards/:cardId/purchases`**: Record an unshared purchase.
  - Header: `Idempotency-Key` (required).
  - Body (closed): `{ amount, purchaseCategory ("MANDATORY_EXPENSE"|"DISCRETIONARY_SPEND"|"SHORT_TERM_PURCHASE"|"UNCLASSIFIED"), shortTermGoalId?, merchant?, description?, installmentCount? (1..60), occurredAt }`
- **`POST /credit-cards/:cardId/purchases/:id`** & **`POST /credit-cards/:cardId/purchases/:id/revisions`**: Update unshared purchase with OCC.
  - Header: `Idempotency-Key` (required).
  - Body (closed): `{ expectedRevisionNo, amount, purchaseCategory, shortTermGoalId?, merchant?, description?, installmentCount? (1..60), reasonNote?, occurredAt }`
  - Preflight checks require eventType `PURCHASE`; returns `404 CREDIT_CARD_PURCHASE_NOT_FOUND` if the target event is not a purchase.
- **`POST /credit-cards/:cardId/purchases/:id/void`**: Void unshared purchase.
  - Header: `Idempotency-Key` (required).
  - Body (closed): `{ expectedRevisionNo, reasonNote?, occurredAt }`
  - Preflight checks require eventType `PURCHASE`; returns `404 CREDIT_CARD_PURCHASE_NOT_FOUND` if the target event is not a purchase.

#### 5.8.7 Shared Purchases & Split Management (Checkpoint 7B.4-R1)
- **`POST /credit-cards/:cardId/purchases/shared`**: Atomically create a purchase and its initial participant split.
  - Header: `Idempotency-Key` (required; server derives child purchase & split keys deterministically using SHA-256 digest derivation `CC_SHARED_PURCHASE_<sha256hex>` and `CC_SHARED_SPLIT_<sha256hex>`).
  - Body (closed):
    ```json
    {
      "amount": "1000.00",
      "purchaseCategory": "DISCRETIONARY_SPEND",
      "shortTermGoalId": "optional-uuid",
      "merchant": "optional merchant",
      "description": "optional description",
      "installmentCount": 1,
      "occurredAt": "2026-09-10T12:00:00.000Z",
      "splitMethod": "EQUAL",
      "userWeight": 1,
      "participants": [
        {
          "personId": "uuid-person-1",
          "shareAmount": "500.00",
          "weight": 1,
          "dueDate": "2026-10-01",
          "description": "optional note"
        }
      ]
    }
    ```
  - Response: `{ purchase: PurchaseMutationResult, split: CreditCardPurchaseSplitProductDto, idempotentReplay: boolean }`
- **`GET /credit-cards/:cardId/purchases/:id/split`**: Read active split product DTO. Returns `404 CREDIT_CARD_SPLIT_NOT_FOUND` if no active split exists.
- **`POST /credit-cards/:cardId/purchases/:id/split`**: Attach a new split to an existing unshared credit card purchase.
  - Header: `Idempotency-Key` (required).
  - Body (closed): `{ splitMethod, userWeight?, participants: ParticipantInput[], occurredAt? }`
- **`POST /credit-cards/:cardId/purchases/:id/split/revisions`**: Revise split participant allocation (OCC).
  - Header: `Idempotency-Key` (required).
  - Body (closed): `{ expectedRevisionNo, splitMethod, userWeight?, participants: ParticipantInput[], occurredAt? }`
- **`POST /credit-cards/:cardId/purchases/:id/split/void`**: Void split allocation (OCC).
  - Header: `Idempotency-Key` (required).
  - Body (closed): `{ expectedRevisionNo, occurredAt? }`
- **`POST /credit-cards/:cardId/purchases/:id/shared-revisions`**: Coordinated atomic revision of both purchase details and split allocations.
  - Header: `Idempotency-Key` (required).
  - Body (closed): `{ expectedPurchaseRevisionNo, expectedSplitRevisionNo, amount, purchaseCategory, shortTermGoalId?, merchant?, description?, installmentCount?, reasonNote?, occurredAt, splitMethod, userWeight?, participants: ParticipantInput[] }`
- **`POST /credit-cards/:cardId/purchases/:id/shared-void`**: Coordinated atomic void of both purchase and active split.
  - Header: `Idempotency-Key` (required).
  - Body (closed): `{ expectedPurchaseRevisionNo, expectedSplitRevisionNo, reasonNote?, occurredAt }`

**Split Product DTO (`CreditCardPurchaseSplitProductDto`):**
```json
{
  "splitId": "uuid",
  "purchaseEventId": "uuid",
  "status": "ACTIVE",
  "revisionNo": 1,
  "method": "EQUAL",
  "grossAmount": "1000.00",
  "userShareAmount": "500.00",
  "externalShareAmount": "500.00",
  "userWeight": 1,
  "occurredAt": "2026-09-10T12:00:00.000Z",
  "participants": [
    {
      "personId": "uuid",
      "displayName": "Alice",
      "relationship": "FAMILY",
      "shareAmount": "500.00",
      "settledAmount": "0.00",
      "remainingAmount": "500.00",
      "weight": 1,
      "dueDate": "2026-10-01",
      "description": "Dinner share",
      "obligationId": "uuid"
    }
  ]
}
```
*Note: Internal fields `userId`, `canonicalTransactionId`, `canonicalRevisionId`, `revisionFingerprint`, and internal seal/item IDs are stripped from all public split responses.*

#### 5.8.8 Opening Balance (Direct Setup / Onboarding Lifecycle)
- **`GET /credit-cards/:cardId/opening-balance`**: Returns the card's opening balance liability event, or `{ openingBalance: null }` if not set.
- **`POST /credit-cards/:cardId/opening-balance`**: Record initial credit card opening balance debt at onboarding/import time.
  - Header: `Idempotency-Key` (required).
  - Body (closed): `{ amount, description?, occurredAt }`
- **`POST /credit-cards/:cardId/opening-balance/:id`** & **`POST /credit-cards/:cardId/opening-balance/:id/revisions`**: Update opening balance with OCC.
  - Header: `Idempotency-Key` (required).
  - Body (closed): `{ expectedRevisionNo, amount, description?, reasonNote?, occurredAt }`
- **`POST /credit-cards/:cardId/opening-balance/:id/void`**: Void opening balance.
  - Header: `Idempotency-Key` (required).
  - Body (closed): `{ expectedRevisionNo, reasonNote?, occurredAt }`

**Credit Card Error Codes:**
| Code | Status | Description |
|------|--------|-------------|
| `CREDIT_CARD_INVALID_INPUT` | 400 | Malformed parameter, invalid format, or closed-body rejection |
| `CREDIT_CARD_LEDGER_ACCOUNT_INVALID` | 400 | Invalid ledger account for credit card |
| `CREDIT_CARD_STATEMENT_RECONCILIATION_NOT_BALANCED` | 400 | Statement reconciliation is not balanced |
| `CREDIT_CARD_NOT_FOUND` | 404 | Credit card not found or owned by another user |
| `CREDIT_CARD_STATEMENT_NOT_FOUND` | 404 | Statement not found or card/user mismatch |
| `CREDIT_CARD_PURCHASE_NOT_FOUND` | 404 | Purchase event not found or card/user mismatch |
| `CREDIT_CARD_PAYMENT_NOT_FOUND` | 404 | Credit card statement payment not found |
| `CREDIT_CARD_LEDGER_LINK_NOT_FOUND` | 404 | Credit card ledger link not found |
| `CREDIT_CARD_SYSTEM_ACCOUNT_NOT_FOUND` | 404 | Credit card system account not found |
| `CREDIT_CARD_SPLIT_NOT_FOUND` | 404 | Credit card split not found |
| `CREDIT_CARD_STATEMENT_RECONCILIATION_NOT_FOUND` | 404 | Statement reconciliation not found |
| `CREDIT_CARD_NOT_ACTIVE` | 409 | Credit card is not active |
| `CREDIT_CARD_CONFLICT` | 409 | Credit card code conflict |
| `CREDIT_CARD_REVISION_CONFLICT` | 409 | Credit card revision is stale |
| `CREDIT_CARD_STATEMENT_PERIOD_CONFLICT` | 409 | Credit card statement period conflict |
| `CREDIT_CARD_STATEMENT_NOT_OPEN` | 409 | Credit card statement is not open |
| `CREDIT_CARD_STATEMENT_REVISION_CONFLICT` | 409 | Credit card statement revision is stale |
| `CREDIT_CARD_INSUFFICIENT_MIDAS_LIQUIDITY` | 409 | Insufficient Midas liquidity for reserve |
| `CREDIT_CARD_RESERVE_CONFLICT` | 409 | Credit card reserve conflict |
| `CREDIT_CARD_IDEMPOTENCY_CONFLICT` | 409 | Idempotency-Key was already used with a different request |
| `CREDIT_CARD_INVALID_STATE` | 409 | Credit card invalid state transition |
| `CREDIT_CARD_PURCHASE_NOT_ACTIVE` | 409 | Credit card purchase is not active |
| `CREDIT_CARD_OPENING_BALANCE_CONFLICT` | 409 | Credit card opening balance conflict |
| `CREDIT_CARD_LIABILITY_SHORTFALL` | 409 | Credit card liability shortfall |
| `CREDIT_CARD_PAYMENT_CONFLICT` | 409 | Credit card statement payment conflict |
| `CREDIT_CARD_STATEMENT_ALREADY_PAID` | 409 | Credit card statement is already paid |
| `CREDIT_CARD_STATEMENT_NOT_PAID` | 409 | Credit card statement is not paid |
| `CREDIT_CARD_CANNOT_ARCHIVE_WITH_LIABILITY` | 409 | Cannot archive credit card with outstanding liability |
| `CREDIT_CARD_SPLIT_NOT_ACTIVE` | 409 | Credit card split is not active |
| `CREDIT_CARD_SPLIT_REVISION_CONFLICT` | 409 | Credit card split revision is stale |
| `CREDIT_CARD_SPLIT_IDEMPOTENCY_CONFLICT` | 409 | Credit card split idempotency conflict |
| `CREDIT_CARD_SPLIT_CONFLICT` | 409 | Credit card split conflict or active-settlement reduction conflict |
| `CREDIT_CARD_STATEMENT_RECONCILIATION_CONFLICT` | 409 | Statement reconciliation conflict |
| `CREDIT_CARD_STATEMENT_RECONCILIATION_IDEMPOTENCY_CONFLICT` | 409 | Statement reconciliation idempotency conflict |

---

### 5.9 People + Family (Checkpoint 7B.4 — IMPLEMENTED)

The People + Family domain manages trusted counterparts, interpersonal obligations (receivables & payables), and cash settlements.

#### 5.9.1 Person Lifecycle (5 Routes)
- **`GET /people`**: Bounded keyset-paginated list of people.
  - Query parameters: `status` (`ACTIVE` | `ARCHIVED`), `relationship` (`FAMILY` | `FRIEND` | `COLLEAGUE` | `OTHER`), `limit` (default 50, max 100), `after` (opaque Base64URL cursor).
  - Response: `{ people: PersonProductDto[], hasMore: boolean, nextCursor: string | null }`
- **`GET /people/:id`**: Get single person details. Returns `404 PEOPLE_NOT_FOUND` if nonexistent or owned by another user.
- **`POST /people`**: Create a new person counterpart.
  - Header: `Idempotency-Key` (required).
  - Body (closed): `{ displayName, relationship, note?, occurredAt }`
  - *Domain Truth Note:* Creating a person is a metadata operation. Dedicated person ledger accounts are lazily provisioned on first financial obligation creation.
- **`POST /people/:id`**: Update person metadata (OCC).
  - Header: `Idempotency-Key` (required).
  - Body (closed): `{ expectedRevisionNo, displayName, relationship, note?, occurredAt }`
- **`POST /people/:id/archive`**: Archive a person counterpart.
  - Header: `Idempotency-Key` (required).
  - Body (closed): `{ expectedRevisionNo, occurredAt }`
  - Returns `409 PEOPLE_PERSON_HAS_OUTSTANDING_BALANCE` if receivable or payable balance is non-zero.

**Person Product DTO (`PersonProductDto`):**
```json
{
  "personId": "uuid",
  "status": "ACTIVE",
  "displayName": "Alice Smith",
  "relationship": "FAMILY",
  "note": "Sister",
  "revisionNo": 1,
  "receivableBalance": "0.00",
  "payableBalance": "0.00"
}
```
*Note: Internal ledger account IDs (`receivableAccountId`, `payableAccountId`) and user IDs are stripped from public responses.*

#### 5.9.2 Obligations Lifecycle (6 Routes)
- **`GET /people/:personId/obligations`**: Bounded keyset-paginated list of obligations for a person.
  - Query parameters: `direction` (`RECEIVABLE` | `PAYABLE`), `status` (`OPEN` | `SETTLED` | `VOID`), `dueDateFrom`, `dueDateUntil`, `limit` (default 50, max 100), `after` (opaque Base64URL cursor).
  - Filtering by status/direction/due dates is evaluated before pagination truncation in SQL.
  - Response: `{ obligations: ObligationProductDto[], hasMore: boolean, nextCursor: string | null }`
- **`GET /people/:personId/obligations/:id`**: Get single obligation details.
- **`POST /people/:personId/obligations/receivable`**: Record a standalone receivable obligation (money lent to person).
  - Header: `Idempotency-Key` (required).
  - Body (closed): `{ amount, fundingAssetAccountId, dueDate?, description?, occurredAt }`
- **`POST /people/:personId/obligations/payable`**: Record a standalone payable expense obligation (money owed to person).
  - Header: `Idempotency-Key` (required).
  - Body (closed): `{ amount, budgetCategory, dueDate?, description?, occurredAt }`
- **`POST /people/:personId/obligations/:id`**: Update standalone obligation details with OCC.
  - Header: `Idempotency-Key` (required).
  - Body (closed): `{ expectedRevisionNo, amount, fundingAssetAccountId?, budgetCategory?, dueDate?, description?, occurredAt }`
  - *Authority Protection:* Returns `409 PEOPLE_OBLIGATION_SPLIT_MANAGED` if the obligation was created by a credit card purchase split. Split-managed obligations must be revised via split routes.
- **`POST /people/:personId/obligations/:id/void`**: Void a standalone obligation with OCC.
  - Header: `Idempotency-Key` (required).
  - Body (closed): `{ expectedRevisionNo }`
  - Returns `409 PEOPLE_OBLIGATION_SPLIT_MANAGED` if split-managed. Returns `409 PEOPLE_OBLIGATION_SETTLEMENT_CONFLICT` if active settlements exist.

**Obligation Product DTO (`ObligationProductDto`):**
```json
{
  "obligationId": "uuid",
  "personId": "uuid",
  "direction": "RECEIVABLE",
  "status": "OPEN",
  "principalAmount": "500.00",
  "settledAmount": "0.00",
  "remainingAmount": "500.00",
  "dueDate": "2026-10-01",
  "description": "Dinner share",
  "budgetCategory": null,
  "revisionNo": 1,
  "isSplitManaged": false,
  "fundingAssetAccountId": "uuid"
}
```
*Note: Canonical IDs (`canonicalTransactionId`, `canonicalRevisionId`) are stripped.*

#### 5.9.3 Settlements Lifecycle (5 Routes)
- **`GET /people/:personId/obligations/:obligationId/settlements`**: Bounded keyset-paginated list of settlements for an obligation.
  - Query parameters: `status` (`ACTIVE` | `VOIDED`), `limit` (default 50, max 100), `after` (opaque Base64URL cursor).
  - Response: `{ settlements: SettlementProductDto[], hasMore: boolean, nextCursor: string | null }`
- **`GET /people/:personId/obligations/:obligationId/settlements/:id`**: Get single settlement details.
- **`POST /people/:personId/obligations/:obligationId/settlements/receivable`**: Settle a receivable obligation (person paying back user).
  - Header: `Idempotency-Key` (required).
  - Body (closed): `{ cashAmount, destinationAssetAccountId, note?, occurredAt }`
  - *Overpayment behavior:* If `cashAmount > remainingAmount`, the obligation is fully settled (`appliedAmount = remainingAmount`) and the excess amount is routed to unearned income receipt (`overpaymentIncomeReceiptId`).
- **`POST /people/:personId/obligations/:obligationId/settlements/payable`**: Settle a payable obligation (user paying person back).
  - Header: `Idempotency-Key` (required).
  - Body (closed): `{ amount, sourceAssetAccountId, note?, occurredAt }`
  - Cannot overpay payable obligations (`409 PEOPLE_OBLIGATION_OVERSETTLEMENT`).
- **`POST /people/:personId/obligations/:obligationId/settlements/:id/void`**: Void a settlement with OCC.
  - Header: `Idempotency-Key` (required).
  - Body (closed): `{ expectedRevisionNo, reason }`
  - Returns `409 PEOPLE_SETTLEMENT_NOT_ACTIVE` if already VOID. Returns `409 PEOPLE_REVISION_CONFLICT` on OCC mismatch.

**Settlement Product DTO (`SettlementProductDto`):**
```json
{
  "settlementId": "uuid",
  "obligationId": "uuid",
  "personId": "uuid",
  "direction": "RECEIVABLE",
  "status": "ACTIVE",
  "cashAmount": "600.00",
  "appliedAmount": "500.00",
  "excessAmount": "100.00",
  "note": "Bank transfer",
  "occurredAt": "2026-09-10T12:00:00.000Z",
  "revisionNo": 1,
  "assetAccountId": "uuid",
  "overpaymentIncomeReceiptId": "uuid"
}
```

**People + Family Error Codes:**
| Code | Status | Description |
|------|--------|-------------|
| `PEOPLE_INVALID_INPUT` | 400 | Malformed UUID, invalid parameters, or closed body violation |
| `PEOPLE_LEDGER_ACCOUNT_INVALID` | 400 | Invalid ledger account for person |
| `PEOPLE_NOT_FOUND` | 404 | Person counterpart not found or owned by another user |
| `PEOPLE_OBLIGATION_NOT_FOUND` | 404 | Obligation not found or person mismatch |
| `PEOPLE_SETTLEMENT_NOT_FOUND` | 404 | Settlement not found or obligation mismatch |
| `PEOPLE_NOT_ACTIVE` | 409 | Person or obligation is not active for this operation |
| `PEOPLE_REVISION_CONFLICT` | 409 | Optimistic concurrency conflict on person revision or settlement revision |
| `PEOPLE_OBLIGATION_NOT_ACTIVE` | 409 | Person obligation is not active |
| `PEOPLE_OBLIGATION_REVISION_CONFLICT` | 409 | Optimistic concurrency conflict on obligation revision |
| `PEOPLE_OBLIGATION_SETTLEMENT_CONFLICT` | 409 | Obligation has active settlements and cannot be voided or reduced |
| `PEOPLE_OBLIGATION_OVERSETTLEMENT` | 409 | Payable settlement amount exceeds remaining balance |
| `PEOPLE_OBLIGATION_SPLIT_MANAGED` | 409 | Cannot directly update/void obligation managed by credit card split |
| `PEOPLE_PERSON_HAS_OUTSTANDING_BALANCE` | 409 | Cannot archive person with active receivable or payable balance |
| `PEOPLE_SETTLEMENT_NOT_ACTIVE` | 409 | Settlement is not active (already VOID) |
| `PEOPLE_IDEMPOTENCY_CONFLICT` | 409 | Idempotency key already used with different payload |

### 7B.5 — Rewards (IMPLEMENTED)

The Rewards domain manages user-defined loyalty and point reward wallets (e.g., credit card points, airline miles, hotel points), tracking their lifecycle, point balances, point valuation rates, manual events, economic redemptions, and protection against modifying externally-managed campaign points.

#### 1. Endpoints

```
IMPLEMENTED  GET   /rewards/accounts                           ?status=&limit=&after=
IMPLEMENTED  GET   /rewards/accounts/:id
IMPLEMENTED  POST  /rewards/accounts                           (create anchor & rev 1)
IMPLEMENTED  POST  /rewards/accounts/:id                       (update mutable config)
IMPLEMENTED  POST  /rewards/accounts/:id/archive               (archive wallet with zero balance)

IMPLEMENTED  GET   /rewards/accounts/:accountId/events         ?eventType=&status=&limit=&after=
IMPLEMENTED  GET   /rewards/accounts/:accountId/events/:eventId
IMPLEMENTED  POST  /rewards/accounts/:accountId/events/opening-balance
IMPLEMENTED  POST  /rewards/accounts/:accountId/events/earn
IMPLEMENTED  POST  /rewards/accounts/:accountId/events/expire
IMPLEMENTED  POST  /rewards/accounts/:accountId/events/adjustment-credit
IMPLEMENTED  POST  /rewards/accounts/:accountId/events/adjustment-debit
IMPLEMENTED  POST  /rewards/accounts/:accountId/purchases      (economic redemption)
IMPLEMENTED  POST  /rewards/accounts/:accountId/events/:eventId/void (void manual event)
```

#### 2. Product DTO Shapes

##### `RewardAccountProductDto`
```typescript
interface RewardAccountProductDto {
  rewardAccountId: string;
  code: string;
  status: "ACTIVE" | "ARCHIVED";
  displayName: string;
  provider: string;
  unitName: string;
  creditCardId: string | null;
  defaultConversionRate: string; // 6 decimal digits (e.g. "0.050000")
  balancePoints: string;         // 4 decimal digits (e.g. "5000.0000")
  estimatedCurrentValue: string; // 2 decimal digits (e.g. "250.00")
  revisionNo: number;
  occurredAt: string;            // ISO 8601 UTC timestamp
  createdAt: string;             // ISO 8601 UTC timestamp
}
```

##### `RewardEventProductDto`
```typescript
interface RewardEventProductDto {
  rewardEventId: string;
  rewardAccountId: string;
  revisionNo: number;
  status: "ACTIVE" | "VOID";
  eventType: "OPENING_BALANCE" | "EARN" | "EXPIRE" | "ADJUSTMENT_CREDIT" | "ADJUSTMENT_DEBIT" | "REDEEM_PURCHASE";
  pointAmount: string;           // 4 decimal digits (e.g. "1000.0000")
  signedPointEffect: string;     // Signed 4 decimal digits (e.g. "+1000.0000", "-500.0000", "+0.0000" if VOID)
  conversionRate: string;        // 6 decimal digits (e.g. "0.010000")
  economicAmount: string;        // 2 decimal digits (e.g. "10.00")
  purchaseCategory: "MANDATORY_EXPENSE" | "DISCRETIONARY_SPEND" | "SHORT_TERM_PURCHASE" | "UNCLASSIFIED" | null;
  shortTermGoalId: string | null;
  merchant: string | null;
  description: string | null;
  reasonNote: string | null;
  sourceType: "MANUAL" | "CAMPAIGN" | "IMPORT";
  sourceRef: string | null;
  occurredAt: string;            // ISO 8601 UTC timestamp
  createdAt: string;             // ISO 8601 UTC timestamp
}
```

#### 3. Error Codes & HTTP Mapping

| Code | HTTP Status | Description |
|---|---|---|
| `REWARD_INVALID_INPUT` | 400 | Malformed UUID, invalid decimal precision, invalid query params, or closed body violation |
| `REWARD_ACCOUNT_NOT_FOUND` | 404 | Reward account does not exist or belongs to another user |
| `REWARD_EVENT_NOT_FOUND` | 404 | Reward event does not exist, belongs to another user, or account mismatch |
| `REWARD_ACCOUNT_NOT_ACTIVE` | 409 | Attempting to record events or mutate an ARCHIVED account |
| `REWARD_ACCOUNT_CONFLICT` | 409 | Duplicate account code or archiving account with non-zero point balance |
| `REWARD_ACCOUNT_REVISION_CONFLICT` | 409 | Optimistic concurrency conflict on account revision (`expectedRevisionNo` mismatch) |
| `REWARD_EVENT_NOT_ACTIVE` | 409 | Event is already in VOID status |
| `REWARD_EVENT_CONFLICT` | 409 | Invalid event operation or conflicting event state |
| `REWARD_EVENT_REVISION_CONFLICT` | 409 | Optimistic concurrency conflict on event revision (`expectedRevisionNo` mismatch) |
| `REWARD_IDEMPOTENCY_CONFLICT` | 409 | Idempotency key already used with different payload |
| `REWARD_INSUFFICIENT_POINTS` | 409 | Negative point operation exceeds available account balance |
| `REWARD_EVENT_EXTERNALLY_MANAGED` | 409 | Attempting to manually void an event owned by CAMPAIGN or IMPORT |

---

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
