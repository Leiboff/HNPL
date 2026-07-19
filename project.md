# HNPL — Project Documentation

> **Health Now, Pay Later** — a South African healthcare payment-splitting platform.
> Patients split a medical bill into 2 or 3 interest-free instalments. The practice is
> paid 94% upfront (HNPL keeps a flat 6% service fee). HNPL collects the instalments
> from the patient and carries the default risk.

This document describes everything built so far. It is the reference to read first
when returning to the project after a break, onboarding help, or starting the
Peach Payments integration.

_Last updated: end of the core-build phase (manual-trigger simulation complete, no real money yet)._

---

## 1. What HNPL does (the model in plain English)

- A **practitioner** records a bill for a **patient** (just patient email + amount). They do not choose how it's split, and they do not track the patient's repayments. They get paid 94% and walk away.
- The **patient** decides whether to split into 2 or 3 instalments, sees the schedule (timed around their payday), and accepts.
- The **first instalment** is collected immediately. **Only once that first payment succeeds** does HNPL pay the practice (the 94%). If the first payment fails, the plan never activates and the practice is never paid.
- HNPL then collects the remaining instalments on the patient's payday schedule. Instalments 2 and 3 are HNPL's concern alone — the practice is already paid.
- The flat fee is **6%, regardless of instalment count**. The practice always nets 94%.

### The core lifecycle (state machine)

```
Doctor records bill
  → plan: pending_acceptance   (no instalment count yet, no payout)

Patient chooses 2 or 3 and accepts
  → plan: pending_first_payment
  → instalment 1: processing   (first debit "in flight")
  → instalments 2,3: scheduled
  → NO payout yet

First payment confirmed SUCCESS  (admin button now / Peach webhook later)
  → instalment 1: collected
  → plan: active
  → payout created: pending     (94% to practice, EFT in flight)

First payment confirmed FAILED
  → instalment 1: failed
  → plan: cancelled
  → no payout

Payout settles
  → payout: paid                (money landed in practice account)

Remaining instalments collected
  → each: scheduled → collected
  → when ALL collected → plan: completed
```

---

## 2. Tech stack

| Layer | Choice |
|---|---|
| Language | TypeScript |
| Framework | Next.js (App Router) — files in `app/`, NOT `src/app/` |
| Path alias | `@/*` maps to the `hnpl/` project root |
| Database | PostgreSQL via Supabase (hosted) |
| Auth | Supabase Auth (email + password) |
| Styling | Tailwind CSS |
| Tests | Vitest |
| Package manager | pnpm |
| Hosting (local) | `pnpm dev` on localhost:3000 |

> **Important structural note:** the project does NOT use a `src/` directory. Pages live at `hnpl/app/...`. Several early bugs came from files being created under `src/` by mistake. When prompting Claude Code, always specify paths like `app/...`, not `src/app/...`.

---

## 3. Project structure (key files)

```
hnpl/
├── app/
│   ├── page.tsx                         (connection test page — can be replaced)
│   ├── (auth)/
│   │   ├── login/page.tsx               Login form
│   │   └── signup/page.tsx              Signup (patient or practitioner)
│   ├── dashboard/
│   │   ├── page.tsx                     Role router — redirects by role
│   │   └── LogoutButton.tsx             Reusable logout button (client)
│   ├── patient/
│   │   ├── page.tsx                     Patient dashboard + acceptPlan/declinePlan actions
│   │   ├── SalaryDayForm.tsx            Patient sets salary day (client)
│   │   └── PlanActions.tsx /            Pending-plan instalment choice + accept/decline (client)
│   │       PendingPlanCard.tsx
│   ├── practice/
│   │   ├── page.tsx                     Practice dashboard (bills, payouts, fee breakdown)
│   │   ├── setup/
│   │   │   ├── page.tsx                 Practice setup + createPractice server action
│   │   │   └── SetupForm.tsx            Practice setup form (client)
│   │   └── bills/new/
│   │       ├── page.tsx                 Bill creation + createBill server action
│   │       └── BillForm.tsx             Bill form: patient email + amount (client)
│   └── admin/
│       ├── page.tsx                     Operations dashboard + all admin server actions
│       └── OpsActions.tsx               Admin action buttons (client)
├── lib/
│   ├── supabase/
│   │   ├── client.ts                    Browser Supabase client
│   │   ├── server.ts                    Server Supabase client (reads cookies)
│   │   └── middleware.ts                Session-refresh helper for middleware
│   ├── finance.ts                       Pure financial functions (TESTED)
│   └── finance.test.ts                  Vitest tests for finance.ts
├── middleware.ts                        Refreshes Supabase session on every request
└── supabase/migrations/                 Numbered SQL migrations (run in Supabase SQL Editor)
```

---

## 4. The financial engine (`lib/finance.ts`)

This is the most safety-critical code. It is **pure** (no database, no side effects) and **tested** against known answers in `lib/finance.test.ts`. Run `pnpm test` to verify.

