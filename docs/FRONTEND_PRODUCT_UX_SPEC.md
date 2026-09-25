# GELİR-GİDER — AUTHORITATIVE FRONTEND PRODUCT & UX SPECIFICATION

**Document Version:** `1.0.0-AUTHORITATIVE`  
**Status:** `LOCKED & APPROVED FOR IMPLEMENTATION`  
**Authoritative Backend SHA:** `9ed53f63461e5cf0ccf590a657d0fe5d00e8f312`  
**Target Delivery:** Mobile-First Daily Finance PWA + Desktop Personal Finance OS  
**Security Level:** Same-Origin WebAuthn / Passkey Protected  

---

## 1. Executive Product Definition

**Gelir-Gider** is a strictly private, single-user personal finance management system designed around the lived financial realities of the user. It is:
- **NOT** an accounting software or double-entry bookkeeper panel.
- **NOT** a bank employee terminal or ERP back-office.
- **NOT** an active day-trading platform or crypto portfolio manager.

### Core Value Proposition

1. **Mobile Experience (High-Frequency Daily Entry):**
   - **Primary Goal:** Open app → Comprehend safe-to-spend financial capacity in 2–4 seconds → Enter transaction (credit card purchase, manual cash/bank expense, or split) in 2–3 taps → Close app.
   - **Form Factor:** Android / Honor 90, Brave Browser, Installed Progressive Web App (PWA), portrait-first, high ergonomic touch targets.

2. **Desktop Experience (Medium-Density Personal Finance OS):**
   - **Primary Goal:** Monthly reviews, statement reconciliations, campaign tracking, goal rebalancing, file imports, and calendar month-close audits.
   - **Form Factor:** macOS, Brave Browser / Desktop PWA, responsive wide layout, hybrid list/table density, side-by-side comparison panels, zero cognitive clutter.

---

## 2. Source Audit Summary

The frontend specification is anchored strictly to the frozen backend implementation at commit `9ed53f63461e5cf0ccf590a657d0fe5d00e8f312`. Every capability, read model, and mutation described herein maps directly to an active router mounted on the Cloudflare Worker:

| Domain Router | Base Path | Source Authority | Frozen Capabilities |
|---|---|---|---|
| **Auth** | `/auth` | `src/http/auth-routes.ts` | Passkey WebAuthn enroll/auth, session cookie (`__Host-gg_session`), `/auth/status`, `/auth/session`, `/auth/logout`, step-up `/auth/passkey/reauth/*`. |
| **Budget V2** | `/budget-v2` | `src/http/budget-v2-routes.ts` | Checkpoint timeline, Decision Center view (`availableToAllocateNow`, trueSurplus, basicLiving, policyOutput), recommendation feedback revisions. |
| **Credit Cards** | `/credit-cards` | `src/http/credit-card-routes.ts` | Card CRUD, monthly statements, payment & reopen, payment-readiness, statement reconciliation, unshared & shared purchases, splits, opening balance. |
| **Manual Expenses**| `/manual-expenses` | `src/http/manual-expense-routes.ts` | Double-entry cash/bank manual expense CRUD, revision audit, void with reversing lines. |
| **Quick Entry** | `/quick-entry` | `src/http/quick-entry-template-routes.ts`| Server-synced entry blueprints for CC, manual, income, receivable, and payable. |
| **Spending Categories**| `/spending` | `src/http/spending-category-routes.ts` | 14 auto-seeded categories, user category CRUD, entity assignments, monthly spending summaries. |
| **People & Family** | `/people` | `src/http/people-routes.ts` | Counterpart CRUD, obligations (receivable/payable), settlements, friend 5 TL ceiling balance summary, waterfall excess routing. |
| **Short-Term Goals**| `/short-term-goals`| `src/http/short-term-goal-routes.ts`| Goal lifecycle (ACTIVE, COMPLETED, CANCELLED), priority reordering, fund allocation, release. |
| **Midas / Reserves**| `/midas` | `src/http/midas-routes.ts` | Earmark liquidity, physical vs unallocated balance, bucket transfers, compensating reversals. |
| **Long-Term** | `/long-term` | `src/http/long-term-routes.ts` | Virtual send tasks, mark-sent ledger execution, task reopen/cancel. |
| **Income** | `/income` | `src/http/income-routes.ts` | Sources, expected monthly entitlements, realized cash receipts, receipt-to-entitlement settlement, monthly reference income. |
| **Month Close** | `/month-close` | `src/http/month-close-routes.ts` | `preview` (live read-only snapshot with blocked reasons), bounded history, close decision apply (`FULL`, `PARTIAL`, `SKIP`). |
| **Imports** | `/imports` | `src/http/imports-routes.ts` | Staging batches, generic CSV v1 ingestion, duplicate candidate review, chunk-based row apply (`1..100`). |
| **Notifications** | `/notifications` | `src/http/notifications-routes.ts` | Web push subscription registration, subscription lifecycle, privacy-safe event history. |
| **Rewards** | `/rewards` | `src/http/rewards-routes.ts` | Loyalty point wallets, manual earn/expire/adjust, economic purchase redemptions. |
| **Campaigns** | `/campaigns` | `src/http/campaign-routes.ts` | Bank/card spend campaigns, progress tracking, manual purchase overrides, review candidates. |
| **Transactions** | `/transactions` | `src/http/transactions-routes.ts` | Canonical transaction timeline read model, revision history. |
| **Ledger** | `/ledger` | `src/http/ledger-routes.ts` | Asset & income account provisioning, bounded account balance queries. |

---

## 3. Locked Product Principles

1. **Truth First (No Fabricated Authority):** The frontend never re-computes waterfall allocations, never invents a Budget V3 formula, never guesses person debts, and never performs client-side optimistic financial ledger updates. Every displayed financial balance originates from an authoritative backend read model.
2. **Credit-Card-First Reality:** Approximately 90% of user transactions occur on credit cards. Credit cards are a primary first-class domain with prominent dashboard positioning, statement cycle countdowns, and instant payment-readiness indicators.
3. **Ergonomic Speed on Mobile:** One thumb reachability for 95% of daily interactions. Persistent central `+` action button. Maximum 3 taps from tap to save.
4. **Natural Human Language:** Eliminate accounting and banking jargon (`debtor`, `creditor`, `liability event`, `waterfall allocation`, `journal debit`, `settlement revision`). Use clear Turkish conversational phrasing (`Bana Borcu Var`, `Benim Borcum Var`, `Kart Rezervi`, `Ayı Tamamla`).
5. **Fail-Closed Privacy & Security:** Zero financial figures in Web Push notifications. Automatic screen lock upon cold start and after 2 minutes of backgrounding. Blurring sensitive figures in app-switcher mode. Same-origin cookie enforcement.
6. **Graceful Progressive Density:** Mobile presents uncluttered, summary-first cards with high touch targets. Desktop unfolds progressive detail, multi-column comparison tables, side drawers, and deep filters without resembling an intimidating trading screen.

---

## 4. User & Device Context

