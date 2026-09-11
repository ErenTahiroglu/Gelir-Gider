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
   Runs `cf-typegen`, `typecheck`, `lint`, `format:check`, and `test` (171 test suites, 2205+ tests).

2. **PostgreSQL Runtime Verification (PGlite):**
   ```bash
   npm run test:pg
   ```
   Runs the complete disposable PGlite migration chain (0000–0071) and all domain runtime
   regression suites including the 7B.0 correctness and 7B.1-R1 transaction/ledger read models. This is a
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

| Variable | Type | Secret? | Description / Requirements |
| :--- | :--- | :--- | :--- |
| `DATABASE_URL` | String | **YES** | PostgreSQL connection string (Neon pooler/direct connection, `sslmode=require`). Format: `postgresql://...` |
| `WEBAUTHN_RP_ID` | String | No | Relying Party ID for WebAuthn passkey operations (domain name, e.g., `gelir-gider.app` or `localhost`). |
| `WEBAUTHN_RP_NAME` | String | No | Human-readable Relying Party Name (e.g., `Gelir Gider`). |
| `WEBAUTHN_ORIGIN` | String | No | Authorized origin for WebAuthn ceremony and Same-Origin CSRF guard (e.g., `https://gelir-gider.app` or `http://localhost:8787`). |
| `BOOTSTRAP_TOKEN_HASH` | String | **YES** | Hex-encoded SHA-256 hash of single-use bootstrap administrative token for passkey enrollment (64 lowercase hex characters). |
| `WEB_PUSH_VAPID_SUBJECT` | String | No | Web Push VAPID contact URI (required when push delivery is used; trimmed non-empty `mailto:<address>` or `https://...` URL). |
| `WEB_PUSH_VAPID_PUBLIC_KEY` | String | No | 65-byte uncompressed P-256 public key (strict unpadded base64url). |
| `WEB_PUSH_VAPID_PRIVATE_KEY` | String | **YES** | 32-byte P-256 private scalar (strict unpadded base64url). |
| `BACKUP_ENCRYPTION_KEY` | String | **YES** | 32-byte AES-256-GCM symmetric encryption key (strict unpadded base64url). |
| `BACKUP_ENCRYPTION_KEY_ID` | String | No | Optional key generation identifier tag (defaults to `v1`; 1–64 chars, letters/digits/underscore/hyphen only). |
| `AUTH_RATE_LIMITER` | Binding | No | Cloudflare Worker Rate Limiter binding for authentication routes. |
| `BACKUP_BUCKET` | Binding | No | Cloudflare R2 bucket binding mapped to `gelir-gider-backups`. |

---

## 4. Production Deployment Procedure

### Cloudflare Worker Deployment
```bash
# 1. Verify secrets are populated in target environment
npx wrangler secret list

# 2. Deploy Worker
npx wrangler deploy
```

---

## 5. Scheduled Workers (Cron Triggers)

The Worker defines two automated cron triggers in `wrangler.jsonc` and `src/index.ts`:

1. **`0 * * * *` (Hourly at minute 0):**
   - **Notification Scheduler:** Evaluates notification events, builds delivery plans, and delivers Web Push payloads via VAPID.
   - **Budget V2 Pending Checkpoint Processor:** Discovers and persists pending Budget V2 checkpoints independently.
   - Failure boundary: Sanitized; never leaks secrets or payloads into logs.

2. **`17 2 * * *` (Daily at 02:17 UTC):**
   - **Encrypted Database Backup:** Dumps database tables, encrypts payload using AES-256-GCM with `BACKUP_ENCRYPTION_KEY`, uploads to `BACKUP_BUCKET` in R2, records status, and triggers retention cleanup for completed snapshots.

---

## 6. Endpoints: `/health` vs `/ready`

- **`GET /health`:**
  - Fast, stateless liveness check.
  - Returns `200 OK` (`{"status":"ok","service":"gelir-gider-api"}`) without connecting to the database or reading secrets.
  - Used for edge routing health checks and process monitoring.

- **`GET /ready`:**
  - Deep readiness check.
  - Attempts a live `SELECT 1` query to Neon PostgreSQL via `DATABASE_URL`.
  - On success: Returns `200 OK` (`{"status":"ready"}`).
  - On failure: Returns `503 Service Unavailable` (`{"status":"not_ready"}`) and logs a sanitized `READINESS_FAILED` event internally without leaking connection parameters, hostnames, or credentials.

---

## 7. Database Migration Procedure

1. **Immutability:**
   - Migrations `0000` through `0071` are strictly immutable.
   - Any new database changes must be added forward-only as new sequential migration files (e.g., `0072_...sql`).

2. **Application Flow:**
   - Execute migration runner or apply migrations against target PostgreSQL instance.
   - Always verify journal integrity: `_journal.json` version, sequence indices, and timestamps must match migration files.
   - Execute schema drift check to confirm zero discrepancies between Drizzle schema definitions and migrations:
     ```bash
     DATABASE_URL="postgres://dummy:dummy@localhost:5432/dummy" npx drizzle-kit generate
     ```

---

## 8. Backup Encryption & Custody

- Backups are encrypted at rest using authenticated symmetric encryption (**AES-256-GCM**).
- `BACKUP_ENCRYPTION_KEY` is a 32-byte cryptographic key stored independently in Cloudflare Worker secrets and operator offline storage. It is **never** stored in the database or in R2.
- Backup envelopes include an unencrypted header containing `keyId`, `iv`, `authTag`, `createdAt`, and `schemaVersion`.
- **Key Rotation:** When generating a new key, update `BACKUP_ENCRYPTION_KEY` and set `BACKUP_ENCRYPTION_KEY_ID` to the new version (e.g., `v2`). Historical backups remain decryptable using their respective historical keys stored in operator key custody.

