# GELİR-GİDER — FRONTEND IMPLEMENTATION PLAN

**Document Version:** `1.0.0-AUTHORITATIVE`  
**Status:** `LOCKED & APPROVED FOR EXECUTION`  
**Authoritative Backend SHA:** `9ed53f63461e5cf0ccf590a657d0fe5d00e8f312`  
**Methodology:** Phase-Gated Incremental Delivery (No Circular Hardening Loops)  

---

## 1. Execution Architecture & Freeze Protocol

To prevent endless audit and hardening loops, frontend development follows a strict **linear gating protocol**:

```text
┌─────────────────────────────────────────────────────────────┐
│ 1. Phase Implementation (Components, API, Layout)           │
│                            │                                │
│                            ▼                                │
│ 2. Phase Acceptance Testing (Unit, Component, Integration)  │
│                            │                                │
│                            ▼                                │
│ 3. Responsive Smoke Verification (Honor 90 & macOS Desktop) │
│                            │                                │
│                            ▼                                │
│ 4. PHASE FREEZE (No arbitrary refactoring; lock & proceed)  │
└─────────────────────────────────────────────────────────────┘
```

A closed phase is **never reopened** unless an explicit regression is reproduced by an automated test.

---

## 2. Phase Dependency Graph

```text
[F0: Foundation & Tokens]
           │
           ▼
[F1: Auth & Passkey App Lock]
           │
           ▼
[F2: Dashboard & Budget V2 Hero]
           │
     ┌─────┴─────────────────────┐
     ▼                           ▼
[F3: Transactions & Manual]  [F5: Credit Cards OS]
     │                           │
     ▼                           ▼
[F4: Quick Entry FAB]        [F6: People & Waterfall]
     │                           │
     └─────────────┬─────────────┘
                   ▼
[F7: Goals, Midas & Long-Term]
                   │
                   ▼
[F8: Income & Month Close Wizard]
                   │
                   ▼
[F9: CSV Imports & Notifications]
                   │
                   ▼
[F10: PWA, Responsive Polish & Release Freeze]
```

---

## 3. Phase Specifications

---

### Phase F0: Frontend Foundation, Design Tokens & Tooling

- **Goal:** Establish the Vite + React 19 + TypeScript frontend project structure, configure Vanilla CSS design tokens, set up test runners, and configure Cloudflare Worker static asset serving.
- **Deliverables:**
  - `package.json` scripts: `npm run dev`, `npm run build`, `npm run test:ui`.
  - `vite.config.ts`: Configured with React plugin and path aliases (`@/`).
  - `wrangler.jsonc` update: Add `assets: { directory: "./dist" }` binding.
  - `src/styles/tokens.css`: All CSS custom properties (colors, surfaces, typography, radii, spacing, z-index).
  - `src/styles/reset.css` & `src/styles/global.css`: Tabular nums, focus rings, base styles.
  - Setup Vitest and React Testing Library.
- **Acceptance Criteria:**
  1. `npm run build` generates clean output in `dist/`.
  2. `tsc --noEmit` and Biome format/check pass with zero errors.
  3. Tokens correctly switch between light and dark modes via `[data-theme="dark"]`.
- **Explicit Out-of-Scope:** Any UI views or API network requests.

---

### Phase F1: Same-Origin API Client, Authentication & Passkey App Lock

- **Goal:** Build the strongly typed same-origin API transport client and complete the WebAuthn passkey authentication and biometric app lock experience.
- **Screens:**
  - `/unlock`: Biometric passkey unlock screen with clean, distraction-free branding.
  - Locked Overlay: Inactivity / background lock modal with "Kilidi Aç" button.
  - First-time enrollment modal: Passkey registration dialog.