### Mobile Target (Primary)
- **Device:** Honor 90 (Qualcomm Snapdragon 7 Gen 1 Accelerated, 6.7" AMOLED, 1200 x 2664 pixels, 19.98:9 ratio).
- **OS / Browser:** Android 14+ / Brave Browser (Chromium engine, aggressive shield blocking, standalone PWA mode).
- **Physical Usage Pattern:** One-handed thumb usage while standing or walking; rapid expense entry immediately after POS terminal card swipe.
- **Viewport Bounds:** Effective CSS viewport: `360px` to `412px` width, `800px` to `915px` height. `window.devicePixelRatio ≈ 3.0`.

### Desktop Target (Secondary)
- **Device:** macOS (Apple Silicon MacBook / Studio Display).
- **OS / Browser:** macOS Sonoma+ / Brave Browser (Desktop windowed or installed PWA).
- **Usage Pattern:** Focused 10–20 minute weekly/monthly planning sessions: credit card statement payments, statement reconciliations, campaign overrides, monthly budget closes, and batch CSV imports.
- **Viewport Bounds:** Effective CSS viewport: `1280px` to `1920px` width.

---

## 5. Frontend Technology Decision

### Chosen Stack: React 19 + Vite + TypeScript + Vanilla CSS Modules

```text
┌─────────────────────────────────────────────────────────────┐
│  Gelir-Gider Frontend Stack                                 │
│                                                             │
│  Framework:         React 19 (Strict Mode, Pure TypeScript) │
│  Build Tool:        Vite 6 (Fast ESM HMR, Rollup Prod)      │
│  Styling:           Vanilla CSS Modules + Native Design     │
│                     Tokens (CSS Custom Properties)          │
│  Routing:           TanStack Router (Type-Safe Client Route)│
│  Server State:      TanStack Query v5 (Stale-While-Revalid.)│
│  UI Primitives:     Radix UI Primitives (Unstyled, WCAG-AA) │
│  Icons:             Lucide React (Tree-shaken SVGs)         │
│  Date/Time Engine:  date-fns (Europe/Istanbul TZ support)   │
│  PWA Engine:        vite-plugin-pwa (Workbox, Web App)      │
│  Testing:           Vitest + Testing Library + Playwright   │
└─────────────────────────────────────────────────────────────┘
```

### Rationale
1. **Zero Runtime Styling Overhead & 100% Token Flexibility:** Vanilla CSS Modules with custom properties provides maximum speed, full control over transitions and glassmorphism, zero class bloat, and aligns strictly with the workspace web application development guidelines without Tailwind build friction.
2. **Accessible Headless Primitives:** Radix UI (`@radix-ui/react-dialog`, `@radix-ui/react-dropdown-menu`, `@radix-ui/react-tabs`, `@radix-ui/react-select`) guarantees WCAG 2.2 AA accessibility, focus trapping, keyboard navigation, and ARIA compliance out of the box while letting us style 100% of the visual identity.
3. **Type-Safe Async State Management:** TanStack Query handles background revalidation, query invalidation after mutations, duplicate click prevention, and window focus refetching without boilerplate state reducers.
4. **Cloudflare Worker Static Asset Symbiosis:** Vite outputs a clean, deterministic `dist/` directory that is deployed directly alongside the Hono Worker in Cloudflare Workers using single-origin static asset binding.
5. **Single-Developer Maintainability:** Standard React/TypeScript patterns eliminate esoteric build tools, ensuring effortless maintenance and rock-solid stability.

### Evaluated & Rejected Alternatives
- **Next.js / Remix / SvelteKit Full-Stack:** Rejected. The backend is already frozen and operates on Cloudflare Workers + Hono + Neon. Introducing another backend or SSR runtime violates the single Cloudflare Worker invariant.
- **Tailwind CSS:** Rejected. Standard workspace guidelines mandate Vanilla CSS for rich bespoke design tokens and maximum layout flexibility without utility-class sprawl.
- **Redux / MobX / Zustand:** Rejected. 95% of state in this application is Server State (cached API read models) managed by TanStack Query. Local UI state (modals, drawers, selected tab) is easily handled with standard React component state.

---

## 6. Deployment & Same-Origin Architecture

The application operates under a **strict single-origin model** running on a single Cloudflare Worker:

```
┌──────────────────────────────────────────────────────────────────┐
│  Cloudflare Worker: gelir-gider-api  (https://gelir-gider.app)   │
│                                                                  │
│   ┌───────────────────────────────────────────────────────────┐  │
│   │  Static Asset Serving (Vite SPA Output: /dist)            │  │
│   │  - index.html, /assets/*.js, /assets/*.css, manifest.json │  │
│   │  - Service Worker (sw.js)                                 │  │
│   │  - Cache-Control: max-age=31536000, immutable (hashes)    │  │
│   └───────────────────────────────────────────────────────────┘  │
│                                │                                 │
│   ┌────────────────────────────┴──────────────────────────────┐  │
│   │  Hono API Engine (Existing Frozen Backend)                │  │
│   │  - /auth/*, /budget-v2/*, /credit-cards/*, /spending/*    │  │
│   │  - /manual-expenses/*, /quick-entry/*, /people/*, etc.    │  │
│   │  - Cookie: __Host-gg_session (HttpOnly, Secure, Strict)   │  │
│   │  - Guard: sameOriginMutationGuard() enforces Origin       │  │
│   └───────────────────────────────────────────────────────────┘  │
│                                │                                 │
│              ┌─────────────────┼─────────────────┐              │
│              ▼                 ▼                 ▼              │
│       Neon PostgreSQL    Cloudflare R2     Cloudflare            │
│       (DATABASE_URL)     (Backups)         Rate Limiter          │
└──────────────────────────────────────────────────────────────────┘
```

### Static Asset Integration Rule
- In `wrangler.jsonc`, the Worker includes:
  ```json
  "assets": {
    "directory": "./dist",
    "binding": "ASSETS",
    "html_handling": "single-page-application",
    "not_found_handling": "single-page-application"
  }
  ```
- All client fetch requests use relative URLs (`/auth/session`, `/credit-cards`, etc.), automatically attaching the origin and `__Host-gg_session` cookie without CORS or cross-origin headers.

---

## 7. Information Architecture & User Mental Model

The user thinks about their finances in four natural phases:

```
    ┌────────────────────────────────────────────────────────────────┐
    │  1. GÜNLÜK DURUM (DAILY STATUS)                                │
    │  "Şu an rahatça ne kadar harcayabilirim?"                      │
    │  → Hero: Kullanılabilir Tutar (Budget V2)                      │
    │  → Yaklaşan Kart Ödemeleri + Bu Ay Harcanan                    │
    └───────────────────────────────┬────────────────────────────────┘
                                    │
    ┌───────────────────────────────▼────────────────────────────────┐
    │  2. HIZLI KAYIT (FAST ENTRY)                                   │
    │  "Harcamayı hemen kaydet ve unut."                             │
    │  → Persistent [+] Fab                                          │
    │  → Hazır Şablonlar (Market, Kahve, Yemek, Benzin)             │
    │  → Kart veya Nakit Seçimi                                      │
    └───────────────────────────────┬────────────────────────────────┘
                                    │
    ┌───────────────────────────────▼────────────────────────────────┐
    │  3. YÜKÜMLÜLÜKLER & KİŞİLER (OBLIGATIONS & SPLITS)             │
    │  "Kime ne borcum var? Kim bana ne ödeyecek? Kart ekstresi?"    │
    │  → Kredi Kartları (Ekstre, Dönem, Rezerv)                      │
    │  → Kişiler & Ortak Harcamalar (Arkadaş 5 TL yuvarlama)         │
    └───────────────────────────────┬────────────────────────────────┘
                                    │
    ┌───────────────────────────────▼────────────────────────────────┐
    │  4. PLANLAMA & DÖNEM KAPANIŞI (PLANNING & CLOSE)               │
    │  "Ayı toparla, hedeflere aktar, tasarrufu koru."               │
    │  → Kısa Vadeli Hedefler + Kart Rezervi + Uzun Vadeli           │
    │  → Ayı Tamamla (5 Adımlı Sihirbaz)                             │
    └────────────────────────────────────────────────────────────────┘
```

---

## 8. Mobile Navigation Architecture

The mobile interface employs a high-ergonomic **5-Item Bottom Navigation Bar** combined with a prominent, elevated **Quick Entry FAB (+)**:

```text
┌─────────────────────────────────────────────────────────────┐
│                       MAIN CONTENT AREA                     │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│   [ ⌂ ]      [ ⇄ ]       ( + )       [ 💳 ]      [ ☰ ]     │
│  Ana Sayfa  Hareketler   Hızlı Ekle   Kartlar    Daha Fazla │
└─────────────────────────────────────────────────────────────┘
```

### Mobile Tabs Definition
1. **Ana Sayfa (Dashboard):** Hero available spend, secondary summary pills, urgent cards, quick templates chip strip, goals progress snapshot.
2. **Hareketler (Transactions):** Chronological transaction timeline, filter chips (Kartlar, Nakit, Kategoriler), search, transaction detail drawer.
3. **Hızlı Ekle (Quick Entry `+`):** Center-elevated persistent button opening the Quick Entry Bottom Sheet with synced templates and one-tap manual entry.
4. **Kartlar (Credit Cards):** Multi-card carousel/cards, current statement balance, days until due date, reserve coverage status, unbilled spend.
5. **Daha Fazla (More / Drawer Hub):**
   - **Kişiler (People & Borç/Alacak)**
   - **Bütçe & Hedefler (Budget, Goals, Midas, Long-Term)**
   - **Ayı Tamamla (Month Close Wizard)**
   - **Ekstre İçe Aktar (CSV Import)**
   - **Kampanyalar & Ödüller (Campaigns & Points)**
   - **Kategoriler & Ayarlar (Settings, Passkey, Push Notifications)**

---

## 9. Desktop Navigation Architecture

The desktop layout uses a **Collapsible Sidebar** paired with a sleek **Top Utility Bar**:

```text
┌──────────────┬──────────────────────────────────────────────────────────────┐
│ [Logo] Gelir │ [Dönem: 2026-09 ▼]      [Arama /]  [🔔 (2)]  [🔒 Kilitle]     │
├──────────────┼──────────────────────────────────────────────────────────────┤
│ ❖ GENEL      │                                                              │
│  • Ana Sayfa │                                                              │
│  • Hareketler│                     MAIN CONTENT AREA                        │
│              │                                                              │
│ 💳 ÖDEMELER  │                                                              │
│  • Kredi     │                                                              │
│    Kartları  │                                                              │
│  • Kişiler   │                                                              │
│              │                                                              │
│ 🎯 PLANLAMA  │                                                              │
│  • Bütçe     │                                                              │
│  • Hedefler  │                                                              │
│  • Likidite  │                                                              │
│              │                                                              │
│ ⚙ ARAÇLAR    │                                                              │
│  • Ayı       │                                                              │
│    Tamamla   │                                                              │
│  • İçe Aktar │                                                              │
│  • Kampanya  │                                                              │
│  • Ayarlar   │                                                              │
└──────────────┴──────────────────────────────────────────────────────────────┘
```

### Desktop Sidebar States
- **Expanded (Width: `260px`):** Icons + typography labels + badges + keyboard shortcuts.
- **Collapsed (Width: `72px`):** Icons only with floating accessible tooltips. Toggle via `Cmd/Ctrl + B` or toggle button.

---

## 10. Mobile Screen Map

```text
Mobile Route Map
├── /unlock                             (Passkey biometric cold-launch unlock)
├── /                                   (Ana Sayfa / Dashboard)
├── /transactions                       (Hareketler / Chronological Timeline)
│   └── /transactions/:id               (Bottom sheet transaction detail + void)
├── /cards                              (Kartlar / Multi-Card Overview)
│   ├── /cards/:cardId                  (Kart Detayı + Ekstre Geçmişi)
│   ├── /cards/:cardId/statements/:id   (Ekstre İnceleme & Ödeme Ekranı)
│   └── /cards/:cardId/purchases/new    (Yeni Kart Harcaması / Bölüşüm)
├── /quick-entry                        (Hızlı Ekle Modal / Template Selector)
│   └── /manual-expense/new             (Nakit / Banka Harcama Formu)
├── /people                             (Kişiler / Borç-Alacak Listesi)
│   ├── /people/:personId               (Kişi Detay + Bakiye Özeti)
│   └── /people/:personId/settle        (Tahsilat / Ödeme Waterfall Ekranı)
├── /budget                             (Bütçe V2 Karar Merkezi Özeti)
├── /goals                              (Kısa Vadeli Hedefler + Fonlama)
├── /midas                              (Kart Rezervi & Likidite Havuzu)
├── /month-close                        (Ayı Tamamla Sihirbazı / 5 Adım)
├── /imports                            (Banka/Kart CSV İçe Aktarma)
├── /campaigns                          (Kart Kampanyaları & Ödül Puanları)
└── /settings                           (Kategori Yönetimi, Bildirimler, Güvenlik)
```

---

## 11. Desktop Screen Map

Desktop surfaces utilize multi-column hybrid table/card layouts with slide-out contextual drawers:

1. **Dashboard (`/`):** 3-Column Grid (Left: Hero spend & Budget health; Center: Credit cards & due bills; Right: Goals & Quick templates).
2. **Transactions (`/transactions`):** Full-width data table with persistent filters (Date range, Card/Account, Category, Status), keyset paging, and Right-hand Inspection Drawer.
3. **Credit Cards OS (`/cards`):** Left card selector panel, Center statement breakdown & payment-readiness card, Right unbilled transaction list.
4. **People & Receivables (`/people`):** Master-detail view. Left: Person list with net balances; Right: Pending obligations, Friend ceiling calculation, Settle payment wizard with live excess waterfall simulation.
5. **Budget Decision Center (`/budget`):** Timeline checkpoint navigator, waterfall breakdown bar, behavior recommendations with Accept / Modify / Ignore controls.
6. **Month Close Wizard (`/month-close`):** Guided 5-step modal workflow: Verification → Unclassified review → Obligation reconciliation → Surplus routing → Idempotent commit.
7. **CSV Import Center (`/imports`):** Drag-and-drop zone → Staged row preview table → Mapping resolver drawer → Safe chunked execution progress bar.

---

## 12. Dashboard Hierarchy

### The Primary Question
> **"Bu ay hâlâ rahatça kullanabileceğim ne kadar param var?"**

### 12.1 Primary Hero Metric: "BU AY KULLANILABİLİR TUTAR" (Fail-Closed Semantics)
- **Authoritative Source:** Budget V2 latest checkpoint Decision Center read model (`GET /budget-v2/checkpoints/:paymentEventId/decision-center`).
- **Contract Field:** `checkpoint.report.mtd.availableToAllocateNow` (`AvailableToAllocateNowSection`).
- **Authoritative Behavioral States:**
  1. **When `availableToAllocateNow.available === true`:**
     - Displays the exact authoritative `amount` string formatted in Turkish currency (e.g. `₺14.250,00`).
     - Primary Label: **"Bu Ay Kullanılabilir Tutar"**.
     - Status Indicator: Shows budget health confirmation tag (e.g. `[● Bütçe Durumu Güvenli]`).
  2. **When `availableToAllocateNow.available === false` (Fail-Closed State):**
     - **STRICT FINANCIAL INVARIANTS:**
       - **NEVER** display `0 TL` or `0,00 ₺` as usable spending room.
       - **NEVER** calculate or fabricate an estimated amount using client-side formulas.
       - **NEVER** substitute `trueSurplus` or any other raw balance as if it were immediately usable.
     - **Hero Unavailable Presentation:**
       - Primary Headline: **"Kullanılabilir tutar henüz kesinleşmedi"**
       - Natural Recovery Copy: Explains that active period transactions or surplus attributions require classification before the safe spending capacity can be confirmed.
       - Actionable Recovery Action: Provides a direct link/button guiding the user to complete pending uncategorized or split items.
       - **Zero Technical Leakage:** Raw internal domain reason codes (`SURPLUS_USE_ATTRIBUTION_INCOMPLETE`, `SURPLUS_USE_ATTRIBUTION_OVERLAP_UNRESOLVED`) are never displayed to normal users.
     - *Note:* This is an intentional backend fail-closed financial invariant ensuring zero false financial assurance, **NOT** an integration blocker.
- **Visual Stature:** Huge, crisp typography (`36px` mobile / `48px` desktop) with `font-variant-numeric: tabular-nums`.

```
┌─────────────────────────────────────────────────────────────┐
│  BU AY KULLANILABİLİR TUTAR                                 │
│  ₺14.250,00                                                 │
│  [● Bütçe Durumu Güvenli]  •  Dönem Sonu: 6 gün kaldı       │
└─────────────────────────────────────────────────────────────┘
  VEYA (available === false durumunda):
┌─────────────────────────────────────────────────────────────┐
│  BU AY KULLANILABİLİR TUTAR                                 │
│  Kullanılabilir tutar henüz kesinleşmedi                    │
│  [ Harcamaları Tamamla → ]  •  1 işlem sınıflandırma bekliyor│
└─────────────────────────────────────────────────────────────┘
```

### 12.2 Secondary Metrics (Below Hero)
1. **Bu Ay Harcanan:** Total personal card & manual expenses MTD (`checkpoint.report.mtd.spending.personalCardSpendMTD` + manual expenses).
2. **Kartlarda Bu Dönem:** Sum of open statement liabilities across active credit cards (`liveLiabilityBalance`).
3. **Yaklaşan Ödeme:** Nearest due credit card payment date and amount with relative time tag (`"3 gün sonra"`).

---

## 13. Quick Entry Flow

The **Quick Entry Surface** is the highest frequency mobile user journey.

```text
User taps [+] button
         │
         ▼
┌─────────────────────────────────────────────────────────────┐
│ HIZLI KAYIT                                             [X] │
├─────────────────────────────────────────────────────────────┤
│ SIK KULLANILAN ŞABLONLAR                                    │
│ [ 🛒 Market ] [ ☕ Kahve ] [ ⛽ Akaryakıt ] [ 🍽 Yemek ]     │
├─────────────────────────────────────────────────────────────┤
│ VEYA YENİ GİRİŞ:                                            │
│ [ 💳 Kart Harcaması ]  [ 💵 Nakit/Banka ]  [ 👥 Ortak Bölüş ]│
└─────────────────────────────────────────────────────────────┘
```

### Template Tap Workflow
1. User taps `🛒 Market` chip.
2. Form pre-fills:
   - Category: `Market` (Financial class: `MANDATORY_EXPENSE`).
   - Default Card: Configured default card.
   - Merchant: Pre-filled if template defines it.
3. Numeric keypad opens automatically focused on **Tutar (Amount)**.
4. User types `350` → Taps **"Kaydet"** button.
5. Mutation fires `POST /credit-cards/:cardId/purchases` with client-generated `Idempotency-Key: uuidv4()`.
6. Button shows pending spinner → Success haptic pulse → Modal dismisses in `300ms`.
7. Dashboard updates smoothly via TanStack Query invalidation. Total flow time: **< 4 seconds**.

---

## 14. Transactions (Hareketler)

### Mobile Layout
- Sticky date headers (`Bugün`, `Dün`, `14 Eylül 2026`).
- Clean list items:
  - Left: Category icon with subtle tinted background.
  - Middle: Merchant / Description + Card or Account badge.
  - Right: Formatted amount (`-₺240,00`), with red accent for expenses, green for income.
  - Tap opens bottom sheet detail: full split breakdown, note, journal reference, and **"Harcamayı İptal Et (Void)"** action.

### Desktop Layout
- Medium-density data table with sorting and filtering:
  - Columns: Tarih, Açıklama / İşyeri, Kategori, Hesap/Kart, Tutar, Bölüşüm Durumu, İşlem Tipi, Aksiyonlar.
  - Search box with instantaneous local/server filter.
  - Detail panel slides in from the right when a row is clicked.

---

## 15. Spending Categories & Financial Defaults

The application strictly separates **Spending Category** (descriptive taxonomy) from **Financial Classification** (budgetary economic consequence).

### 15.1 Locked Starter Set (Auto-Seeded on First Fetch)

| ID / Name | Default Budget Classification | User Mental Prompt |
|---|---|---|
| **Market** | `MANDATORY_EXPENSE` | Temel gıda ve ev ihtiyaçları (Zorunlu) |
| **Dışarıda Yemek** | `ASK` | Restoran / Kafe (Sor: Keyfi mi, Zorunlu mu?) |
| **Ulaşım** | `MANDATORY_EXPENSE` | Toplu taşıma / Taksi (Zorunlu) |
| **Akaryakıt** | `MANDATORY_EXPENSE` | Araç yakıtı (Zorunlu) |
| **Sağlık** | `MANDATORY_EXPENSE` | Eczane / Muayene / İlaç (Zorunlu) |
| **Giyim** | `ASK` | Kıyafet alışverişi (Sorulur) |
| **Eğlence** | `DISCRETIONARY_SPEND` | Sinema, konser, hobi (Keyfi / Esnek) |
| **Abonelikler** | `ASK` | Dijital servisler / aidatlar (Sorulur) |
| **Eğitim** | `ASK` | Kurs, kitap, okul (Sorulur) |
| **Seyahat** | `ASK` | Tatil ve seyahat (Sorulur) |
| **Ev** | `MANDATORY_EXPENSE` | Kira, faturalar, ev gereçleri (Zorunlu) |
| **Yurt Ücreti** | `MANDATORY_EXPENSE` | Barınma / Yurt (Zorunlu) |
| **Hediye** | `DISCRETIONARY_SPEND` | Hediye harcamaları (Keyfi / Esnek) |
| **Diğer** | `ASK` | Sınıflandırılmamış harcama (Sorulur) |

### 15.2 The "ASK" UX Resolution Pattern
`ASK` is an onboarding/category configuration state, never a final transaction classification.
- In transaction entry forms, selecting an `ASK` category reveals a simple, natural-language toggle:
  ```text
  Bu harcama bu ay için:
  (●) Zorunlu Temel İhtiyaç     (○) Keyfi / Esnek Harcama
  ```
- Defaults to `Zorunlu Temel İhtiyaç` with zero friction.

---

## 16. Credit Cards Domain (Credit-Card-First)

Credit Cards is a central pillar of the application.

```text
┌─────────────────────────────────────────────────────────────┐
│ Garanti Bonus Platinum                        Son 4 Hane: 4092 │
├─────────────────────────────────────────────────────────────┤
│ Güncel Dönem Borcu: ₺18.420,50        Kart Rezervi: ₺18.420,50│
│ Hesap Kesim: 15 Eylül                 [● Tam Koruma Altında] │
│ Son Ödeme: 25 Eylül (8 gün kaldı)                           │
├─────────────────────────────────────────────────────────────┤
│ [ Ekstreyi Öde ]      [ Ekstre Detayı ]      [ Harcama Ekle ]│
└─────────────────────────────────────────────────────────────┘
```

### 16.1 Card Detail Architecture
- **Current Statement Status:** `OPEN`, `PAID`, or `REOPENED`.
- **Payment-Readiness Badge (`GET /credit-cards/:cardId/statements/:id/readiness`):**
  - `READY`: Midas Card Reserve covers 100% of open liability. Green status.
  - `SHORTFALL`: Reserve is underfunded. Amber warning showing the exact required top-up.
- **Statement Payment Workflow:**
  - One-tap `Ekstreyi Öde` button triggers `POST /credit-cards/:cardId/statements/:id/pay`.
  - Requires `Idempotency-Key`.
  - Immediately transitions statement to `PAID`, deducts liability, records journal entries, and enqueues Budget V2 checkpoint.
- **Shared Purchases & Splits (`/credit-cards/:cardId/purchases/shared`):**
  - Integrated split calculator: Equal (`EQUAL`), Percentage (`PERCENTAGE`), or Exact Amount (`EXACT`).
  - Seamlessly assigns counterpart receivables to People domain without secondary manual steps.

---

## 17. People & Receivables (Borç / Alacak)

### 17.1 Natural Human Terminology Matrix

| Backend Internal Term | Forbidden UI Jargon | Mandatory User-Facing Term |
|---|---|---|
| `RECEIVABLE` | Debtor, Receivable Ledger | **Bana Borcu Var** / **Alacağım** |
| `PAYABLE` | Creditor, Liability Account | **Benim Borcum Var** / **Borcum** |
| `SETTLEMENT` | Settlement Execution | **Ödeme Aldım** / **Ödeme Yaptım** |
| `REMAINING` | Unsettled Principal | **Kalan Tutar** |
| `FRIEND_ROUNDING`| Next 5 TL Ceiling | **Tahsilat Hedefi (5 TL Yuvarlanmış)** |

### 17.2 Counterpart Balance Display Rules
- **FRIEND Relationship:**
  - Backend computes `collectionTarget` rounded up to the next 5.00 TL ceiling (e.g. `₺42,10` → `₺45,00`).
  - UI displays:
    ```text
    Kalan Borç: ₺42,10
    İstenen Ödeme: ₺45,00 (5 TL yuvarlama)
    ```
- **FAMILY Relationship:**
  - Exact balance only (`₺42,10`), no rounding suggestion.

### 17.3 Overpayment Waterfall Feedback
When a person pays more than their outstanding debt (`cashAmount > remainingAmount`), the backend routes the excess through a deterministic waterfall:
1. Nearest-due Credit Card Reserve shortfall.
2. Active Short-Term Goal #1.
3. Long-Term Investment / Unallocated buffer.

**Resulting UI Natural Language Explanation:**
```text
✓ 500,00 TL ödeme kaydedildi:
  • 350,00 TL borç tamamen kapatıldı.
  • 100,00 TL Kredi Kartı Rezervine eklendi.
  • 50,00 TL "Acil Durum Fonu" hedefine aktarıldı.
```

---

## 18. Short-Term Goals (Kısa Vadeli Hedefler)

- **Presentation:** Interactive goal progress cards displaying target amount, accumulated balance, remaining need, target date countdown, and percentage progress bar.
- **Funding Action:** Direct allocation modal (`POST /short-term-goals/:id/fund`) transferring unallocated Midas liquidity into the goal's dedicated bucket.
- **Priority Reordering:** Drag-and-drop handles on desktop; up/down stepper buttons on mobile (`POST /short-term-goals/reorder`).
- **Invariants:** Overfunding is strictly blocked by UI validation matching backend cap rules (`maxBudget`). Goals cannot be marked completed or cancelled while holding a non-zero balance (`SHORT_TERM_GOAL_NON_ZERO_BALANCE`).

---

## 19. Kart Rezervi, Kısa Vadeli Hedefler & Uzun Vadeli Ayrımı

### Three Primary Product Pillars
To ensure clear financial boundaries without cognitive confusion, the user's wealth, reserves, and savings architecture is strictly separated into three independent primary concepts:
1. **Kart Rezervi (Credit Card Reserve):** Dedicated liquidity held in Midas to fund and protect upcoming credit card statement liabilities.
2. **Kısa Vadeli Hedefler (Short-Term Goals):** Earmarked target-driven saving buckets (e.g., Acil Durum Fonu, seyahat, teknoloji) with explicit progress tracking.
3. **Uzun Vadeli (Long-Term Investment):** Wealth transferred out of operational liquidity into long-term investment vehicles via structured send tasks.

*(Serbest / Dağıtılmamış Bakiye — unallocated operating liquidity — is surfaced as an underlying Midas liquidity metric supporting transfers, but does not replace or conflate with Uzun Vadeli).*

---

## 20. Long-Term Investment (Uzun Vadeli)

- Long-Term is **NOT** a sub-bucket of Kart Rezervi. It represents wealth transferred out of liquid operating accounts into long-term investments.
- **Task Lifecycle:**
  1. `Beklemede (PENDING)`: Funds earmarked in Midas `PENDING_LONG_TERM` bucket.
  2. `Gönderildi (SENT)`: User marks funds transferred to external broker/fund (`POST /long-term/tasks/:id/mark-sent`), posting canonical ledger entries.
  3. `İptal (CANCELLED)`: User cancels pending task, immediately returning funds to unallocated liquidity.

---

## 21. Budget V2 Integration (Bütçe Karar Merkezi)

- **Mobile View:** Summary-first accordion. Displays:
  - Temel Yaşam İhtiyacı (Approved Target vs Actual MTD Spend).
  - Zorunlu Yükümlülükler (Current Statement & Obligation Overlap).
  - Esnek Harcama Alanı (Discretionary Allocation).
  - Tasarruf & Hedef Katkısı (True Surplus).
- **Desktop Decision Center:** Full timeline comparison view. Explains recommendation adaptations (e.g. food spending adjustments) and allows the user to click **Kabul Et (Accept)**, **Düzenle (Modify)**, or **Yoksay (Ignore)**.

---

## 22. Income Domain (Gelir Yönetimi)

- **Sources:** Manage employers, rental income, or family support sources.
- **Beklenen Aylık Gelir (Entitlements):** Planned monthly salary or recurring entitlements.
- **Gerçekleşen Tahsilat (Realized Receipts):** Cash hitting bank accounts, linked to expected entitlements with double-entry balance verification.
- **Referans Gelir (Reference Income):** Baseline reference income calculated by backend as of current date for budget ceiling calculations.

---

## 23. Month Close Wizard (Ayı Tamamla)

The monthly accounting close is presented as an anxiety-free, **5-Step Wizard**:

```text
┌─────────────────────────────────────────────────────────────┐
│ AYI TAMAMLA — 2026-08                                       │
│ [1. Kontrol] ➔ [2. Eksikler] ➔ [3. Kartlar] ➔ [4. Fazlalık] ➔ [5. Onay] │
└─────────────────────────────────────────────────────────────┘
```

### Wizard Step Sequence
1. **Adım 1: Dönem Kontrolü (Period Check):** Reads `GET /month-close/preview?periodMonth=YYYY-MM`. Verifies if period has ended in Europe/Istanbul.
2. **Adım 2: Eksik ve Sınıflandırma (Unclassified Check):** If blocked by `MONTH_CLOSE_UNCLASSIFIED_EXPENSES`, lists unclassified transactions with inline category selectors.
3. **Adım 3: Kart ve Yükümlülük Doğrulama (Obligation Check):** Confirms all credit card statement payments are reconciled.
4. **Adım 4: Fazlalık Dağıtım Kararı (Surplus Routing):** If surplus exists, displays backend proposed goal allocation:
   - Option A: **Tamamını Aktar (FULL)** (Recommended).
   - Option B: **Kısmi Aktar (PARTIAL)** (Custom amount input).
   - Option C: **Bu Ay Pas Geç (SKIP)** (Keep in liquidity).
5. **Adım 5: Özeti Gör ve Ayı Tamamla (Confirmation):**
   - Displays clear diff summary of actions taken.
   - User clicks **"2026-08 Dönemini Tamamla"**.
   - Submits `POST /month-close` with `Idempotency-Key` and `expectedProposalFingerprint`.
   - Displays celebratory confirmation screen with celebration haptic feedback.

---

## 24. Batch Import Center (Ekstre İçe Aktarma)

Hides all backend chunking mechanics behind an intuitive 4-stage UI:

```text
1. Dosya Seç   ➔   2. Önizleme & Eşleme   ➔   3. İşleme   ➔   4. Özet Rapor
(CSV Yükle)        (Şüpheli & Tekrarlar)      (Otomatik)      (Sonuçlar)
```

### Import UX Rules
- Accepts generic CSV files up to `10 MiB`.
- Calls `POST /imports/batches` with `sourceKind: "GENERIC_CSV_V1"`.
- Displays preview sample (`GET /imports/batches/:id/preview`, max 25 rows) and summary counts (`READY`, `NEEDS_REVIEW`, `EXACT_DUPLICATE`).
- Resolves conflicts via slide-over row resolver (`POST /imports/batches/:batchId/rows/:rowId/resolve`).
- User clicks **"Tümünü İçe Aktar"**: Frontend loops `POST /imports/batches/:id/apply?limit=50` until `hasMore === false`, updating a smooth progress bar.

---

## 25. Notifications & Web Push

### Push Notification Semantics & Invariants
- **ZERO FINANCIAL FIGURES IN NOTIFICATIONS:** Push payloads never contain account balances, statement totals, or debt numbers.
- **Notification Schedule:**
  - `CREDIT_CARD_DUE_SOON`: Due date minus 1 day at 22:00 Europe/Istanbul.
  - `CREDIT_CARD_DUE`: Due date at 10:00 Europe/Istanbul.
  - `BUDGET_THRESHOLD`: First spending > budget, then every +5,000 TRY step.
  - `NO_SPEND_CHECK`: 22:00 Europe/Istanbul if no personal spending recorded that day. Body text: `"Bugün hiç harcama yaptın mı?"`.
- **In-App Notification Center:** When opened, the app queries authenticated read models to display context-rich figures securely behind the unlocked session.

---

## 26. Analytics & Insights

- **Desktop-Centric Analytics:**
  - Kategori Dağılımı (Donut chart & sorted table).
  - Zorunlu vs Keyfi Harcama Oranı (Stacked bar).
  - Kart Harcama Eğilimi (Monthly trendline).
  - Arkadaş Bölüşüm Geri Dönüş Hızı (Receivable velocity).
- **Mobile Analytics:** Minimal, high-signal summary widgets only; no tiny unreadable charts.

---

## 27. Settings & Application Preferences

- **Kategori Yönetimi:** Create custom categories, archive unused starter categories, adjust sort order.
- **Kredi Kartı Ayarları:** Card nicknames, display order, statement cycle days.
- **Bildirim Tercihleri:** Toggle push subscriptions per device.
- **Güvenlik Ayarları:** Biometric passkey management, active session review, lock timeout customization.
- **Tema:** Açık (Light) / Koyu (Dark) / Sistem Varsayılanı.

---

## 28. Security, Passkey & App Lock

### Inactivity & Background Lock Policy
1. **Cold Launch:** Requires Passkey assertion via WebAuthn (`/auth/passkey/authentication/*`).
2. **Background Lock (>= 2 Minutes):** If app is sent to the background or tab is hidden for $\ge 120$ seconds, the UI immediately displays the full-screen **Kilitli (Locked)** overlay.
3. **Step-Up Reauthentication:** Unlocking calls `POST /auth/passkey/reauth/options` and `POST /auth/passkey/reauth/verify`. This verifies biometric presence without destroying or re-issuing the session cookie.
4. **App Switcher Protection:** On mobile, while the app is in the background, a privacy mask blurs the screen content to prevent OS-level thumbnail capture.

---

## 29. PWA & Offline Policy

- **Service Worker Scope:** Pre-caches app shell (`index.html`, compiled JS/CSS, icons, web fonts).
- **Offline Mode:**
  - App shell loads instantly.
  - Cached non-sensitive static preference data is accessible.
  - **FINANCIAL MUTATION INVARIANT:** Offline financial mutations are **STRICTLY DISALLOWED** in V1. If the network is down, the UI shows a clear banner: `"Çevrimdışısınız — Finansal kayıtlar internet bağlantısı gerektirir"`. This eliminates duplicate transactions, out-of-order ledger postings, and concurrency conflicts.

---

## 30. Responsive Breakpoint System

| Breakpoint Name | Media Query Range | Navigation Paradigm | Layout Structure |
|---|---|---|---|
| **Mobile** | `< 640px` | 5-Tab Bottom Bar + FAB | Single column, edge-to-edge cards, bottom sheets |
| **Large Mobile / Phablet**| `640px - 767px` | 5-Tab Bottom Bar + FAB | Single column with generous padding (`24px`) |
| **Tablet** | `768px - 1023px`| Slim Sidebar (`72px`) | 2-Column layout, split panels, modal dialogs |
| **Desktop** | `1024px - 1439px`| Full Sidebar (`260px`)+Top Bar | 3-Column dashboard, hybrid table/list, side drawer |
| **Wide Desktop** | `≥ 1440px` | Full Sidebar + Top Bar | Multi-pane OS workspace, max container `1600px` |

---

## 31. Design Tokens (CSS Custom Properties)

All design tokens are implemented as standard CSS Custom Properties in `src/styles/tokens.css`:

```css
:root {
  /* Brand / Primary Palette (Indigo & Deep Slate) */
  --color-primary-50: #eef2ff;
  --color-primary-100: #e0e7ff;
  --color-primary-500: #6366f1;
  --color-primary-600: #4f46e5;
  --color-primary-700: #4338ca;

  /* Semantic Colors */
  --color-success-500: #10b981;  /* Emerald (Positive balance, paid) */
  --color-success-600: #059669;
  --color-warning-500: #f59e0b;  /* Amber (Due soon, review needed) */
  --color-danger-500: #ef4444;   /* Red (Overdue, destructive action) */
  --color-purple-500: #8b5cf6;   /* Violet (Goals, insights) */

  /* Neutral Light Surfaces */
  --surface-base: #f8fafc;
  --surface-card: #ffffff;
  --surface-elevated: #ffffff;
  --surface-muted: #f1f5f9;
  --border-subtle: #e2e8f0;
  --border-strong: #cbd5e1;
  --text-primary: #0f172a;
  --text-secondary: #475569;
  --text-muted: #94a3b8;

  /* Spacing Scale */
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 20px;
  --space-6: 24px;
  --space-8: 32px;
  --space-12: 48px;

  /* Radii */
  --radius-sm: 6px;
  --radius-md: 10px;
  --radius-lg: 16px;
  --radius-full: 9999px;

  /* Touch Target */
  --min-touch-target: 44px;

  /* Elevation Shadows */
  --shadow-sm: 0 1px 2px 0 rgb(0 0 0 / 0.05);
  --shadow-md: 0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1);
  --shadow-lg: 0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1);

  /* Transitions */
  --duration-fast: 150ms;
  --duration-normal: 250ms;
  --ease-standard: cubic-bezier(0.4, 0, 0.2, 1);
}

/* First-Class Dark Mode */
[data-theme="dark"] {
  --surface-base: #0b0f19;
  --surface-card: #111827;
  --surface-elevated: #1f2937;
  --surface-muted: #1e293b;
  --border-subtle: #1f293d;
  --border-strong: #374151;
  --text-primary: #f8fafc;
  --text-secondary: #cbd5e1;
  --text-muted: #64748b;
  --shadow-sm: 0 1px 2px 0 rgb(0 0 0 / 0.5);
  --shadow-md: 0 4px 6px -1px rgb(0 0 0 / 0.4);
}
```

---

## 32. Typography, Number Legibility & Density

### Turkish Currency Formatting Standard
- Currency Symbol: `₺` prefix or suffix strictly consistent (`₺1.250,50`).
- Locale: `tr-TR` (Dot for thousands separator, comma for decimals).
- **Tabular Numerals:** Every financial number uses `font-variant-numeric: tabular-nums` to prevent column shifting during live balance updates.
- **Kuruş Display Rules:**
  - Hero Dashboard Spend: Displays full kuruş (`₺14.250,00`).
  - Secondary KPI Chips & Progress Bars: Omit kuruş if `.00` (`₺14.250`) to save horizontal space.
  - Form Inputs & Tables: Always display exact two decimal places.

---

## 33. Component System Architecture

```text
src/components/
├── primitives/          # Radix-backed accessible controls
│   ├── Button/
│   ├── Input/
│   ├── Modal/
│   ├── BottomSheet/
│   ├── Dropdown/
│   ├── SegmentedControl/
│   └── Badge/
├── composed/            # Reusable UI molecules
│   ├── MoneyDisplay/    # Tabular currency renderer
│   ├── MetricCard/      # Dashboard KPI card
│   ├── SearchInput/     # Debounced search bar
│   ├── CategoryPill/    # Icon + name + color chip
│   └── ConfirmDialog/   # Destructive action safeguard
└── domain/              # Business-critical domain modules
    ├── auth/            # Biometric passkey unlock surface
    ├── budget/          # Hero available spend & decision center
    ├── cards/           # Card carousel, statement cards, split tool
    ├── quick-entry/     # Template chips, 3-tap bottom sheet
    ├── people/          # Person balance summary, waterfall settlement
    ├── month-close/     # 5-Step guided wizard
    └── imports/         # CSV upload, preview sample, chunk apply
```

---

## 34. Form Strategy & Money Input

### Money Input Component (`<MoneyInput />`)
- Uses virtual decimal management optimized for Turkish mobile keyboards.
- User typing `1` `2` `5` `0` formats in real-time as `12,50 ₺` or integer with explicit comma trigger.
- Prevents invalid characters, multiple commas, and negative numbers.
- Double-submit protection: Submit button enters disabled spinner state immediately upon first tap.

---

## 35. Charts & Data Visualization

- Ultra-lightweight SVG / Canvas visualizer (e.g. customized lightweight Chart.js or minimal pure SVG charts).
- No giant charting library bloat.
- High contrast colors matching design tokens.
- Accessible text-table fallback for every visual chart.

---

## 36. Loading, Empty, Error & Success States

### Domain-Aware Error Translation Matrix

| Raw Backend Error Code | User-Facing Actionable Turkish Message | Recovery Action |
|---|---|---|
| `UNAUTHENTICATED` | Oturumunuz sonlandı. Lütfen parmak izi / Passkey ile giriş yapın. | Passkey diyaloğunu aç |
| `CREDIT_CARD_SPLIT_CONFLICT` | Bu harcamanın kişi paylaşımı henüz kesinleşmedi. Paylaşımı kontrol edin. | Bölüşüm ekranına yönlendir |
| `MONTH_CLOSE_UNCLASSIFIED_EXPENSES`| Bu ay henüz kategorize edilmemiş harcamalar var. Lütfen tamamlayın. | Eksik harcamaları listele |
| `MONTH_CLOSE_PERIOD_NOT_ENDED` | Henüz ay bitmedi. Ay bitiminden sonra dönem kapatılabilir. | Ay sonunu bekle |
| `SHORT_TERM_GOAL_NON_ZERO_BALANCE` | Hedefte bakiye varken tamamlanamaz. Önce bakiyeyi serbest bırakın. | Bakiyeyi serbest bırak |
| `PEOPLE_OBLIGATION_SPLIT_MANAGED` | Bu borç kredi kartı bölüşümünden oluşturulmuş. Kart harcamasından düzenleyin. | Kart harcamasını aç |
| `IMPORT_MISSING_CARD_MAPPING` | Ekstredeki kart sistemde bulunamadı. Lütfen bir kartla eşleştirin. | Kart eşleme aç |
| `BUDGET_IDEMPOTENCY_CONFLICT` | Bu işlem zaten uygulandı veya tekrar gönderildi. | Listeyi yenile |

---

## 37. Accessibility (WCAG 2.2 AA Target)

1. Minimum `44px × 44px` touch targets on all interactive buttons and mobile navigation items.
2. High contrast ratio ($\ge 4.5:1$ for body text, $\ge 3:1$ for large numbers and UI borders).
3. Full keyboard operability on Desktop: `Tab` ordering, `Esc` to close dialogs/drawers, `Cmd/Ctrl + K` command bar.
4. Screen reader announcements: ARIA live regions for mutation status alerts and live balance updates.

---

## 38. Privacy UX

- **Lock Screen Shield:** Prevents financial balance exposure on device wake before biometric verification.
- **App Switcher Obfuscation:** Automatic blur shield applied when user switches apps.
- **Push Notification Cleanliness:** Pure actionable alerts without monetary numbers (`"Kredi kartı son ödeme gününüz yaklaştı"`).

---

## 39. V1 Scope vs Later Backlog

### V1 Scope (Authoritative & Frozen)
- Passkey WebAuthn Authentication & App Lock Reauth.
- Budget V2 Hero spend & Decision Center timeline view.
- Credit Cards full lifecycle (cards, statements, pay, reopen, splits, reconciliation).
- Manual Expenses (Cash & Bank accounts).
- Synced Quick-Entry Templates & Floating FAB.
- Spending Categories (14 starter categories + user custom).
- People & Family (Receivables/Payables, Friend 5 TL rounding, Waterfall overpayment).
- Short-Term Goals, Midas Kart Rezervi, Long-Term Investment Tasks.
- Income Sources, Entitlements, Realized Receipts, Reference Income.
- Month Close 5-step wizard.
- Batch CSV Import with hidden chunk apply.
- Web Push Notifications & In-App Notification Center.
- Light/Dark theme.

### Later Backlog (Out of Scope for V1)
- Automatic Open Banking / PSD2 live bank scraping APIs.
- AI automated transaction receipt OCR scanning.
- Offline transaction mutation queue.
- Multi-currency live forex exchange conversion.
- Home screen native Android/iOS widgets.

---

## 40. Frontend Data Architecture

```text
┌─────────────────────────────────────────────────────────────┐
│  API Client (src/api/client.ts)                             │
│  - Wraps native fetch()                                     │
│  - Relative paths (Same-Origin)                             │
│  - Automatic 'Origin' header injection on POST/PUT/DELETE   │
│  - Automatic 'Idempotency-Key' generation                   │
│  - Error envelope extraction & typed rejection              │
└──────────────────────────────┬──────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────┐
│  TanStack Query v5 Server State Layer                       │
│  - Keys: ['budget', 'checkpoints'], ['cards'], ['people']   │
│  - Stale Time: 30 seconds for read models                   │
│  - Invalidation: Mutating actions trigger targeted cache    │
│    invalidation (e.g. payStatement invalidates 'cards' &    │
│    'budget')                                                │
└─────────────────────────────────────────────────────────────┘
```

### Money Representation Rule
**JavaScript Floating-Point Numbers Are Strictly Forbidden For Financial Storage or Math.**
- All money amounts are stored and transported as 2-decimal string values (e.g. `"1420.50"`).
- Formatting and calculations use integer cents (`bigint`) via verified utility helpers (`parseMoneyToCents`, `formatCentsToMoney`).

### Fail-Closed Budget V2 Hero Contract Handling
- `availableToAllocateNow.available === true`: Query hooks yield the authoritative `amount` directly to `<HeroAvailableSpend />`.
- `availableToAllocateNow.available === false`: Query hooks yield an explicit typed unavailable state (`{ available: false, reason }`). The UI renders the unavailable recovery state without attempting client-side balance synthesis or substituting `trueSurplus`.

---

## 41. Testing Strategy

```text
┌─────────────────────────────────────────────────────────────┐
│  E2E Tests (Playwright)                                     │
│  - Unlock flow, Dashboard load, Quick template entry        │
│  - Card payment, Person settlement, Month Close wizard      │
├─────────────────────────────────────────────────────────────┤
│  Integration Tests (Testing Library + MSW)                  │
│  - Form submission & idempotency headers                    │
│  - TanStack Query cache invalidations                       │
├─────────────────────────────────────────────────────────────┤
│  Unit Tests (Vitest)                                        │
│  - Turkish currency formatting, Money string helpers        │
│  - Date & Istanbul timezone calculations, Error mappers     │
└─────────────────────────────────────────────────────────────┘
```

---

## 42. Performance Budget

- **Initial App Shell Weight:** $< 120\text{ KB}$ gzipped.
- **First Contentful Paint (FCP):** $< 800\text{ ms}$ on mobile 4G.
- **Time to Interactive (TTI):** $< 1.2\text{ s}$.
- **Interaction to Next Paint (INP):** $< 50\text{ ms}$ (zero lag on button taps).
- **Icon Strategy:** Tree-shaken Lucide icons imported individually.

---

## 43. Implementation Phases Summary

Implementation proceeds in 11 sequential, strictly bounded phases (detailed fully in `FRONTEND_IMPLEMENTATION_PLAN.md`):

- **F0:** Project Foundation, Vite, TypeScript, Design Tokens & Tooling.
- **F1:** Same-Origin API Client, Auth & Passkey App Lock.
- **F2:** Dashboard Shell & Budget V2 Hero Read Model (Fail-Closed).
- **F3:** Transactions & Manual Cash/Bank Expense Flow.
- **F4:** Quick Entry FAB & Server-Synced Templates.
- **F5:** Credit Cards OS (Cards, Statements, Payments, Splits).
- **F6:** People, Receivables & Waterfall Settlement.
- **F7:** Short-Term Goals, Midas Kart Rezervi & Long-Term Tasks.
- **F8:** Income Management & Month Close Wizard.
- **F9:** Batch CSV Imports & Notification Center.
- **F10:** PWA Assets, Responsive Polish, E2E Smoke & Production Freeze.

---

## 44. Phase Acceptance Criteria Summary

Each phase must satisfy:
1. Pure TypeScript type check passes (`tsc --noEmit`).
2. Code passes Biome linter/formatter.
3. Component and flow tests pass with zero regressions.
4. Mobile viewport (Honor 90 / 390px) and Desktop viewport (1440px) verified.
5. No backend code modifications or migration requirements.

---

## 45. Backend Integration Blockers

```text
INTEGRATION BLOCKERS: NONE
```
The frozen backend at commit `9ed53f63461e5cf0ccf590a657d0fe5d00e8f312` exposes 100% of the required capabilities, routes, DTOs, idempotency protections, and error codes required to deliver the V1 Frontend.

---

## 46. Final Locked Decisions Table

| Area | Locked Decision | Rationale | Source / Constraint |
|---|---|---|---|
| **Frontend Framework** | React 19 (Strict Mode, Pure TypeScript) | Unmatched headless ecosystem, long-term stability, single-dev ergonomics. | Vite + Cloudflare Worker static assets |
| **Styling** | Vanilla CSS Modules + Native CSS Custom Properties | Zero runtime overhead, 100% token control, matches workspace web guidelines. | `src/styles/tokens.css` |
| **PWA Engine** | `vite-plugin-pwa` (Workbox) | Offline shell, manifest metadata, installable on Android Brave & macOS. | `wrangler.jsonc` assets binding |
| **State Management** | Built-in React State (Local) | Zero overhead; local modals and tabs do not require global stores. | Architecture simplicity |
| **Server State** | TanStack Query v5 | Auto background revalidation, mutation invalidation, request deduping. | Authoritative backend read models |
| **Forms** | Controlled components with custom `<MoneyInput />` | Strict Turkish locale decimal control, zero float math corruption. | `src/ledger/money.ts` conventions |
| **Routing** | TanStack Router (Client-side SPA) | Type-safe route params, search param validation, lightweight bundle. | Same-origin SPA |
| **UI Primitives** | Radix UI Headless Primitives | 100% WCAG 2.2 AA accessibility, unstyled for bespoke tokens. | Desktop & Mobile accessibility |
| **Mobile Navigation** | 5-Tab Bottom Bar + Persistent Center FAB `(+)` | High thumb ergonomics on Honor 90, 3-tap rapid entry. | Mobile-first UX |
| **Desktop Navigation**| Collapsible Sidebar (`260px` / `72px`) + Top Utility Bar | Medium-density finance OS layout, keyboard navigation (`Cmd+B`). | Desktop personal finance OS |
| **Dashboard Hero** | "BU AY KULLANILABİLİR TUTAR" (Fail-Closed) | Exact `amount` when available; displays unavailable recovery guidance if unconfirmed. Never fabricates numbers. | `/budget-v2/checkpoints/:id/decision-center` |
| **Savings / Reserve Pillars**| Kart Rezervi + Kısa Vadeli Hedefler + Uzun Vadeli | Strict 3-domain conceptual separation; Unallocated liquidity backs operations without replacing Long-Term. | Sections 18–20 |
| **Money Representation**| 2-Decimal Strings (`"1420.50"`) & BigInt Cents | Avoids IEEE-754 float precision loss; matches backend schema. | `src/ledger/money.ts` |
| **Auth UX** | Cold Launch Passkey + 2-Min Inactivity App Lock | Biometric step-up reauth (`/auth/passkey/reauth/*`) without cookie churn. | `src/http/auth-routes.ts` |
| **Offline Policy** | Cache shell only; block offline financial mutations | Eliminates duplicate/corrupt financial ledger entries in V1. | Accounting correctness |
| **Design Direction** | Deep Indigo, Emerald Success, Violet Goals, Slate Surfaces | Professional, calm, premium fintech aesthetic; zero neon crypto noise. | Section 23 Visual Direction |

---

## 47. Open Questions

```text
NONE — READY FOR FRONTEND IMPLEMENTATION
```
All product definitions, backend endpoints, UX flows, data contracts, and design tokens are locked and verified against the authoritative codebase.
