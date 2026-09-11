# Gelir-Gider Backend Production Runbook

Operational procedures, security constraints, deployment gates, and configuration requirements for the Gelir-Gider backend core.

---

## 1. System Requirements & Installation

- **Node.js:** `>= 20.0.0` (Node 22 LTS recommended)
- **npm:** `>= 10.0.0`

### Clean-Install Flow
To guarantee reproducible builds without stale artifacts or package dependencies:
```bash
rm -rf node_modules
npm ci
```

---

## 2. Release & Quality Gates

Every release candidate must pass all validation gates locally and in CI before deployment:

1. **Full Quality Suite:**
   ```bash
   npm run check
   ```
   Runs `cf-typegen`, `typecheck`, `lint`, `format:check`, and `test` (170 test suites, 2178+ tests).

2. **PostgreSQL Runtime Verification (PGlite):**
   ```bash
   npm run test:pg
   ```
   Runs the complete disposable PGlite migration chain (0000–0071) and all domain runtime
   regression suites including the 7B.0 `sharedMaxCheckpointAt` correctness suite and the
   7B.1 transactions & ledger product boundary suite (742 passed assertions). This is a
   **required CI gate** — not local-report-only.

3. **Schema Drift Check:**
   ```bash
   DATABASE_URL="postgres://dummy:dummy@localhost:5432/dummy" npx drizzle-kit generate
   ```
   **Expected Output:** `No schema changes, nothing to migrate`

4. **Cloudflare Worker Dry-Run:**
   ```bash
   npx wrangler deploy --dry-run
   ```
   Verifies bundle compilation, size limits, syntax, and binding mappings without modifying remote infrastructure.

5. **Dependency Audit:**
   ```bash
   npm audit --audit-level=high
   ```
   Ensures zero High or Critical vulnerabilities.

---

## 3. Configuration & Secret Inventory

The backend core requires the following environment variables and bindings.

### Worker Secrets & Environment Variables

| Variable | Classification | Description |
| :--- | :--- | :--- |
| `DATABASE_URL` | Secret | Neon PostgreSQL connection string (must use `sslmode=require`). |
| `WEBAUTHN_RP_ID` | Config | WebAuthn Relying Party ID (domain name, e.g., `app.example.com` or `localhost`). |
| `WEBAUTHN_RP_NAME` | Config | WebAuthn Relying Party display name (`Gelir Gider`). |
| `WEBAUTHN_ORIGIN` | Config | WebAuthn expected origin (full URL, e.g., `https://app.example.com` or `http://localhost:8787`). |
| `BOOTSTRAP_TOKEN_HASH` | Secret | SHA-256 hash of single-user bootstrap token (64 lowercase hex characters). |
| `WEB_PUSH_VAPID_SUBJECT` | Config | Web Push VAPID contact URI (`mailto:...` or `https://...`). |
| `WEB_PUSH_VAPID_PUBLIC_KEY` | Config | 65-byte uncompressed P-256 public key (strict unpadded base64url). |
| `WEB_PUSH_VAPID_PRIVATE_KEY` | Secret | 32-byte P-256 private scalar (strict unpadded base64url). |
| `BACKUP_ENCRYPTION_KEY` | Secret | 32-byte AES-256-GCM symmetric encryption key (strict unpadded base64url). |
| `BACKUP_ENCRYPTION_KEY_ID` | Config | Key generation identifier tag (e.g., `v1`, alphanumeric/dash/underscore up to 64 chars). |

### Cloudflare Worker Bindings (wrangler.jsonc)

| Binding | Type | Resource / Name |
| :--- | :--- | :--- |
| `AUTH_RATE_LIMITER` | Rate Limiter | Namespace `731001` (Limit: 20 requests / 60 seconds). |
| `BACKUP_BUCKET` | R2 Bucket | Bucket `gelir-gider-backups`. |

---

## 4. Frontend Domain Dependency & Production Cutover

> [!IMPORTANT]
> `WEBAUTHN_RP_ID` and `WEBAUTHN_ORIGIN` depend on the final production domain of the web frontend (e.g. `https://gelir-gider.example.com`).
> Configuring dummy or fake production origins is prohibited.
> Until the frontend domain is finalized, **FULL PRODUCTION CUTOVER IS DEFERRED**. This does not block backend-core completion or release readiness.

---

## 5. Scheduled Workers (Cron Triggers)

The Worker defines two automated cron triggers in `wrangler.jsonc`:

1. **`0 * * * *` (Hourly at minute 0):**
   Executes automated hourly backup snapshot creation and Web Push notification dispatch.
2. **`0 0 1 * *` (Monthly on the 1st at 00:00 UTC):**
   Executes monthly backup retention cycle and automated month-close verification.

---

## 6. Observability & Auditing

- All API errors are mapped to bounded, typed JSON envelopes without internal stack trace leakage.
- Security-relevant events (authentication failures, invalid origins, rate limit hits) emit structured audit logs with request IDs.
- Fingerprints on all financial entities guarantee tamper-evidence and reproducible integrity verification across revisions.

---

## 7. Migration Immutability Policy

- Existing migrations `0000_...` through `0071_...` are **strictly immutable**.
- Modifying, renaming, or deleting historical migrations is forbidden.
- Any new database changes must be introduced via forward-only additive migrations.

---

## 8. Backup & Restore Procedures

### Automated Backups
- Hourly snapshot creation writes AES-256-GCM encrypted payloads to R2 (`gelir-gider-backups`).
- Retention policy preserves daily/weekly/monthly recovery points according to configured retention tiers.