- **API Contracts:**
  - `GET /auth/status`: Check bootstrapping.
  - `GET /auth/session`: Active session check (`authenticated: boolean, user: { displayName }`).
  - `POST /auth/passkey/authentication/options`: Fetch WebAuthn auth challenge.
  - `POST /auth/passkey/authentication/verify`: Verify credential and establish cookie.
  - `POST /auth/passkey/reauth/options`: Fetch step-up reauth challenge (purpose `REAUTH`).
  - `POST /auth/passkey/reauth/verify`: Verify biometric assertion without cookie modification.
  - `POST /auth/logout`: Revoke session and clear session state.
- **Components:**
  - `src/api/client.ts`: Fetch wrapper with automatic `Origin` header and error envelope unwrapping.
  - `src/components/domain/auth/UnlockScreen.tsx`.
  - `src/components/domain/auth/AppLockBoundary.tsx` (listens to visibility change and 120s timer).
- **Tests:**
  - Unit tests for API client error envelope unwrapping and 401 interceptor.
  - Component test for `AppLockBoundary` triggering lock after 2 minutes of backgrounding.
- **Acceptance Criteria:**
  1. Cold launch prompts for Passkey verification.
  2. Successful verification displays authenticated application.
  3. Switching tabs/backgrounding for $\ge 2$ minutes triggers lock screen.
  4. Step-up unlock calls `/auth/passkey/reauth/*` and unlocks UI without resetting session.

---

### Phase F2: App Shell, Dashboard & Budget V2 Hero Read Model (Fail-Closed)

- **Goal:** Implement responsive App Shell (Mobile bottom bar + Desktop sidebar) and render the primary Dashboard with the authoritative Budget V2 hero spend metric adhering strictly to fail-closed semantics.
- **Screens:**
  - `/`: Ana Sayfa (Dashboard).
- **API Contracts:**
  - `GET /budget-v2/checkpoints`: Retrieve checkpoint timeline.
  - `GET /budget-v2/checkpoints/:paymentEventId/decision-center`: Retrieve verified Decision Center view (`availableToAllocateNow`, `spending`, `budget`, `emergencyFund`).
  - `GET /credit-cards`: Retrieve active credit cards and live liabilities for summary pills.
- **Components:**
  - `src/components/composed/MobileNav.tsx`: 5-Tab bar with elevated `+` button.
  - `src/components/composed/DesktopSidebar.tsx`: Collapsible sidebar (`260px` / `72px`).
  - `src/components/composed/TopBar.tsx`: Period selector, notification bell, lock button.
  - `src/components/domain/dashboard/HeroAvailableSpend.tsx`: Hero display with exact amount and fail-closed unavailable state.
  - `src/components/domain/dashboard/SummaryPills.tsx`: Bu Ay Harcanan, Kartlar, Yaklaşan Ödeme.
  - `src/components/domain/dashboard/QuickTemplatesStrip.tsx`: Horizontal chips for top templates.
- **Tests:**
  - Component test verifying `HeroAvailableSpend` renders exact `amount` with label `"Bu Ay Kullanılabilir Tutar"` when `available: true`.
  - Fail-closed test verifying `HeroAvailableSpend` renders headline `"Kullanılabilir tutar henüz kesinleşmedi"` with actionable recovery link when `available: false`, asserting that `0 TL`, `trueSurplus`, and calculated estimates are NEVER rendered.
  - Test verifying raw internal reason codes (`SURPLUS_USE_ATTRIBUTION_INCOMPLETE`, `SURPLUS_USE_ATTRIBUTION_OVERLAP_UNRESOLVED`) are never displayed directly.
  - Responsive test verifying bottom nav visible on mobile, sidebar visible on desktop.
- **Acceptance Criteria:**
  1. Dashboard loads and renders hero spend within 800ms.
  2. Hero component strictly complies with fail-closed semantics (exact `amount` when available; clear recovery guidance when unconfirmed).
  3. Numbers display tabular numerals with Turkish currency formatting (`tr-TR`).
  4. Mobile viewport (390px) shows edge-to-edge cards; desktop (1440px) shows 3-column layout.

---

### Phase F3: Transactions & Manual Expense Entry