---

## 9. Disaster Recovery & Restore Safety Principles

> [!CAUTION]
> **RESTORE SAFETY RULES:**
> 1. **Never restore over an active production database.**
> 2. **Always test restore on a disposable database target first.**
> 3. The restore utility enforces `--confirm-empty-target`. It will refuse to execute if the target database contains existing tables or active data unless explicitly configured and verified empty.

Restore Flow:
1. Provision a clean, empty disposable PostgreSQL instance.
2. Fetch encrypted backup object from R2.
3. Decrypt snapshot using the key matching the backup's `keyId`.
4. Verify checksum, table schemas, and record count.
5. Ingest snapshot into target database.
6. Verify ledger balance consistency and invariant triggers.

---

## 10. Bootstrap & Passkey Registration Flow

1. Operator generates a high-entropy single-use bootstrap secret: `BOOTSTRAP_TOKEN`.
2. Compute `BOOTSTRAP_TOKEN_HASH = SHA256(BOOTSTRAP_TOKEN)`.
3. Set `BOOTSTRAP_TOKEN_HASH` in Worker secrets.
4. Client sends bootstrap request to `/auth/bootstrap` with `BOOTSTRAP_TOKEN`.
5. Backend verifies constant-time hash equality, establishes single-user record if not present, and issues a short-lived `ENROLLMENT_GRANT`.
6. Client invokes WebAuthn passkey registration (`/auth/passkey/register/options` and `/auth/passkey/register/verify`).
7. Backend stores public key credential and issues backup recovery codes.

---

## 11. Credential Rotation Procedures

1. **Database Password Rotation (Neon):**
   - Generate new role password in Neon Console.
   - Update `DATABASE_URL` in Cloudflare Worker secrets.
   - Verify `/ready` returns `200 OK`.
   - Revoke old password.

2. **Web Push VAPID Key Rotation:**
   - Generate new P-256 key pair.
   - Update `WEB_PUSH_VAPID_PUBLIC_KEY` and `WEB_PUSH_VAPID_PRIVATE_KEY` secrets.
   - Update `WEB_PUSH_VAPID_SUBJECT` contact URI if needed.
   - Notify client for push subscription refresh.

3. **Backup Encryption Key Rotation:**
   - Generate new 32-byte base64url key.
   - Update `BACKUP_ENCRYPTION_KEY` and bump `BACKUP_ENCRYPTION_KEY_ID`.
   - Next scheduled backup will automatically use the new key generation.

---

## 12. Release Rollback Principles

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
| **BACKEND CORE** | **READY** | All domain calculations, invariants, and tests passing (2205 tests). |
| **FINANCIAL DOMAIN SERVICES** | **READY** | Implemented as internal TypeScript domain services (see 7B.0 inventory). |
| **DATABASE MIGRATIONS** | **READY through 0071** | 72 migration files verified and immutable. |
| **AUTH CORE** | **READY** | WebAuthn / Passkey, session cookies, rate limiter, recovery. |
| **SCHEDULED NOTIFICATIONS** | **READY** | Push notification queue and VAPID transport (`0 * * * *`). |
| **SCHEDULED BUDGET CHECKPOINTS** | **READY** | Pending Budget V2 checkpoint processor (`0 * * * *`). |
| **BACKUP / RESTORE CODE** | **READY** | AES-256-GCM streaming encryption and retention logic (`17 2 * * *`). |
| **HTTP TRANSPORT HELPERS** | **READY** | Shared transport layer (7B.0): UUID, instant, idempotency, origin guard. |
| **AUTH HTTP ADAPTER** | **READY** | `/auth/*` routes complete and tested. |
| **BUDGET V2 HTTP ADAPTER** | **READY** | `/budget-v2/*` routes complete, CSRF-guarded, and tested. |
| **TRANSACTIONS & LEDGER READ HTTP ADAPTER** | **READY (Checkpoint 7B.1-R1)** | `/transactions` and `/ledger` read-only HTTP endpoints complete, tested, and guarded. Generic mutation routes remain unexposed to prevent domain bypass. |
| **FINANCIAL HTTP PRODUCT SURFACE** | **IN PROGRESS** | Domain services exist; HTTP adapters for income/credit-cards/people/rewards/campaigns/short-term-goals/midas/long-term/month-close/notifications/imports being built in 7B.2–7B.9. |
| **PRE-FRONTEND BACKEND CODE FREEZE** | **NOT YET COMPLETE** | In progress under Checkpoint 7B (7B.2–7B.9 financial HTTP surface). |
| **LIVE R2 DRILL** | **BLOCKED — TEST BUCKET UNAVAILABLE** | Unit & mock tests green; live drill deferred. |
| **LIVE RESTORE DRILL** | **BLOCKED — DISPOSABLE DATABASE UNAVAILABLE** | Restore logic verified with empty-target checks. |
| **FINAL FRONTEND DOMAIN / WEBAUTHN ORIGIN** | **DEFERRED** | Awaiting production web frontend provisioning. |
| **FULL APPLICATION PRODUCTION CUTOVER** | **DEFERRED** | Deferred pending frontend domain & integration. |