### Restore Verification
- Restore dry-runs verify cryptographic integrity and manifest checksums without mutating active tables.
- Live restore drills require an isolated, disposable target database.

---

## 9. Security Constraints

1. **Passkey-Only Auth:** No passwords or legacy authentication factors.
2. **Rate Limiting:** IP-level rate limiting on sensitive pre-auth endpoints via Cloudflare Worker bindings.
3. **Session Cookies:** `__Host-` prefix, `Secure`, `HttpOnly`, `SameSite=Strict`.
4. **CSRF Protection:** Same-origin verification on all non-safe HTTP methods.
5. **No Raw Financial Writes:** Accounting effects must always occur through authoritative double-entry transaction lifecycles.

---

## 10. Local Development & Testing

```bash
# Install dependencies
npm ci

# Run test suite
npm test

# Run PostgreSQL integration tests
npm run test:pg

# Format & Lint
npm run check
```

---

## 11. Troubleshooting Common Errors

| Error Code | Potential Cause | Remediation |
| :--- | :--- | :--- |
| `UNAUTHENTICATED` | Missing or expired session cookie | Re-authenticate via passkey login. |
| `INVALID_ORIGIN` | Missing or mismatched `Origin` header | Ensure request originates from configured `WEBAUTHN_ORIGIN`. |
| `TRANSACTION_IDEMPOTENCY_CONFLICT` | Reused `Idempotency-Key` with different body | Use a unique idempotency key for distinct mutation commands. |
| `TRANSACTION_REVISION_CONFLICT` | OCC version mismatch | Refresh entity state to obtain current `expectedRevisionNo`. |
| `LEDGER_UNBALANCED` | Debit/credit sum mismatch | Ensure debits exactly equal credits across all transaction lines. |

---

## 12. Disaster Recovery & Rollback Strategy

1. **Code Rollbacks:** Cloudflare Workers supports instant rollback to prior deployment versions via Worker Versioning / Deployments.
2. **Forward-Only Database Changes:** Because database migrations are forward-compatible and additive, code rollbacks within a release boundary do not require database down-migrations.
3. **Immutable Audited Ledger:** Ledger transactions and revisions are append-only; state corrections are performed via reversing entries, never destructive row mutation.

---

## 13. Same-Origin Architecture (Locked — Checkpoint 7B.0)

The backend is locked to a **single Cloudflare Worker, single origin** architecture:

- One Worker (`gelir-gider-api`) serves both API routes and (future) static frontend assets
- Hono routes (`/auth`, `/budget-v2`, `/transactions`, `/ledger`, and future domain routers) all on the same origin
- **No Vercel/Render adapter; no separate API origin; no permissive CORS**
- Every cookie-authenticated unsafe HTTP method (POST/PUT/PATCH/DELETE) must carry an `Origin` header matching `WEBAUTHN_ORIGIN`
- Safe methods (GET/HEAD/OPTIONS) are untouched by the origin guard
- `SameSite=Strict` on the session cookie provides defence-in-depth against cross-site sends
- The same-origin guard is NOT a CORS mechanism; it adds no `Access-Control-*` headers

The application origin is read from `WEBAUTHN_ORIGIN` config — never hard-coded — preserving local development testability.

---

## 14. Release Status Classification

| Component | Status | Notes |
| :--- | :--- | :--- |
| **BACKEND CORE** | **READY** | All domain calculations, invariants, and tests passing (2218 tests). |
| **FINANCIAL DOMAIN SERVICES** | **READY** | Implemented as internal TypeScript domain services (see 7B.0 inventory). |
| **DATABASE MIGRATIONS** | **READY through 0071** | 72 migration files verified and immutable. |
| **AUTH CORE** | **READY** | WebAuthn / Passkey, session cookies, rate limiter, recovery. |
| **SCHEDULED NOTIFICATIONS** | **READY** | Push notification queue and VAPID transport. |
| **BACKUP / RESTORE CODE** | **READY** | AES-256-GCM streaming encryption and retention logic. |
| **HTTP TRANSPORT HELPERS** | **READY** | Shared transport layer (7B.0): UUID, instant, idempotency, origin guard. |
| **AUTH HTTP ADAPTER** | **READY** | `/auth/*` routes complete and tested. |
| **BUDGET V2 HTTP ADAPTER** | **READY** | `/budget-v2/*` routes complete, CSRF-guarded, and tested. |
| **TRANSACTIONS & LEDGER HTTP ADAPTER** | **READY (Checkpoint 7B.1)** | `/transactions/*` and `/ledger/*` routes complete, tested, and guarded. |
| **FINANCIAL HTTP PRODUCT SURFACE** | **IN PROGRESS** | Domain services exist; HTTP adapters for income/credit-cards/people/rewards/campaigns/short-term-goals/midas/long-term/month-close/notifications/imports being built in 7B.2–7B.9. |
| **PRE-FRONTEND BACKEND CODE FREEZE** | **NOT YET COMPLETE** | In progress under Checkpoint 7B (7B.2–7B.9 financial HTTP surface). |
| **LIVE R2 DRILL** | **BLOCKED — TEST BUCKET UNAVAILABLE** | Unit & mock tests green; live drill deferred. |
| **LIVE RESTORE DRILL** | **BLOCKED — DISPOSABLE DATABASE UNAVAILABLE** | Restore logic verified with empty-target checks. |
| **FINAL FRONTEND DOMAIN / WEBAUTHN ORIGIN** | **DEFERRED** | Awaiting production web frontend provisioning. |
| **FULL APPLICATION PRODUCTION CUTOVER** | **DEFERRED** | Deferred pending frontend domain & integration. |