- **Goal:** Deliver chronological transaction timeline, transaction detail drawer, and full double-entry manual expense management (cash & bank spending).
- **Screens:**
  - `/transactions`: Hareketler (Timeline list on mobile, table on desktop).
  - `/transactions/:id`: Transaction detail sheet with void action.
  - `/manual-expenses/new`: Manual expense entry form.
  - `/manual-expenses/:id/edit`: Manual expense revision form.
- **API Contracts:**
  - `GET /transactions`: Keyset-paginated list of canonical transactions.
  - `GET /transactions/:id`: Single transaction detail.
  - `GET /transactions/:id/revisions`: Audit history.
  - `GET /manual-expenses`: List manual expenses.
  - `POST /manual-expenses`: Create cash/bank expense (`Idempotency-Key` required).
  - `POST /manual-expenses/:id`: Update manual expense (`expectedRevisionNo` required).
  - `POST /manual-expenses/:id/void`: Void manual expense (`expectedRevisionNo` required).
  - `GET /ledger/accounts`: Fetch active asset accounts for source selection.
  - `GET /spending/categories`: Fetch user spending categories.
- **Components:**
  - `src/components/domain/transactions/TransactionList.tsx`.
  - `src/components/domain/transactions/TransactionTable.tsx`.
  - `src/components/domain/transactions/TransactionDetailDrawer.tsx`.
  - `src/components/domain/manual-expenses/ManualExpenseForm.tsx`.
  - `src/components/primitives/MoneyInput.tsx`.
- **Tests:**
  - Form validation test for required amount, asset account, and classification.
  - Idempotency key attachment test on POST `/manual-expenses`.
  - Void mutation test confirming transaction state transitions to `VOIDED`.
- **Acceptance Criteria:**
  1. Manual expense records immediately appear on timeline upon creation.
  2. Transaction list supports infinite scrolling / keyset pagination.
  3. Voiding an expense visually reflects reversing entry and updates available budget.

---

### Phase F4: Quick Entry FAB & Server-Synced Templates

- **Goal:** Implement persistent mobile `+` action, template selector bottom sheet, and rapid 3-tap transaction execution.
- **Screens:**
  - Quick Entry Bottom Sheet (accessible from anywhere on mobile via FAB).
  - `/settings/quick-templates`: Template management screen (CRUD).
- **API Contracts:**
  - `GET /quick-entry/templates`: List server-synced templates.
  - `POST /quick-entry/templates`: Create new template blueprint.
  - `POST /quick-entry/templates/:id`: Update template.
  - `POST /quick-entry/templates/:id/archive`: Archive template.
  - `POST /credit-cards/:cardId/purchases`: Canonical target for CC expense template.
  - `POST /manual-expenses`: Canonical target for manual expense template.
- **Components:**
  - `src/components/domain/quick-entry/QuickEntryFab.tsx`.
  - `src/components/domain/quick-entry/QuickEntrySheet.tsx`.
  - `src/components/domain/quick-entry/TemplateCard.tsx`.
- **Tests:**
  - Flow test: Tapping template chip pre-fills form, focuses amount, submits canonical mutation.
  - Server sync test verifying templates created on desktop appear immediately on mobile.
- **Acceptance Criteria:**
  1. Tapping FAB opens sheet in $< 100\text{ ms}$.
  2. Recording an expense via template requires $\le 3$ taps total.
  3. Templates are strictly blueprints; execution calls canonical domain endpoints.

---

### Phase F5: Credit Cards OS (Cards, Statements, Payments & Splits)

- **Goal:** Build the complete Credit Cards management system: statement lifecycles, payment-readiness, one-tap statement payments, unshared purchases, and shared purchase splits.
- **Screens:**
  - `/cards`: Multi-card overview with statement status & readiness badges.
  - `/cards/:cardId`: Single card detail & statement timeline.
  - `/cards/:cardId/statements/:id`: Statement detail & payment execution screen.
  - `/cards/:cardId/purchases/new`: Purchase entry with optional split calculator.
  - `/cards/:cardId/purchases/:id/split`: Split management & participant assignment.
