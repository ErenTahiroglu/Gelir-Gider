# Gelir-Gider Backend

Private, single-user personal finance backend built for high-integrity ledger accounting, automated tracking, and passkey authentication on Cloudflare Workers and Neon PostgreSQL.

## Architecture & Technology Stack

- **Runtime:** Cloudflare Workers (V8 Edge Runtime)
- **Language & Framework:** TypeScript (Strict mode, ES2022) with Hono
- **Database:** Neon Serverless PostgreSQL with Drizzle ORM
- **Accounting Engine:** Double-entry general ledger with immutable journal entries, `NUMERIC(18,2)` precision, and database-level trigger invariants
- **Authentication:** WebAuthn / Passkey authentication (FIDO2/WebAuthn standard) with single-user bootstrap and emergency recovery codes
- **Observability:** Structured JSON operational logging (`HTTP_REQUEST_COMPLETED`, `HTTP_REQUEST_FAILED`, `READINESS_FAILED`, `BACKUP_COMPLETED`, etc.) with global Request ID tracking and security headers
- **Scheduled Workers (Cron):**
  - `0 * * * *` (Hourly): Notification scheduler and push delivery via Web Push (VAPID)
  - `17 2 * * *` (Daily): Automated encrypted database snapshot to Cloudflare R2 with retention management
- **Testing & Quality:** Vitest + `@cloudflare/vitest-plugin` (137 test suites, 1740+ unit and contract tests), Biome linter/formatter, TypeScript strict mode

## Implemented Domains & Modules

1. **Double-Entry General Ledger:** Chart of accounts, journal entries, balanced multi-currency lines, balance calculation, locking invariants.
2. **Income & Entitlements:** Income sources, monthly entitlements, receipts, and settlement batching.
3. **Monthly Budget Plans:** Envelope-style category allocations, spending tracking, policy enforcement, and variance calculations.
4. **Midas Investment Integration:** Stock/ETF portfolio ledger tracking, singleton bucket contracts, and allocation transfers.
5. **Short-Term Goals:** Goal tracking, target amounts, priority revisions, and funding allocations.
6. **Credit Cards & Statements:** Multi-card management, billing cycle statements, payments, liability events, and shared purchase splits across participants.
7. **People & Family Obligations:** Debts, receivables, advances, expenses, and bilateral/partial settlements with automated ledger reconciliation.
8. **Rewards & Points:** Reward accounts, point accruals, redemptions, and valuation accounting.
9. **Long-Term Sends & Scheduled Tasks:** Scheduled transfer tasks, calendar projection, execution records, and state transitions.
10. **Month Close & Financial Reporting:** Formal accounting period close, unclassified transaction reviews, balance freezes, and variance rollups.
11. **Notifications & Alerts:** Notification event queue, delivery planning, push subscription management, and VAPID payload delivery.
12. **Campaigns & Merchant Tracking:** Card/bank merchant campaigns, spending thresholds, review candidates, reward credits, and family tracking.
13. **Bank/Statement CSV Imports:** Raw file parsing, duplicate candidate detection, external identity claims, mutation receipts, and batch ingestion.
14. **Encrypted Backups & Disaster Recovery:** AES-256-GCM envelope encryption, streaming R2 backup upload, retention cleanup, and safe restore tooling with empty-target protection.
15. **WebAuthn Passkey Authentication:** Single-user authentication, challenge generation, credential management, rate limiting, and session cookie lifecycle.

## Current Backend Status

- **Backend Core (Phases 0–20):** **100% COMPLETE & RELEASE-READY**.
- **Database Migrations:** Migrations `0000` through `0060` are complete, audited, and immutable.
- **Financial HTTP Adapters:** Intentionally deferred to frontend integration. All financial domain services are fully implemented and tested as internal TypeScript domain services, ready to be mounted behind authentication middleware when frontend UI requirements are finalized.
- **Production Deployment:** Full end-to-end production cutover is deferred until the production frontend domain and WebAuthn RP ID are configured.

## Prerequisites

- Node.js (>= 20.0.0, Node 22 LTS recommended)
- npm (>= 10.0.0)

## Quick Start & Installation

```bash
# Clean install dependencies
npm ci

# Generate Cloudflare Worker types
npm run cf-typegen
```

## Development & Local Testing

```bash
# Start local Cloudflare Worker development server
npm run dev

# Run comprehensive quality checks (typecheck, lint, format, test)
npm run check
```

## Quality Gates & Scripts

- **Full Suite Gate:** `npm run check` (runs typegen, typecheck, lint, format check, and all test suites)
- **Unit & Contract Tests:** `npm test`
- **Type Checking:** `npm run typecheck`
- **Linting:** `npm run lint`
- **Format Checking:** `npm run format:check`
- **Format Auto-Fix:** `npm run format`
- **Worker Dry-Run:** `npx wrangler deploy --dry-run`
- **Schema Drift Check:** `npx drizzle-kit generate`

## Documentation

- [Backend Production Runbook](docs/BACKEND_PRODUCTION_RUNBOOK.md) — Operational procedures, secret inventory, backup/restore safety, and release gates.