| Function | Purpose |
|---|---|
| `splitInstalments(total, planType)` | Splits a rand amount into 2 or 3 equal instalments. Works in integer cents internally; any remainder goes on the **first** instalment so the sum is exact. |
| `calculateFee(gross, feePercent)` | Returns `{ gross, fee, net }`. Fee is `gross × feePercent%`. Net is `gross − fee`. |
| `calculatePaymentDates(startDate, salaryDay, planType, bufferDays=5)` | Payment 1 = today. Payment 2 = next salary day at least `bufferDays` after today. Payment 3 = the following salary day. Clamps to month-end (e.g. day 31 → 28 Feb). |

**Rule of thumb:** never reimplement this maths inline. Always import and call these functions. If you change them, the tests must still pass.

---

## 5. Database schema (Supabase / PostgreSQL)

All tables use UUID primary keys (`gen_random_uuid()`), `TIMESTAMPTZ` timestamps, and `NUMERIC(10,2)` for money. **Row Level Security (RLS) is enabled on every table.**

| Table | Purpose |
|---|---|
| `profiles` | One row per user. `role` is one of `patient`, `practice_admin`, `practice_staff`, `admin`. Holds `salary_day` (1–31) for patients. Linked to Supabase `auth.users` by `id`. |
| `practices` | A practitioner's practice. Holds banking details, `fee_percent` (default 6), `status` (auto-`approved` for now), and `owner_id`. |
| `practice_members` | Links users to a practice with a role (`admin`/`staff`). Enables a practice to have multiple staff. |
| `applications` | Original bill request from a practice for a patient. `plan_type` nullable until patient chooses. |
| `plans` | The payment plan. `status` drives the lifecycle (see §1). `plan_type` and `instalment_amount` nullable until acceptance. |
| `payments` | One row per instalment. `status`: `scheduled`, `processing`, `collected`, `failed`, `retried`, `written_off`. |
| `payouts` | The 94% owed to a practice. Created on first-payment success. `status`: `pending`, `processing`, `paid`, `failed`. |

### Roles and what they see

| Role | Lands on | Can do |
|---|---|---|
| `patient` | `/patient` | Set salary day; view plans; choose instalments; accept/decline |
| `practice_admin` | `/practice` (or `/practice/setup` first) | Set up practice; record bills; view payouts & fees |
| `practice_staff` | `/practice` | (Reserved — staff support exists in schema, not yet a built flow) |
| `admin` | `/admin` | Operations: confirm first payments, collect instalments, mark payouts paid |

Admins are **not** self-creatable via signup (security). Create one by signing up normally, then changing `role` to `admin` directly in the Supabase `profiles` table.

---

## 6. Migrations (run in order)

Each is a numbered SQL file in `supabase/migrations/`, run via the Supabase SQL Editor. Never edit a committed migration — only add new numbered ones.

| File | What it does |
|---|---|
| `0001_initial_schema.sql` | Creates all 7 tables, indexes, constraints |
| `0002_rls_policies.sql` | Row Level Security policies for every table |
| `0003_practice_owner_insert_member.sql` | Lets a practice owner insert their first membership row (bootstrap fix) |
| `0004_practice_owner_policies.sql` | Owner can SELECT/DELETE own practice (enables orphan healing + rollback) |
| `0005_add_salary_day.sql` | Adds `salary_day` to `profiles` |
| `0006_bill_creation_policies.sql` | RLS so a practice member can create applications/plans/payments |
| `0007_plan_acceptance.sql` | Adds `pending_acceptance`/`declined` statuses; patient can update own plan/payments |
| `0008_patient_practice_select.sql` | Patient can SELECT practices they're linked to (for name display) |
| `0009_payout_on_accept.sql` | (Superseded by later logic) payout insert policy |
| `0010_nullable_plan_type.sql` | Makes `plan_type`/`instalment_amount` nullable (set at acceptance) |
| `0011_patient_insert_payments.sql` | Patient can insert payment rows for their own plans (on acceptance) |
| `0013_first_payment_status.sql` | Adds `pending_first_payment` status; admin update policies |

> Note: migration `0012` may or may not exist depending on whether the admin-update policies were already present when `0013` ran. Check your `supabase/migrations/` folder for the actual files present.

---

## 7. Key architectural decisions (and why)

**Server Actions for all important writes.** Database writes that matter (creating practices, bills, plans, payouts, accepting plans, admin actions) go through Next.js Server Actions using the server-side Supabase client, not browser-side inserts. This is more secure and more reliable — the server always has the right session and can enforce rules the browser can't bypass.

**Defence in depth on access control.** Every protected page checks (a) is the user logged in, and (b) is their role correct for this page. Every privileged Server Action **re-verifies the role server-side** before any write — the UI disabling a button is never the only protection.

**RLS on every table.** The database itself enforces who can read/write what, independent of app-code bugs. Most of the early friction in the build was getting RLS policies right — but the result is that data access is locked down at the lowest level.