- **API Contracts:**
  - `GET /credit-cards`: List cards and live liability balances.
  - `POST /credit-cards`: Create card (`Idempotency-Key` required).
  - `GET /credit-cards/:cardId/statements`: List statements.
  - `POST /credit-cards/:cardId/statements`: Create statement.
  - `GET /credit-cards/:cardId/statements/:id/readiness`: Payment-readiness calculation.
  - `POST /credit-cards/:cardId/statements/:id/pay`: Pay statement (`Idempotency-Key` required).
  - `POST /credit-cards/:cardId/statements/:id/reopen`: Reopen statement.
  - `POST /credit-cards/:cardId/purchases`: Record purchase.
  - `POST /credit-cards/:cardId/purchases/shared`: Atomically create purchase and participant split.
  - `GET /credit-cards/:cardId/purchases/:purchaseId/split`: Read split details.
- **Components:**
  - `src/components/domain/cards/CreditCardCarousel.tsx`.
  - `src/components/domain/cards/StatementCard.tsx`.
  - `src/components/domain/cards/PaymentReadinessBadge.tsx`.
  - `src/components/domain/cards/PayStatementModal.tsx`.
  - `src/components/domain/cards/PurchaseSplitCalculator.tsx`.
- **Tests:**
  - Payment-readiness badge renders `READY` when reserve covers statement, `SHORTFALL` otherwise.
  - Statement pay mutation correctly invalidates card balances and budget state.
  - Split calculator verifies sum of participant shares equals total purchase amount.
- **Acceptance Criteria:**
  1. Card balances and due dates clearly visible at a glance.
  2. One-tap statement payment completes smoothly with loading indicator and confirmation.
  3. Shared purchases automatically assign counterpart receivables to the People domain.

---

### Phase F6: People, Receivables & Waterfall Settlement

- **Goal:** Implement interpersonal debt tracking, FRIEND 5 TL ceiling display, FAMILY exact balance, and multi-obligation settlement with excess waterfall feedback.
- **Screens:**
  - `/people`: Counterparts list with net balance summaries.
  - `/people/:personId`: Person detail, obligation ledger, and payment history.
  - `/people/:personId/settle`: Settle payment wizard with live excess simulation.
- **API Contracts:**
  - `GET /people`: List people.
  - `POST /people`: Create person (`Idempotency-Key` required).
  - `GET /people/:personId/balance-summary`: Retrieve net balance and `collectionTarget` (friend ceiling).
  - `GET /people/:personId/obligations`: List obligations (`direction=RECEIVABLE|PAYABLE`).
  - `POST /people/:personId/obligations/receivable`: Record lent money.
  - `POST /people/:personId/obligations/payable`: Record borrowed money.
  - `POST /people/:personId/settle-receivables`: Execute multi-obligation waterfall settlement.
- **Components:**
  - `src/components/domain/people/PersonList.tsx`.
  - `src/components/domain/people/PersonBalanceSummaryCard.tsx`.
  - `src/components/domain/people/ObligationItem.tsx`.
  - `src/components/domain/people/SettlePaymentModal.tsx`.
  - `src/components/domain/people/WaterfallFeedbackAlert.tsx`.
- **Tests:**
  - Test verifying `collectionTarget` renders next 5 TL ceiling for `FRIEND` (e.g. 42.10 → 45.00 TL) and exact amount for `FAMILY`.
  - Test verifying overpayment settlement surfaces exact routing breakdown (Kart Rezervi, Goal, Long-Term).
- **Acceptance Criteria:**
  1. Zero accounting jargon on all screens.
  2. Settlement modal provides natural language summary of excess distribution upon completion.

---

### Phase F7: Short-Term Goals, Midas Kart Rezervi & Long-Term Tasks

- **Goal:** Implement goal saving progress cards, priority reordering, Midas liquidity pool visualization, and Long-Term virtual send tasks.
- **Screens:**
  - `/goals`: Active, completed, and cancelled goals with progress bars.
  - `/goals/:id`: Goal detail with fund/release actions.
  - `/midas`: Midas liquidity & bucket earmarks (Kart Rezervi, Goals, Unallocated).
  - `/long-term`: Long-term investment tasks queue (PENDING, SENT, CANCELLED).
- **API Contracts:**
  - `GET /short-term-goals`: List goals with progress metrics.
  - `POST /short-term-goals`: Create goal.
  - `POST /short-term-goals/:id`: Update goal target.
  - `POST /short-term-goals/reorder`: Update priority order.
  - `POST /short-term-goals/:id/fund`: Allocate funds from unallocated Midas pool.
  - `POST /short-term-goals/:id/release`: Release funds back to unallocated pool.
  - `GET /midas/liquidity`: Read physical, earmarked, and unallocated balances.
  - `POST /midas/transfers`: Internal bucket-to-bucket transfer.
  - `GET /long-term/tasks`: List investment send tasks.
  - `POST /long-term/tasks`: Create send task.
  - `POST /long-term/tasks/:id/mark-sent`: Mark sent and record ledger movement.
  - `POST /long-term/tasks/:id/cancel`: Cancel task and refund unallocated pool.
- **Components:**
  - `src/components/domain/goals/GoalCard.tsx`.
  - `src/components/domain/goals/GoalPriorityStepper.tsx`.
  - `src/components/domain/midas/LiquidityPoolOverview.tsx`.
  - `src/components/domain/long-term/LongTermTaskCard.tsx`.
- **Tests:**
  - Funding modal prevents allocating more than available unallocated Midas balance.
  - Priority reordering preserves continuous 1-based integer sequence.
  - Goal completion blocked if bucket holds non-zero balance.
- **Acceptance Criteria:**
  1. Clear visual separation between Kart Rezervi, Goals, and Long-Term.
  2. Mark-sent action transitions task to SENT and displays confirmation.

---

### Phase F8: Income Management & Month Close Wizard (Ayı Tamamla)

- **Goal:** Implement income source tracking, monthly entitlements, cash receipts, and the 5-step guided Month Close wizard.
- **Screens:**
  - `/income`: Income sources, expected entitlements, and realized receipts.
  - `/month-close`: Historical closed months timeline.
  - `/month-close/wizard`: The 5-step "Ayı Tamamla" modal wizard.
- **API Contracts:**
  - `GET /income/sources`: List income sources.
  - `GET /income/entitlements`: List monthly entitlements.
  - `POST /income/receipts`: Record realized cash receipt.
  - `GET /income/reference`: Fetch baseline reference income.
  - `GET /month-close/preview?periodMonth=YYYY-MM`: Fetch proposal preview with `blockedReason`.
  - `POST /month-close`: Apply month close decision (`FULL`, `PARTIAL`, `SKIP`) with `expectedProposalFingerprint`.
  - `GET /month-close`: List past month closes.
- **Components:**
  - `src/components/domain/income/IncomeReceiptForm.tsx`.
  - `src/components/domain/month-close/MonthCloseWizard.tsx`.
  - `src/components/domain/month-close/Step1PeriodCheck.tsx`.
  - `src/components/domain/month-close/Step2UnclassifiedReview.tsx`.
  - `src/components/domain/month-close/Step3ObligationCheck.tsx`.
  - `src/components/domain/month-close/Step4SurplusRouting.tsx`.
  - `src/components/domain/month-close/Step5CommitSummary.tsx`.
- **Tests:**
  - Wizard correctly blocks progress and presents remediation when `MONTH_CLOSE_UNCLASSIFIED_EXPENSES` occurs.
  - Wizard displays proposed goal surplus routing and submits `FULL`, `PARTIAL`, or `SKIP` with proposal fingerprint.
  - Replay of identical `POST /month-close` returns 200 idempotent replay without errors.
- **Acceptance Criteria:**
  1. Anxiety-free, guided month close experience.
  2. Clear feedback on whether month is ready to close or requires remediation.