**Payout gated on first-payment success.** The practice is paid only after the patient's first debit clears. This encodes HNPL's risk model: a real, working payment method must be proven before HNPL commits its own capital to the practice.

**Money handled in integer cents.** All arithmetic in `finance.ts` converts to cents, computes, then converts back — avoiding floating-point rounding errors that compound badly in finance.

**Manual admin buttons = webhook stand-ins.** The admin "Confirm payment / Mark collected / Mark paid" actions are deliberate placeholders for Peach Payments webhooks. See §9.

---

## 8. How to run the project

```powershell
# from the hnpl/ folder
pnpm install        # first time / after pulling changes
pnpm dev            # start the dev server -> http://localhost:3000
pnpm test           # run the finance engine tests
```

Environment variables live in `hnpl/.env.local` (never committed):

```
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...       # sensitive — server only
NEXT_PUBLIC_GOOGLE_PLACES_KEY=...   # browser — Places API (New) — MUST be HTTP-referrer-restricted
GOOGLE_GEOCODING_SERVER_KEY=...     # server only — Geocoding API — MUST NOT be referrer-restricted; used ONLY by /api/reverse-geocode
```

The two Google keys are separate on purpose: the browser Places (New) key can be safely referrer-restricted; the legacy Geocoding REST endpoint (used server-side to turn a coord into a "Suburb, City" label) REJECTS referrer-restricted keys. Never mix them.

### Test accounts used during development
- Patient: `test1@test.com` / `test1234`
- Practitioner: `test2@test.com` / `test1234`
- Admin: `admin@hnpl.co.za` / `admin1234` (role manually set to `admin` in Supabase)

---

## 9. Where Peach Payments plugs in later

The manual admin actions map directly onto Peach webhooks. The plan: extract each action's core logic into a shared function, then have BOTH the admin button and the Peach webhook handler call it.

| Manual admin action (now) | Peach webhook (later) | Core logic |
|---|---|---|
| Confirm first payment | `PAYMENT.RECEIVED` (instalment 1) | Mark instalment 1 collected → activate plan → create payout (pending) |
| First payment failed | `PAYMENT.FAILED` (instalment 1) | Mark instalment 1 failed → cancel plan → no payout |
| Mark collected (2/3) | `PAYMENT.RECEIVED` (instalment 2/3) | Mark instalment collected → complete plan if last |
| Mark payout paid | `PAYOUT.PAID` | Mark payout paid |

When Peach is added:
- A new endpoint `/api/webhooks/peach` verifies the Peach signature, identifies the payment/plan, and calls the shared core logic.
- The mandate (DebiCheck) is created on patient acceptance; the first debit fires immediately; its success/failure webhook drives the lifecycle.
- The admin buttons remain as a **manual override / reconciliation tool** for missed webhooks and disputes — they don't disappear.

---

## 10. Known shortcuts and things to harden (the polish backlog)

These are deliberate simplifications taken to keep the core build moving. Address before real users / real money:

- [ ] **Email confirmation is OFF** in Supabase Auth (turned off so test signups didn't need inbox confirmation). Turn back on before launch.
- [ ] **Practices auto-approve** (`status = 'approved'` on creation). Real flow needs an HNPL admin review/approval gate.
- [ ] **SA ID numbers stored as plain text.** Must be encrypted at rest before holding real PII. Never logged.
- [ ] **No real payments** — all collection is simulated via admin buttons (by design at this stage).
- [ ] **No notifications** — patients/practices aren't emailed or SMS'd on key events (bill created, plan accepted, payment due/failed, payout sent).
- [ ] **Admin dashboard is functional but rough** — layout and presentation to be refined (current polish task).
- [ ] **No "invite new patient" flow** — a bill can only be created for a patient who already has an account (exact email match). Inviting unregistered patients is a future enhancement.
- [ ] **Bill creation is email-only lookup** — adding SA-ID-number lookup is a planned quick follow-up.
- [ ] **No production hardening** — rate limiting, fraud checks (duplicate applications), monitoring/error tracking all still to come.
- [x] **Card-registration return-trip race condition** — fixed. Both `/patient/payment-methods/complete` and `/patient/orders/[planId]/confirm` now poll `/api/payment-methods/recent` (every 1 s, up to 10 s) for the card row to appear after Paystack redirects back. The server component still does an immediate DB check first (fast path when the webhook wins the race). On the confirm page, once the card appears `router.refresh()` re-fetches the server component and auto-selects the new card.

---

## 11. Status summary

**Done and working (simulated, no real money):**
Authentication, role-based routing, security (UI + RLS + server-side), practice onboarding, patient salary-date scheduling, tested financial engine, doctor records bill, patient chooses split and accepts, payout gated on first-payment success, full collection lifecycle to completion, admin operations back-office. Both the happy path and the first-payment-failure path work end to end.

**Current phase:** polishing rough edges (Option 2) before validating with real people and, later, integrating Peach Payments for real money.