---

### Phase F9: Batch CSV Imports & Notification Center

- **Goal:** Implement drag-and-drop CSV statement imports with duplicate detection and background chunk application, along with Web Push subscription management.
- **Screens:**
  - `/imports`: Import history, upload dropzone, and staged batch preview.
  - `/imports/:batchId/review`: Row candidate resolver drawer.
  - `/notifications`: In-app notification center and push settings.
- **API Contracts:**
  - `GET /imports/batches`: List past batches.
  - `POST /imports/batches`: Stage CSV batch (`sourceKind: "GENERIC_CSV_V1"` with `sourceContent`).
  - `GET /imports/batches/:id/preview`: Read staged summary and 25-row sample.
  - `POST /imports/batches/:batchId/rows/:rowId/resolve`: Resolve duplicate or mapping conflict.
  - `POST /imports/batches/:id/apply?limit=50`: Apply ready rows in sequential chunks.
  - `POST /notifications/subscriptions`: Register web-push subscription.
  - `GET /notifications/events`: Read privacy-safe notification history.
- **Components:**
  - `src/components/domain/imports/CsvDropzone.tsx`.
  - `src/components/domain/imports/ImportBatchSummaryView.tsx`.
  - `src/components/domain/imports/ImportRowResolverDrawer.tsx`.
  - `src/components/domain/imports/ChunkApplyProgressBar.tsx`.
  - `src/components/domain/notifications/NotificationBell.tsx`.
  - `src/components/domain/notifications/NotificationCenterDrawer.tsx`.
- **Tests:**
  - Chunk apply loop test verifying frontend continues calling `apply` until `hasMore: false`.
  - Web Push test ensuring no financial figures are present in push notifications.
- **Acceptance Criteria:**
  1. CSV import handles 1,000+ rows smoothly without UI freeze.
  2. All chunking complexity hidden from the user.

---

### Phase F10: PWA Assets, Responsive Polish, E2E Smoke & Production Freeze

- **Goal:** Finalize service worker caching, app manifest, install prompts, full keyboard accessibility, responsive verification on Honor 90 and macOS, and lock frontend.
- **Deliverables:**
  - `manifest.webmanifest`: App icons, colors, display standalone.
  - Service Worker configuration via `vite-plugin-pwa`.
  - Full E2E smoke suite (Playwright): Unlock → Dashboard → Quick Entry → Card Payment → Settle Debt → Month Close.
  - Accessibility audit (WCAG 2.2 AA target).
- **Verification Viewports:**
  - Mobile: `390px × 844px` (Honor 90 / Android Brave simulation).
  - Desktop: `1440px × 900px` (macOS Brave desktop simulation).
- **Acceptance Criteria:**
  1. App installable as PWA on Android Brave and macOS.
  2. Zero console errors, zero accessibility violations.
  3. Production build bundled under 120 KB initial JS shell.
  4. Final frontend freeze signed off.

---

## 4. Verification & Testing Matrix

| Testing Level | Scope | Tooling | Execution Trigger |
|---|---|---|---|
| **Unit** | Money math, currency formatting, date/time, error mappers | Vitest | Every commit |
| **Component** | Form validations, modals, buttons, accessible states | Testing Library | Every component PR |
| **Integration** | API client, query caching, mutation invalidation | MSW + Vitest | Phase completion |
| **E2E Smoke** | Critical user flows (Unlock, Quick Entry, Pay Card, Close Month) | Playwright | Phase completion |
| **Responsive** | Mobile touch targets (44px), desktop sidebar collapse | Playwright Viewports | F10 final sign-off |

---

## 5. Frozen Backend Integration Guarantee

```text
STATUS: 100% CAPABILITY COVERAGE
BLOCKERS: NONE
```

Every phase in this implementation plan relies exclusively on endpoints, DTOs, and error codes already implemented and tested in backend commit `9ed53f63461e5cf0ccf590a657d0fe5d00e8f312`. No backend modifications, schema migrations, or new endpoints are required.
