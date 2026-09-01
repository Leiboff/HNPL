# HNPL / betternow — adversarial security audit

**Date:** 2026-09-01
**Scope:** the whole repository at `claude/web-app-security-audit-nxb6d0` (157,835 LOC across `app/`, `lib/`, `components/`, 120 SQL migrations, 17 API routes, 35 Server Action modules).
**Method:** static review of every auth, authorization, money, KYC and webhook path, plus executable proof-of-concept tests run against real PostgreSQL (pglite) as a non-superuser role.
**Constraint honoured at audit time:** no production code was changed. Two adversarial test files were added; the existing suite was run green before and after.

---

## 0. Remediation status — updated 2026-09-01, same day

Every finding below has been acted on. The audit text is left as it was
written, because a report that quietly rewrites itself to match the fix is
no longer a record of what was wrong — and the reasoning for each fix only
makes sense against the defect it answers. What each finding got is stated
in a **Status** line directly under its heading.

**Fixed in code / schema — 17 of 19.** Four new migrations (0121-0124),
three new library modules, twenty application files, one dependency
upgrade plus four transitive overrides, and 48 regression assertions across
three test files that pin the refusals.

**Not fixable from the repository — 2 of 19,** both configuration rather
than code, and both still open:

- **F-16 (MFA for admin and sales)** — a Supabase Auth project setting. The
  code-side half is done: `guardAdmin()` and the CRM guards were already
  correct and were re-verified. Enabling MFA enrolment for
  `role IN ('admin','sales')`, and the step-up on money-moving actions that
  depends on it, needs the dashboard first.
- **F-18 (email confirmation, practice approval)** — also dashboard state.
  The trading gate in code already requires `practices.status = 'approved'`
  plus a provider on staff plus resolvable banking, so the code-side gate
  holds; what remains is confirming the deployed project has email
  confirmation ON and that `approvePractice` is a real human step.

**One fix is partial and needs a decision — F-15 (`xlsx`).** The npm
registry's newest `xlsx` is 0.18.5 and carries both advisories; SheetJS
left npm at 0.20, so the fixed builds exist only on the vendor's own CDN.
Repointing a dependency at a non-registry URL changes where this project
installs from and would make every Vercel deploy depend on
`cdn.sheetjs.com` being reachable — that is a supply-chain call for a
human, not a lockfile edit to slip in, and the sandbox this work ran in
blocked it besides. What was done instead: `lib/crm/xlsxToCsv.ts` now caps
workbook size and refuses any workbook that disturbs `Object.prototype`
while parsing, and both import screens surface the refusal. That bounds the
exposure; it does not close the advisories.

### Two things worth knowing before reading the fixes

**The rate limiter fails open, deliberately.** `consume_rate_limit` returning
a permit on error, `clientIp()` returning null when `next/headers` is
unavailable, and `consumeAll` allowing through when it cannot even build a
Supabase client — all three are decisions, not oversights. These limits sit
in front of signup, the contact form and the checkout door; a database blip
that locked every one of them would be a worse and far more likely outage
than the abuse they damp. The limits that must NOT fail open — OTP sends,
OTP verify attempts, till PIN attempts — are untouched and still enforced
in SQL.

**Two fixes were corrected during implementation, and both are pinned by
tests so they cannot regress quietly:**

- The first cut of the F-06 guard refused any plan with a `processing`
  payment row. That reads sensible and is wrong: `processing` is the status
  `initiateCheckout` itself writes for instalment 1, so every genuine
  abandoner sits in it, and refusing on it would have broken the one
  re-entry the action exists to support. What makes admitting it safe is the
  pairing with `peach_registration_id`, which both completion paths stamp on
  a charge that actually landed.
- The two new refusals on `/checkout/[token]/complete` initially reused an
  error card reading "the bill is still unpaid — try again". Both happen
  *after* a successful charge, so that copy would have produced exactly the
  duplicate payment the refusal exists to prevent.

### What landed

| Migration | Closes |
|---|---|
| `0121_lock_plans_and_payments.sql` | F-01, F-02, F-03 |
| `0122_profiles_column_allowlist.sql` | F-05 |
| `0123_peach_webhook_events.sql` | F-09b |
| `0124_rate_limits.sql` | F-14, F-17 |

The single most important change is that **the patient no longer holds a
write primitive over their own ledger**. `patients_update_own_plans`,
`patients_update_own_payments` and `patients_insert_payments_for_own_plans`
are dropped; the writes they used to permit moved to the privileged client
inside the same server actions, which still do every READ through the
session client so RLS remains what establishes ownership. Triggers back
that up in case a policy is ever re-added.

The second most important is that **`profiles` is now an allow-list**.
Nine columns are user-editable; everything else, including every column
added in future, is locked by default. F-05 is what a deny-list costs.

---

## 1. Executive summary

### Overall security level: **CRITICAL as audited — see §0 for what has since been fixed**

This is, in most respects, a carefully built and unusually well-reasoned codebase. Webhook signatures are verified with constant-time compares, cron endpoints are secret-gated, SA ID numbers are AES-256-GCM encrypted with a separate HMAC blind index, OTP codes are peppered and never stored in plaintext, invitation tokens are 32 random bytes behind `SECURITY DEFINER` lookup functions, the terms gate is enforced with strict equality on three separate signup paths, and there is a real absolute session cap enforced server-side. Several previous audits are visible in the migration history and their fixes held up under re-testing.

The problem is that all of that careful work sits on top of **two Row Level Security policies that hand the customer a write primitive over their own money**, and one column-lock trigger that guards four columns while leaving eight others that decide identity and creditworthiness wide open.

The application layer is not the security boundary here and cannot be. `NEXT_PUBLIC_SUPABASE_ANON_KEY` is in the browser bundle by construction (`lib/supabase/client.ts:11`). Every authenticated patient can therefore speak PostgREST directly — `PATCH /rest/v1/plans`, `PATCH /rest/v1/profiles` — and never touch a Server Action at all. Every Server Action guard in this repo is bypassed by that one move. What is left is RLS, and RLS in Postgres has no column-level restriction inside a policy.

### Biggest weaknesses

1. **`patients_update_own_plans` and `patients_update_own_payments` (migration 0007) are column-unrestricted.** A patient can set their own plan to `completed`, zero out `total_amount`, or mark every instalment `collected`. Proven, see §3 F-01/F-02.
2. **The KYC/affordability gate is stored in columns the patient can write.** `liveness_verified_at`, `sa_id_number`, `credit_check_status`, `salary_amount` and `onboarding_completed` are all owner-writable. Proven, see §3 F-05.
3. **`initiateCheckout` has no plan-status precondition and destructively deletes the payment schedule.** An already-activated, already-paid-out plan can be reset and then cancelled. See §3 F-06.
4. **`/checkout/[token]/complete` establishes an authenticated session for an arbitrary patient** based only on an attacker-supplied `checkoutId`; the `token` in the path is never validated against anything. See §3 F-07.
5. **Nothing enforces `approved_credit_limit`.** It is written by the credit check, displayed on the dashboard, and read by no gate anywhere.

### Biggest financial risks

The headline chain (§10, AC-1) lets a patient pay **R1.00** on a **R10,000** bill while HNPL pays the practice **R9,400** and the remaining instalments are self-marked collected. It needs no race, no timing, no special tooling — four HTTP requests with a browser session cookie.

### Biggest privacy risks

Lower than the financial risk, and that is a genuine credit to the work already done: 0049 closed the `patient_invitations` bulk read, 0093 closed the uncorrelated cross-tenant profile read, and SA IDs are encrypted at rest with a keyed blind index. The residual exposure is the session-establishment defect (F-07), which yields a whole patient account including decrypted ID display, and the absence of any security headers (F-11), which leaves XSS unmitigated against a `httpOnly: false` session cookie.

### Biggest authentication risks

Account *takeover* via the normal login surface looks well defended — no enumeration on password reset, OTP attempt caps and burn caps enforced in SQL rather than in the UI, global revocation on logout and on password change, a server-side absolute session cap. The exposure is elsewhere: the unauthenticated session-minting path in F-07, and the fact that the Supabase auth cookie is JS-readable for 400 days, which makes any XSS a full account compromise (mitigated, but not closed, by the session cap).

---

## 2. Attack-surface inventory

### 2.1 HTTP route handlers

| Route | Method | Auth | Role | State | Money | PII | Notes |
|---|---|---|---|---|---|---|---|
| `/api/payments/peach/webhook` | POST | HMAC-SHA256 | — | yes | **yes** | card meta | Signature verified; **no amount/currency check**, no replay ledger (F-09) |
| `/api/verification/didit/webhook` | POST | HMAC-SHA256 + ts skew | — | yes | no | **SA ID** | Replay-guarded; **dedupe ordering bug** (F-13) |
| `/api/cron/collect-instalments` | GET/POST | `CRON_SECRET`, timing-safe | — | yes | **yes** | no | Fires real card charges. Correctly gated |
| `/api/cron/payout-batches` | GET/POST | `CRON_SECRET`, timing-safe | — | yes | **yes** | no | Correctly gated; `?weekEnding=` backfill param |
| `/api/cron/crm-reply-poll` | GET/POST | `CRON_SECRET`, timing-safe | — | yes | lead PII | Correctly gated |
| `/api/crm/gmail/push` | POST | Google OIDC bearer | — | yes | email | Audience + SA email verified |
| `/api/crm/gmail/connect` | GET | session | sales/admin | yes | no | State cookie minted |
| `/api/crm/gmail/callback` | GET | session | sales/admin | yes | no | State compared to cookie **and** to `user.id` |
| `/api/crm/gmail/disconnect` | POST | session | sales/admin | yes | no | |
| `/api/push/subscribe` | POST | session | any | yes | no | **Upsert can reassign another user's row** (F-12) |
| `/api/push/unsubscribe` | POST | session | any | yes | no | Correctly scoped by `user_id` |
| `/api/payment-methods/recent` | GET | session + email-confirmed | patient | no | card meta | RLS-scoped |
| `/api/reverse-geocode` | GET | session | any | no | coords | Per-user in-memory limit, 30/5min |
| `/api/auth/logout` | POST | none (by design) | — | yes | no | Global revoke; fail-safe |
| `/auth/callback` | GET | PKCE code | — | yes | no | `safeNext` blocks open redirect |
| `/auth/require-terms` | GET | session | — | yes | no | Re-verifies before signing out — safe as a GET |

### 2.2 Server Actions (35 modules, 100 exported actions)

Every `'use server'` export is an addressable POST endpoint. I checked all 100 for a guard. Results:

- **Guarded, correct:** 96.
- **Deliberately public** (documented, token- or honeypot-gated): `signUpPatient`, `submitPublicLead`, `submitContactEnquiry`, `resendConfirmation`, `initiateCheckout`, `requestPhoneOtp`, `verifyPhoneOtp`, `redeemDeviceRegistrationCode`, `unlockTill`, `getPracticeInvitationByToken`, `createPractice`.
- **Unguarded and should not be:** `inviteMemberIntoPractice` and `inviteLoginForRosterMember` in `lib/brand/inviteMember.ts` — see F-08.

### 2.3 Anon-callable database RPCs

All eight are token-gated and correct in shape:

`get_invitation_by_token`, `get_checkout_session_by_token`, `get_practice_invitation_by_token`, `stamp_checkout_session_scanned`, `stamp_invitation_viewed`, `prepare_phone_verification`, `verify_phone_otp`, `redeem_till_registration_code`.

`redeem_till_registration_code` is the one with no rate limit in front of it (F-14).

### 2.4 The endpoints that are most dangerous

1. `PATCH /rest/v1/plans` and `PATCH /rest/v1/payments` — **not application endpoints at all**, but reachable by every patient with the bundled anon key. This is the top of the list.
2. `/checkout/[token]/complete` — unauthenticated, mints sessions.
3. `initiateCheckout` — unauthenticated, creates auth users, deletes payment rows.
4. `inviteMemberIntoPractice` — unauthenticated, creates practice members.
5. `/api/payments/peach/webhook` — signature-gated but amount-blind.

---

## 3. Findings

### F-01 — Patients can rewrite their own plan, including its status and amount

**Status: FIXED** — `supabase/migrations/0121_lock_plans_and_payments.sql` drops the policy and adds `protect_plans_write()`; the writes moved to the privileged client in `app/patient/actions.ts`, which also gained the `.eq('status', …)` claim. Pinned by `AUDIT F-01` in `security-audit-2026-09.rls.test.ts`.

**Severity: CRITICAL**

**Location:** `supabase/migrations/0007_plan_acceptance.sql:25-29`

```sql
CREATE POLICY "patients_update_own_plans" ON plans
    FOR UPDATE
    USING (patient_id = auth.uid())
    WITH CHECK (patient_id = auth.uid());
```

**What is wrong.** The policy restricts *which row* the patient may write, and says nothing about *which columns*. Postgres RLS cannot express a column restriction inside a policy and `WITH CHECK` cannot compare old to new — this is exactly the gap migration 0054 was written to close for `profiles` and `practices`. It was never applied to `plans`. There is no `BEFORE UPDATE` trigger on `plans` anywhere in the 120 migrations (`grep 'CREATE TRIGGER' supabase/migrations/*.sql` returns none for this table).

**How an attacker exploits it.** The anon key is in the browser bundle. The patient's own JWT is in a cookie that `@supabase/ssr` writes with `httpOnly: false`, so JavaScript in their own devtools can read it. That is all that is needed:

```
PATCH /rest/v1/plans?id=eq.<their-own-plan-id>
apikey: <NEXT_PUBLIC_SUPABASE_ANON_KEY>
Authorization: Bearer <their own access token>
Content-Type: application/json

{"status":"completed","completed_at":"2026-09-01T00:00:00Z"}
```

**Example attack scenario.** A patient takes a R10,000 bill at a dermatology practice, pays the first R3,333 instalment, and the practice is paid its R9,400. That night they open devtools, copy the access token, and PATCH the plan to `completed`. The collection cron's query filters on `plan.status = 'active'` (`app/api/cron/collect-instalments/route.ts`), so it never looks at this plan again. Instalments 2 and 3 are never attempted, never fail, never enter the dunning ladder, and never freeze the account. Nothing alerts.

**Potential impact.** Uncapped, and it scales with the book. Every rand of outstanding instalment on the platform is erasable by its debtor. `total_amount` is also writable, which additionally corrupts the payout figure that `activateFirstInstalment` computes at `lib/payments/activateFirstInstalment.ts:114`.

**Recommended fix.** Two layers, both needed:

1. Replace the blanket UPDATE policy with a narrow one. The patient has no legitimate direct write to `plans` at all — every real transition (`acceptPlan`, `payWithSavedCard`, `declinePlan`) is a Server Action that could run through the service-role client or a `SECURITY DEFINER` RPC. Dropping the policy outright is the cleanest fix; the actions must be re-pointed at a privileged client in the same migration.
2. Add a `BEFORE UPDATE` trigger modelled on `protect_profiles_columns()` (0054) that rejects any non-privileged change to `status`, `total_amount`, `instalment_amount`, `plan_type`, `patient_id`, `practice_id`, `provider_member_id`, `peach_registration_id`, `peach_initial_transaction_id`, `completed_at`, `terms_accepted_at`, `terms_version`, `privacy_version`, `invoice_number`. Use the same `auth.role() = 'service_role' OR current_setting('app.privileged_write', true) = 'on'` bypass so the existing service-role writers keep working.

**How to test the fix.** `supabase/migrations/security-audit-2026-09.rls.test.ts` describe-block `AUDIT F-01`. Its first two tests assert the exploit **succeeds**; after the fix they must fail, and the third test (cross-patient write is refused) must still pass. Invert the first two assertions as the regression guard.

---

### F-02 — Patients can mark their own instalments collected and zero their amounts

**Status: FIXED** — same migration drops both payments policies and adds `protect_payments_write()`. The missing amount comparison is closed separately by F-09a: the webhook now verifies what settled against `chargeAmountCents(payment.amount, dunning_fees_cents)` before any state flip. Pinned by `AUDIT F-02`.

**Severity: CRITICAL**

**Location:** `supabase/migrations/0007_plan_acceptance.sql:36-40`; insert counterpart at `supabase/migrations/0011_patient_insert_payments.sql:5-12`

Same defect as F-01, on `payments`. The exploit is one statement:

```
PATCH /rest/v1/payments?patient_id=eq.<self>&status=neq.collected
{"status":"collected","collected_at":"2026-09-01T00:00:00Z"}
```

**Why this one is worse than F-01.** `amount` is also writable, and `initializeFirstPayment` reads the charge amount straight off the row it is about to charge:

```ts
// app/patient/actions.ts:238
const amountCents = Math.round(Number(payment.amount) * 100);
```

So the patient sets `payments.amount = 1.00` **before** initiating payment, is charged R1.00, and the success path then runs `activateFirstInstalment`, which marks the plan active and inserts a payout for 94% of the *unmodified* `plans.total_amount`. The two numbers are never compared, at any point, in any code path.

`patients_insert_payments_for_own_plans` compounds it: the patient can also insert arbitrary rows, and there is no `UNIQUE (plan_id, instalment_number)` constraint to stop them (F-03).

**Impact.** Direct, immediate loss to HNPL of the full 94% payout on any bill, with the patient's own outlay set to whatever clears the processor minimum.

**Recommended fix.** Drop `patients_update_own_payments` and `patients_insert_payments_for_own_plans` entirely. No patient flow needs a direct client write to `payments` — `acceptPlan` and `payWithSavedCard` both already run through paths that can use the service-role client. Add the same column-lock trigger as a second layer. Separately, make `activateFirstInstalment` verify the settled amount against the expected instalment before creating a payout.

**How to test.** `AUDIT F-02` block in the same file.

---

### F-03 — `payments` has no uniqueness constraint on `(plan_id, instalment_number)`

**Status: FIXED** — `payments_plan_instalment_uniq` (partial on `kind='instalment'`, so settlement rows are unaffected), plus the status precondition and `.select('id')` claim on both `acceptPlan` and `payWithSavedCard`. The migration refuses to install the index if duplicates already exist rather than skipping it. Pinned by `AUDIT F-03`.

**Severity: HIGH**

**Location:** `supabase/migrations/0001_initial_schema.sql` (`payments` table definition — the only UNIQUE constraints anywhere in that file are `profiles.email` and `practice_members (practice_id, user_id)`)

**What is wrong.** Nothing at the database level stops two rows claiming to be instalment 1 of the same plan. That turns two separate application-level check-then-act races into duplicated schedules instead of constraint violations:

- `acceptPlan` (`app/patient/actions.ts:104-170`) selects the plan `WHERE status = 'pending_acceptance'`, then updates it **without** re-asserting that status in the `WHERE` clause (`.eq('id', planId).eq('patient_id', user.id)` — line 160-161), then inserts the schedule. Two concurrent calls both pass the select, both update, and both insert. The plan ends up with 4 or 6 payment rows.
- `payWithSavedCard` has the identical shape at `app/patient/actions.ts:585-600`.
- `isBlockedFromNewPlan` (line 73) is a pure check-then-act with no lock, so two concurrent `acceptPlan` calls on two different pending plans both pass the one-plan-at-a-time rule.

**Impact.** Duplicated debits against the customer, a corrupted "is the plan complete" count (the completion check is `select ... neq status collected` — extra rows keep a finished plan open forever), and a bypassed velocity limit.

**Recommended fix.**
```sql
CREATE UNIQUE INDEX payments_plan_instalment_uniq
  ON payments (plan_id, instalment_number)
  WHERE kind = 'instalment';
```
(partial, because settlement rows share the table). Then add `.eq('status','pending_acceptance')` to the plan UPDATE in both actions so the loser of the race gets zero rows and returns cleanly.

**How to test.** `AUDIT F-03` block asserts the duplicate insert currently succeeds; it must fail after the index lands.

---

### F-04 — (Not a finding — recorded because it is load-bearing)

The `protect_profiles_columns()` trigger from 0054/0065 **does** hold on the four columns it names: `role`, `email`, `phone_verified_at`, `approved_credit_limit`. Verified against real Postgres, non-superuser, with the verbatim trigger body — `AUDIT F-04` block in `security-audit-2026-09-profiles.rls.test.ts`. Privilege escalation to `role = 'admin'` is genuinely closed. This test exists so that F-05 below cannot be dismissed as a broken harness.

---

### F-05 — The entire KYC and affordability gate is stored in patient-writable columns

**Status: FIXED** — `0122_profiles_column_allowlist.sql` inverts the lock. Nine columns stay writable (name, phone, `must_change_password`, the passkey counters); everything else is refused, by comparing `to_jsonb(NEW)` against `to_jsonb(OLD)` so a column added later is locked without anyone remembering. `saveSalaryDay` / `saveSalaryAmount` moved to the privileged client rather than being allow-listed, so their validators are authoritative. Pinned by `AUDIT F-05`, `F-05b` (the exemptions still work), `F-05c` (a new column is locked by default) and `F-05d`.

**Severity: CRITICAL**

**Location:** `supabase/migrations/0065_credit_limit_and_passkey_prompt_cap.sql:66-101` (the trigger body), read against `lib/onboarding/state.ts:205-228` (`stepIsSatisfied`) and `:231-233` (`computeOnboarding`)

**What is wrong.** `computeOnboarding` decides whether a patient may take credit. It reads seven fields. The column lock protects **one** of them (`phone_verified_at`). The other six — `sa_id_number`, `liveness_verified_at`, `salary_day`, `salary_amount`, `credit_check_status`, and the `onboarding_completed` short-circuit — are all writable by the row's owner under `users_update_own_profile`.

The code comment at `lib/onboarding/state.ts:222-226` states the invariant it believes it has:

> *"Neither can be set by the patient typing into a form."*

That is true of the form. It is not true of `PATCH /rest/v1/profiles`.

**How an attacker exploits it.** Sign up with an email and a password. Skip onboarding entirely. Then:

```
PATCH /rest/v1/profiles?id=eq.<self>
{"sa_id_number":"v1:anything",
 "sa_id_lookup_hash":"<any 64 hex chars>",
 "liveness_verified_at":"2026-09-01T00:00:00Z",
 "identity_verification_status":"approved",
 "salary_day":25,
 "salary_amount":90000,
 "credit_check_status":"passed",
 "onboarding_completed":true}
```

`onboarding_completed: true` alone is sufficient — `computeOnboarding` returns `{done: true}` on line 232 before evaluating anything else. `requireOnboarded` (`app/patient/actions.ts:36-71`), which is the server-side gate on `acceptPlan` and `payWithSavedCard`, then passes.

**Example attack scenario.** An organised fraud ring scripts signup with disposable mailboxes, PATCHes each new profile to onboarded, and walks into practices with QR bills. No Didit session is ever created, no DHA record is ever matched, no face is ever compared, no SA ID is ever real. Because `sa_id_lookup_hash` is attacker-chosen, the one-ID-per-account unique index (0097) is trivially satisfied with a fresh random value per account, so the duplicate-account control is defeated in the same request. Each account then draws bills that HNPL pays out at 94% and can never collect.

**Potential impact.** This is the control that makes the whole product lawful and solvent. It also nullifies the NCA affordability posture and the FICA identity posture at once — the columns that record "we verified this person" can be written by that person.

**Recommended fix.** Extend `protect_profiles_columns()` to reject non-privileged writes to: `sa_id_number`, `sa_id_lookup_hash`, `pending_sa_id_number`, `pending_sa_id_lookup_hash`, `liveness_verified_at`, `identity_verification_status`, `identity_verification_reason`, `identity_verification_path`, `dha_face_match_score`, `credit_check_status`, `salary_amount`, `salary_day`, `onboarding_completed`. All of these already have a service-role or `SECURITY DEFINER` writer (the Didit webhook, `runCreditCheck`, `saveSalaryDetails`), so nothing legitimate breaks.

The better long-term shape is to invert the default: lock *every* column on `profiles` and allow-list the handful a patient may edit (`first_name`, `last_name`, `phone`, and the three passkey-prompt counters). A deny-list has to be extended every time a column is added, and this finding is exactly what happens when someone forgets.

**How to test.** `AUDIT F-05` block in `security-audit-2026-09-profiles.rls.test.ts`. Both tests assert the write currently succeeds; both must fail after the fix while every `AUDIT F-04` test still passes.

---

### F-06 — `initiateCheckout` accepts an already-active plan and deletes its payment history

**Status: FIXED**, from both ends. `initiateCheckout` now allow-lists `pending_acceptance` and an uncaptured `pending_first_payment`, scopes the schedule delete to `scheduled`/`failed`, and refuses if anything survives it. Separately, `activateFirstInstalment` closes the invitation and the counter session itself, so the webhook path no longer leaves a live token behind — which was the situation the exploit needed.

**Severity: CRITICAL**

**Location:** `app/checkout/[token]/actions.ts:373` (the status guard) and `:700` (the delete)

```ts
// :373 — the only status precondition in the whole action
if (plan.status === 'completed' || plan.status === 'cancelled' || plan.status === 'declined') {
  return { ok: false, error: 'This bill has already been settled or cancelled.' };
}
...
// :700 — unconditional
await svc.from('payments').delete().eq('plan_id', plan.id);
```

**What is wrong.** `active` and `pending_first_payment` both pass the guard. The action then wipes every payment row for the plan — including a `collected` instalment 1 — resets `plans.status` to `pending_first_payment`, writes a fresh schedule, and opens a new Peach checkout. It runs unauthenticated, on the strength of the token alone.

**Why the token is still live when the plan is active.** The invitation is marked accepted, and the POS session advanced to `completed`, **only** by the browser return page `app/checkout/[token]/complete/page.tsx:263` and `:274`. The Peach webhook's `handlePaymentSuccess` does neither. So whenever the plan is activated by the webhook rather than by the browser — the tab was closed, the redirect was blocked, the phone lost signal, or the patient simply pressed back — the invitation stays `accepted_at IS NULL` and unexpired for the rest of its **7-day** TTL (`app/practice/bills/new/actions.ts:504`).

**Example attack scenario.** Patient receives an emailed bill for R6,000, opens the link, pays the R2,000 first instalment on their phone, and closes the tab the moment the card clears. The webhook lands: instalment 1 `collected`, plan `active`, and a `payouts` row for R5,640 created and queued for Thursday's batch. Two days later the patient re-opens the same email link. `initiateCheckout` runs: the collected R2,000 row is deleted, the plan drops back to `pending_first_payment`, a new checkout opens. They enter a card they know will decline. `handlePaymentFailure` sees `instalment_number === 1` and `status === 'pending_first_payment'`, marks the payment failed and sets **`plans.status = 'cancelled'`**. The debt is gone. The `payouts` row is untouched — `payouts.plan_id` is UNIQUE (0087) and nothing reverses it — so the practice is paid R5,640 in full on Thursday against a cancelled plan.

**Potential impact.** The full 94% of any bill, per bill, with the patient's outlay refunded to zero in accounting terms and no record that they ever paid. It also silently destroys the payment audit trail, which is a records problem independent of the money.

**Recommended fix.**
1. Add `pending_first_payment` and `active` to the refusal at `:373` — or better, invert it to an allow-list of exactly `pending_acceptance`. A plan that has moved past acceptance belongs to `resumeFirstInstalmentCapture`, which already guards correctly on `plan.status === 'pending_first_payment' AND peach_registration_id IS NULL` (`:962`) and touches no rows.
2. Never delete a `collected` payment. Scope the delete to `.in('status', ['scheduled','processing'])` at minimum.
3. Close the token when the **webhook** activates a plan, not only when the browser comes back. Move the `patient_invitations.accepted_at` and `checkout_sessions.stage = 'completed'` writes into `activateFirstInstalment` so all three activation paths share them.

**How to test.** Integration test: seed an `active` plan with a `collected` instalment 1 and a live invitation token; call `initiateCheckout`; assert it returns an error and that the `collected` row still exists.

---

### F-07 — `/checkout/[token]/complete` mints a session for whoever supplies a valid `checkoutId`

**Status: FIXED** — the page resolves the path token through `lib/checkout/resolveTokenPlan.ts` and refuses unless it points at the same plan as the payment. The session fallback no longer resets the patient's password (it mints a magic-link token via `admin.generateLink` and redeems it, mutating nothing), and a different signed-in user is refused instead of silently switched.

**Severity: HIGH**

**Location:** `app/checkout/[token]/complete/page.tsx:88-95` (input), `:169-180` (lookup), `:283-297` (session establishment)

**What is wrong.** This is an unauthenticated Server Component page. It takes `checkoutId` from the query string, asks Peach for that checkout's status, resolves `merchantTransactionId` to a `payments` row, and derives `patientId` from it. It then:

```ts
// :283-297
const { data: { user } } = await supabase.auth.getUser();
if (!user || user.id !== patientId) {
  const { data: profile } = await svc.from('profiles').select('email').eq('id', patientId).single();
  if (profile?.email) {
    const tempPwd = generateTempPassword();
    const { error: updErr } = await svc.auth.admin.updateUserById(patientId, { password: tempPwd });
    if (!updErr) {
      await supabase.auth.signInWithPassword({ email: profile.email, password: tempPwd });
    }
  }
}
```

The `token` in the path — the only thing that could bind this request to a specific bill — is used for the invitation update and the final redirect, and **is never compared to the payment, the plan, or the patient**. `/checkout/anything-at-all/complete?checkoutId=<id>` reaches the same code.

So the check reads: *if you are not already the patient, become them*. It also resets that patient's password as a side effect, which locks the real owner out of their own account until they use a reset link.

**Contrast with the sibling route.** `app/patient/payment-complete/page.tsx:189-192` handles the same return trip and gets it right:

```ts
const { data: { user } } = await supabaseUser.auth.getUser();
if (!user || user.id !== payment.patient_id) return;
```

Same problem, same file shape, opposite decision. The anonymous route needed to establish a session where the authenticated one did not, and the ownership check was dropped rather than replaced with a token-binding check.

**How an attacker exploits it.** They need one valid `checkoutId` for a successful payment. It is not a secret in practice — it is a query parameter on a URL the victim's browser visited, so it lives in browser history, in any `Referer` sent from that page, in Vercel access logs, in a screenshot of the confirmation screen, and in the response body of `initiateCheckout` itself. The QR flow is explicitly designed around a shared physical counter, which is the worst possible setting for a history-borne credential.

**Example attack scenario.** A practice receptionist demonstrates the flow on the front-desk browser for a patient who is unsure about the QR. The patient completes payment on that shared machine. Later the receptionist opens history, finds `/checkout/…/complete?checkoutId=…`, and re-visits it. They are now signed in as that patient: full order history, saved card metadata, decrypted-for-display SA ID, contact details, and the ability to add a card and take new credit in the patient's name.

**Potential impact.** Full account takeover with no credential, plus a denial-of-service on the victim (their password is silently rotated).

**Recommended fix.**
1. Resolve the plan from the **token** first — reuse `resolveCheckoutToken` — and refuse if `payment.plan_id` does not equal the token's `plan_id`. This is the binding that is missing and it costs one query.
2. Do not sign anybody in from a GET page. If the session really can drop mid-widget, hand back a single-use, short-TTL, server-generated continuation token issued during `initiateCheckout` and stored alongside the checkout, and require it here.
3. Never call `updateUserById({password})` on a request whose only input is a query parameter.

**How to test.** Request `/checkout/<unrelated-valid-token>/complete?checkoutId=<a different patient's completed checkout>` with no cookies; assert no `Set-Cookie` for an auth token and no password change on the target user.

---

### F-08 — `lib/brand/inviteMember.ts` exports unauthenticated Server Actions that create practice members

**Status: FIXED** — the `'use server'` directive is removed, so the two exports are ordinary server functions reachable only from server code. The two guarded actions that call them are unchanged and remain the only doors.

**Severity: HIGH**

**Location:** `lib/brand/inviteMember.ts:1` (`'use server'`), `:73` (`inviteMemberIntoPractice`), `:262` (`inviteLoginForRosterMember`)

**What is wrong.** The file's own header states the design:

> *"The helper is GUARD-AGNOSTIC — the caller does all authz work BEFORE calling here."*

That is a valid contract for a plain module. It is not valid for a `'use server'` module, because every export of one is an independently addressable HTTP endpoint. `inviteMemberIntoPractice({ practiceId, memberRole: 'manager', canManagePractice: true, email, ... })` performs zero authorization checks of its own — I grepped the whole function for `getUser`, `auth.`, `role`, and any guard: there are none, only service-role client calls.

Invoked directly it calls `service.auth.admin.inviteUserByEmail` and inserts a `practice_members` row on the named practice.

**Reachability.** Next.js Server Action IDs are build-time hashes rather than guessable names, so this is not trivially callable — but it is not a security boundary either, and the pinned Next version (16.2.6) carries advisory **GHSA — "Unauthenticated disclosure of internal Server Function endpoints"**, fixed in 16.2.11 (see F-15). Treat the ID as discoverable.

**Example attack scenario.** An attacker recovers the action ID, POSTs `{practiceId: <any practice>, memberRole: 'manager', canManagePractice: true, email: 'attacker@…'}`, accepts the invite email, and is now a manager of a practice they have no relationship with: they can issue bills, read patient plans through `practice_members_select_plans`, set the till PIN, and register a till device.

**Recommended fix.** Move the helper to a non-`'use server'` module (e.g. `lib/brand/inviteMember.internal.ts` with no directive) so it is a plain function that only server code can call, and keep the two thin guarded actions in `app/practice/members/actions.ts` and `app/brand/actions.ts` as the only exported entry points. Failing that, take `practiceId` and re-derive authorization inside the helper.

Adopt this as a rule: **no `'use server'` module may export a function that does not authorize itself.** Everything else in this repo already follows it — I verified all 100 exports; these two are the only exceptions.

---

### F-09 — Peach webhook never verifies the amount, the currency, or the event's uniqueness

**Status: FIXED (a, b, c-partial)** — (a) `verifySettledAmount` runs before every state flip on both the instalment and settlement paths, refusing a short capture or a non-ZAR currency and logging an alertable line; an over-capture is accepted deliberately. (b) `peach_webhook_events` (0123) keyed on the signed `x-webhook-id`, checked before the handlers and recorded after them — the ordering that avoids F-13. `verifyWebhookSignature` now also enforces a 300s freshness window, matching Didit's. (c) the swallowed-200 path is unchanged, but a delivery that threw is now deliberately *not* recorded, so Peach's retry can still complete it.

**Severity: HIGH**

**Location:** `app/api/payments/peach/webhook/route.ts:101-360` (`handlePaymentSuccess` / `handlePaymentFailure`); signature helper `lib/payments/peach/webhook.ts:110-145`

Three distinct gaps:

**(a) No amount or currency check.** `grep -n "payload.amount\|payload.currency"` over the route returns nothing. `handlePaymentSuccess` looks the payment row up by `merchantTransactionId` and marks it `collected` on the strength of `result.code` alone. A partial capture, a currency mismatch, or a captured amount lower than the instalment all settle as full payment. Combined with F-02 (patient-writable `payments.amount`) there is no place in the system where "did we actually receive what we were owed" is asked.

**(b) No replay ledger.** The signature covers `${timestamp}.${webhookId}.${url}.${payload}`, and `x-webhook-id` is unique per delivery — but the route never records it. `verifyWebhookSignature` also does not check the timestamp for freshness (contrast the Didit verifier, `lib/didit/webhook.ts:71-74`, which rejects a skew over 300s). A captured delivery therefore verifies forever. Idempotency today is entirely precondition-based (`if (plan.status === 'active') return`), which holds for the exact-duplicate case but not for a replay that arrives *after* something has moved the row back — which F-06 shows is reachable.

**(c) A `handler-threw` catch that returns 200.** At `:910-923`, any exception is logged and answered 200. Deliberate, and defensible against retry storms — but it means a persistent bug silently drops real payment events with only a log line as evidence, and there is no dead-letter queue.

**Recommended fix.**
1. Before flipping any state, assert `Math.round(Number(payload.amount) * 100) === expectedCents` and `payload.currency === 'ZAR'`. On mismatch, do not settle: write a `plan_events` row and alert.
2. Add a `peach_webhook_events (webhook_id TEXT PRIMARY KEY, received_at TIMESTAMPTZ)` table and use the insert's `23505` as the dedupe check — exactly the pattern `alreadyProcessed` already uses for Didit (`app/api/verification/didit/webhook/route.ts:90-97`), but placed **after** processing (see F-13).
3. Add a timestamp-skew check to `verifyWebhookSignature`, matching Didit's 300s.

---

### F-10 — Nothing enforces `approved_credit_limit`

**Status: FIXED** — `lib/underwriting/creditLimit.ts` computes outstanding exposure as uncollected instalments across live plans (not plan totals) and refuses when `outstanding + bill > limit`, or when there is no limit at all. Wired into `acceptPlan`, `payWithSavedCard` and `initiateCheckout`. It enforces whatever the stub granted — enforcing a stub limit does not make the stub a policy, and replacing `stubAffordabilityPolicy` is still the open item it always was.

**Severity: HIGH**

**Location:** written at `lib/onboarding/actions.ts:589`; read at `app/patient/page.tsx:132` and `lib/patient/requestProfile.ts:54`; **read by no gate**

`grep -rn "approved_credit_limit"` across the whole tree returns exactly six hits: one write, two display reads, and three comments. `acceptPlan`, `payWithSavedCard`, `initiateCheckout`, `createBill` and `issueCounterSession` never consult it.

The only limits actually enforced on how much credit a customer can draw are:
- `isAllowedBillAmount` — a global R1–R50,000 band per bill (`lib/config/billAmountLimits.ts`), settable by env var and identical for every customer;
- `isBlockedFromNewPlan` — one open plan at a time, and only for customers who have never completed a plan (`app/patient/actions.ts:73-87`);
- `isPatientFrozen` — blocks a new plan while a default is unresolved.

So a repeat customer who has completed one plan is exempt from the velocity rule, and the R5,000 limit the affordability step granted them is decoration. The underwriting module is explicit about being a stub (`lib/underwriting/stubAffordabilityPolicy.ts` — "unconditionally approves a fixed R5,000 test limit"), which is fine and clearly flagged; the problem is that even the stub's output is not honoured.

**Recommended fix.** Add an exposure check to all four acceptance paths: `SUM(outstanding instalments across active plans) + newBillTotal <= approved_credit_limit`, computed server-side, refusing when `approved_credit_limit IS NULL`. Enforce it in one shared function so the four callers cannot drift. Consider a `CHECK` or a trigger on `plans` as a backstop once the column lock from F-01 exists.

---

### F-11 — No security headers at all

**Status: FIXED** — six enforcing headers in `next.config.ts` (HSTS, `X-Frame-Options`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`) plus CSP in **Report-Only**. The CSP is deliberately not enforcing yet: three third parties inject script and none of their origin sets is verified here, so shipping a guess would break card capture and identity verification. Run it, collect violations, then move the key.

**Severity: MEDIUM (HIGH in combination with the JS-readable session cookie)**

**Location:** `next.config.ts` (four lines, no `headers()`), `vercel.json` (crons only), `proxy.ts` (sets `x-pathname` and nothing else)

Missing: `Content-Security-Policy`, `Strict-Transport-Security`, `X-Frame-Options` / `frame-ancestors`, `Referrer-Policy`, `X-Content-Type-Options`, `Permissions-Policy`.

**Why it matters more here than usual.** `lib/auth/sessionCap.ts:33-42` documents that `@supabase/ssr` writes the auth cookie with `httpOnly: false` and a 400-day `maxAge`, and that the session cap exists precisely because an XSS steals a *refresh* token rather than a one-hour access token. The cap bounds that to hours — but only for traffic through the app; the same file notes an attacker can go straight to Supabase's token endpoint. A CSP is the layer that stops the payload landing in the first place, and there isn't one.

`Referrer-Policy` is directly load-bearing for F-07: without it, the `checkoutId` in the URL is sent to every third-party origin the completion page touches.

**Recommended fix.** Add a `headers()` block to `next.config.ts`. Start with `Referrer-Policy: strict-origin-when-cross-origin`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`, and a `Permissions-Policy` denying camera/microphone/geolocation except where the KYC and map flows need them. Roll CSP out in `Content-Security-Policy-Report-Only` first — the Peach widget, Google Maps/Places and Didit all inject third-party script and will need explicit `script-src` entries.

---

### F-12 — Push-subscription upsert can reassign another user's row

**Status: FIXED** — replaced with a lookup, an explicit refusal (409) when the endpoint belongs to another account, and an update predicated on `.eq('user_id', user.id)`. The comment asserting a `WHERE` clause that did not exist is gone.

**Severity: LOW**

**Location:** `app/api/push/subscribe/route.ts:66-77`

```ts
.upsert({ user_id: user.id, endpoint: body.endpoint, ... }, { onConflict: 'endpoint' })
```

The comment above it (`:55-64`) claims the write is safe because *"PostgREST defaults to updating only the columns supplied, so user_id wouldn't change anyway — but the WHERE clause below enforces it explicitly"*. Both halves are wrong: `user_id` **is** one of the supplied columns, so the conflict update sets it; and there is no `WHERE` clause below.

An attacker who learns a victim's push endpoint (a long random URL — not guessable, but it is transmitted to this endpoint and stored) can POST it and take ownership of the row, redirecting the victim's payment and plan notifications to their own device.

**Recommended fix.** Drop `user_id` from the upsert payload and follow with `.eq('user_id', user.id)` on a separate update, or use an explicit insert-then-update-scoped-by-user pattern. Either way, remove the comment's incorrect claim.

---

### F-13 — Didit webhook records the idempotency key before processing, so its own retry path is dead

**Status: FIXED** — `releaseEventClaim` drops the ledger row on the `TransientDuplicateCheckError` path only, so the retry that path asks for can actually do something. The generic catch still holds the claim, which is correct: an unexpected throw is a bug and does not want a retry storm.

**Severity: MEDIUM**

**Location:** `app/api/verification/didit/webhook/route.ts:409` (dedupe) vs `:452-457` (retry)

`alreadyProcessed()` inserts `event_id` into the ledger at line 409, *before* the handler runs. The handler can throw `TransientDuplicateCheckError`, which line 454 deliberately maps to **500 so that Didit retries** — the file's banner calls this "the ONE deliberate non-2xx". But the retry re-enters at line 409, hits the row already inserted, and returns `{received: true, duplicate: true}` with a 200.

So a transient database failure inside `findPatientBySaId` permanently loses that verification. The patient's Didit session shows Approved; their profile never gets `sa_id_number` or `liveness_verified_at`; they are stuck at the identity step with no way forward and no error anywhere.

**Recommended fix.** Either delete the ledger row before returning 500, or split into a claim/commit: insert with a `processed_at IS NULL`, and only stamp `processed_at` after the handler succeeds, treating an unstamped row older than N minutes as re-processable.

---

### F-14 — Till registration codes are 8 digits with no rate limit

**Status: FIXED** — `redeemDeviceRegistrationCode` spends from the shared limiter (10/hour/IP) after the shape check and before the RPC. Separately, `till_pin_hash` moved to salted scrypt via `hashTillPin`/`verifyTillPin`, which still accepts the legacy bare digest so existing PINs keep working and upgrade on next set. The device secret and registration code stay on the deterministic hash — they are matched by equality lookup, which a per-row salt would make impossible.

**Severity: MEDIUM**

**Location:** `app/practice/pos/actions.ts:74-127` (`redeemDeviceRegistrationCode`, anon-reachable); `supabase/migrations/0088_till_devices.sql:148+` (the RPC)

The code is a cryptographically random 8 digits (`lib/auth/tillDevice.ts:57-60`) and the RPC row-locks correctly, but nothing counts failed attempts — not per IP, not per code, not globally. The keyspace is shared: the RPC matches `code_hash` across **all** practices, so an attacker guessing blindly hits whichever practice has a live code, and the effective hit rate scales with how many codes are outstanding platform-wide.

A successful guess yields a registered till, which then needs the practice PIN — 6 digits, with a proper 5-attempt / 15-minute lockout per device (`unlockTill`, `:136-183`). So the second factor holds. But `checkDeviceStatus` on an unlocked device returns the practice name and its full provider roster, and an unlocked rogue till can issue bills against arbitrary SA ID numbers.

Separately: `till_pin_hash` is unsalted `SHA-256(pin + pepper)` over a 6-digit space (`lib/auth/tillDevice.ts:52-54`). The pepper is the only thing standing between a database leak and instant recovery of every practice PIN. That is a deliberate, documented trade-off for OTP codes that expire in ten minutes; it is a weaker fit for a PIN that persists until a manager rotates it.

**Recommended fix.** Add per-IP and global attempt counters to `redeemDeviceRegistrationCode` (a `till_registration_attempts` table, or the same in-memory limiter used by the public forms as a first pass). Shorten the code TTL. Consider raising the code to 10 digits or alphanumeric — it is transcribed once from a manager's screen, so length costs little. Move `till_pin_hash` to a slow KDF (scrypt/argon2) since it is verified rarely.

---

### F-15 — Pinned dependencies carry 19 known advisories, including a proxy bypass

**Status: MOSTLY FIXED — 19 advisories down to 2.** `next` 16.2.6 → 16.2.11 (clears all nine, proxy bypass included), and `pnpm-workspace.yaml` overrides pin `nanoid`, `postcss`, `@babel/core` and `sharp` to their fixed versions. The two remaining are both `xlsx`; see the note in §0 for why that one needs a human decision, and `lib/crm/xlsxToCsv.ts` for what bounds it meanwhile.

**Severity: MEDIUM**

`pnpm audit --prod`: **11 high, 7 moderate, 1 low.**

| Package | Pinned | Fixed in | Why it matters here |
|---|---|---|---|
| `next` | 16.2.6 | **16.2.11** | Five advisories. **"Middleware / Proxy bypass in App Router"** is the one that matters — the absolute session cap and the invitation claim both live in `proxy.ts`. Also **"Unauthenticated disclosure of internal Server Function endpoints"**, which is what makes F-08 reachable, plus SSRF in Server Actions and a Server Actions DoS. |
| `xlsx` | 0.18.5 | 0.20.2 | Prototype pollution + ReDoS. Used at `lib/crm/xlsxToCsv.ts:19` — **client-side only**, in `ImportClient.tsx` / `QuickImportClient.tsx`, on a file the sales user chose. So the blast radius is a malicious workbook mailed to a rep, executing in their authenticated CRM tab. Real, but not server-side RCE. |
| `postcss` | ≤8.5.22 | 8.5.23 | Build-time arbitrary file read via `sourceMappingURL`. Transitive through `next`. |
| `sharp` | <0.35.0 | 0.35.0 | libvips CVEs. Transitive through `next`'s image optimisation. |
| `nanoid` | <3.3.18 | 3.3.18 | Infinite loop on hostile size. Transitive. |
| `@babel/core` | ≤7.29.0 | 7.29.1 | Build-time file read. Transitive through `styled-jsx`. |

**Recommended action, in order.** Upgrade `next` to 16.2.11 first and on its own — it is a patch bump within 16.2 and it clears eleven of the nineteen advisories including the proxy bypass. Do not bundle it with other upgrades; `AGENTS.md` warns this Next major diverges from training data, so it wants its own verification pass. Then `xlsx` to ≥0.20.2 (SheetJS moved off the npm registry at 0.20.x — check the install source before scheduling this one). `postcss`, `sharp`, `nanoid` and `@babel/core` are all transitive and will mostly resolve with the Next bump; pin overrides only for whatever is left. Remember to commit `pnpm-lock.yaml` alongside — `CLAUDE.md` notes Vercel deploys `--frozen-lockfile`.

---

### F-16 — No re-authentication or MFA for admin operations

**Status: OPEN — not fixable from the repository.** MFA enrolment is a Supabase Auth project setting. The RBAC half was already correct and was re-verified across all 21 admin and 12 CRM surfaces.

**Severity: MEDIUM**

Role checks are applied consistently and correctly — I verified all 21 admin surfaces and all 12 CRM surfaces (`profile?.role !== 'admin'` / `!== 'sales' && !== 'admin'`), and `guardAdmin()` in `app/admin/_lib/auditActions.ts:52-61` is properly ordered before the service-role client is constructed. `admin_audit_log` (0048) records notes and fee changes, and 0054 adds a trigger-level audit for protected-column writes regardless of caller.

What is missing is any step-up. A single stolen admin session cookie — and the cookie is JS-readable, per F-11 — can approve practices, change a practice's fee percentage, mark payout batches paid, grant the sales role, grant brand-admin, and read every customer profile, with nothing re-verifying who is at the keyboard. `admins_all_plans`, `admins_all_payments`, `admins_all_payouts` and `admins_select_all_profiles` give the role unrestricted table access.

**Recommended fix.** Require MFA on `role IN ('admin','sales')` at the Supabase level. Add re-authentication for the money-moving subset — `markBatchPaid`, `markPayoutPaid`, `changePracticeFeePercent`, `grantSalesRole`, `grantBrandAdmin`. Consider a shorter absolute session cap for admins than for patients (`isCapExemptPath` / `sessionExceedsAbsoluteCap` already give you the hook).

---

### F-17 — Rate limiting is per-instance and absent from the costliest paths

**Status: FIXED** — `0124_rate_limits.sql` adds an atomic `consume_rate_limit` (count and insert in one statement) and `lib/security/rateLimit.ts` puts every limit in one reviewable table. Wired into `signUpPatient`, `resendConfirmation`, `initiateCheckout`, `startIdentityVerification`, `submitIdentityForVerification`, `redeemDeviceRegistrationCode`, and both public forms — keyed on IP *and* account/token/email wherever both exist. Fails open by design; the limits that must not (OTP sends and attempts, till PIN attempts) are unchanged and still in SQL. Pruned by the daily cron.

**Severity: MEDIUM**

What exists and works: OTP send/verify caps enforced **in SQL** (0052/0055 — 30s cooldown, 5 per (key, phone) per 24h, 10 per key per 24h across all phones, 5 verify attempts), the till PIN lockout, and Supabase's own auth rate limits.

What exists but is best-effort: `lib/crm/publicLeadRateLimit.ts` (5/hour/IP) and `lib/contact/contactRateLimit.ts` (5/hour/IP) and the geocode limiter — all in-process `Map`s, and all three files honestly document that Vercel's multi-instance serving defeats them.

What has none at all:

| Path | Cost per call |
|---|---|
| `signUpPatient` | A Supabase transactional email; an auth user row |
| `resendConfirmation` | Another email, on demand, for any address |
| `initiateCheckout` | An auth user, a profile, a Peach checkout creation |
| `redeemDeviceRegistrationCode` | Free brute-force attempts against the 8-digit space (F-14) |
| `runCreditCheck` | Free today (stub); a bureau call per invocation once real |
| `startIdentityVerification` | A Didit session — a **paid** KYC unit |

**Recommended fix.** Move to a shared store (Upstash/Redis, or a Postgres table with a `SECURITY DEFINER` RPC in the style of the OTP caps — the pattern is already established and proven here). Key by IP **and** by account, since either alone is trivially rotated. Prioritise `startIdentityVerification` and `signUpPatient`: those are the two with a direct per-call cash cost. Add a CAPTCHA or Turnstile to signup and the two public forms.

---

### F-18 — Practices auto-approve, and email confirmation is documented as disabled

**Status: OPEN — configuration.** The code-side trading gate already holds; what remains is verifying the deployed Supabase project.

**Severity: MEDIUM** (configuration, not code)

`project.md` §10 lists these as known shortcuts. Re-verified: the trading gate (`lib/practice/tradingGate.ts`) *does* now require `practices.status = 'approved'`, a provider on staff, and resolvable banking — so the auto-approval shortcut appears to have been closed in code. Confirm the deployed default for `practices.status` at insert and that `approvePractice` is a real human step.

Email confirmation being off would be more serious: `initiateCheckout` creates users with `email_confirm: true` by design, and `requireConfirmedUser` is relied on across the patient tree. Verify in the Supabase dashboard before launch.

---

### F-19 — Minor observations

**Status: FIXED** — `resendConfirmation` now uses `ilike` (and gained a rate limit); both `dangerouslySetInnerHTML` sites sanitise on output as well as on write. The `isBlockedFromNewPlan` exemption for repeat customers is left as designed — it is no longer the only per-customer bound, because F-10 now is.

- **`resendConfirmation` email lookup is case-sensitive** (`app/auth/resend/actions.ts:28`, `.eq('email', email)`) where `findExistingAuthUser` deliberately uses `ilike` for the same reason. A user who signed up as `Test@x.com` gets a silent no-op.
- **CRM signature HTML is rendered with `dangerouslySetInnerHTML`** at `app/crm/settings/SignatureEditor.tsx:157` and `app/crm/leads/[id]/ComposeEmailSheet.tsx:369`. Both render the *viewing user's own* signature under `crm_signatures_self_*` RLS, so this is self-XSS today. It stops being self-XSS the moment an admin can preview another rep's signature — sanitize now.
- **No virus scanning on the xlsx import path.** Files are parsed client-side and never stored, which limits this, but the parser itself is the vulnerable component (F-15).
- **`isBlockedFromNewPlan` exempts anyone who has ever completed a plan** (`app/patient/actions.ts:80-86`). Intentional, but it means the only velocity control disappears after the first completed plan — which, with F-10, means a repeat customer has no limit of any kind.

---

## 4. What I checked and found sound

Recording these so the report is not read as "everything is broken", and so nobody re-spends effort here.

- **Webhook signature verification.** Both verifiers hex-decode, length-check, and `timingSafeEqual`. Didit additionally canonicalises per spec and enforces a 300s skew window. Neither leaks via early return.
- **Cron authentication.** All three routes use a constant-time compare of the full `Bearer <secret>` string with a length pre-check, and refuse to run when `CRON_SECRET` is unset (`REQUIRE_CRON_SECRET` is a code constant, not an env toggle).
- **OTP handling.** `crypto.randomInt` (bias-free), peppered SHA-256, plaintext never stored or logged or returned, caps enforced in the RPC rather than the UI, `FOR UPDATE` row lock on verify so concurrent attempts cannot both win their increment.
- **SA ID encryption.** AES-256-GCM with a random IV and a versioned envelope, plus a *separately keyed* HMAC blind index for lookup and uniqueness. Both key readers fail closed. `maskId` for display. This is textbook.
- **Terms acceptance.** Enforced with `!== true` strict equality on all three account-creation paths, with the reasoning about runtime type erasure written out, plus adversarial tests already in the repo.
- **Account enumeration on password reset.** Identical success state regardless of whether the address exists; only a 429 is distinguished, and the reasoning for that exception is sound.
- **Session management.** Global revocation on logout and on password change, a server-side absolute cap that a compromised browser cannot move, and cookie clearing that does not depend on `signOut` succeeding. The gap analysis in `lib/auth/sessionCap.ts` is more honest than most security documentation I read.
- **`safeNext`** blocks protocol-relative and absolute redirects.
- **Gmail OAuth** binds `state` to both a cookie and `user.id`.
- **SQL injection.** None. Every query goes through PostgREST builders or parameterised RPC arguments. No string concatenation into SQL anywhere.
- **Command injection / unsafe deserialization.** None. No `eval`, no `new Function`, no `child_process` outside test files.
- **Secrets.** Nothing committed. `.gitignore` covers `.env*`, `*.pem`, and the SA-ID restore files. Scanned all 72 commits for added env/key/pem files: clean. No `VITE_` variables — this is Next, and the only `NEXT_PUBLIC_` values are the Supabase URL, the anon key, the referrer-restricted Places key, the app URL and the bill-amount bounds. All correctly public.
- **Cross-tenant reads.** 0093 fixed the uncorrelated `EXISTS` in `practice_members_select_patient_profiles`; 0049 replaced `USING (true)` on `patient_invitations` with a token-scoped `SECURITY DEFINER` function. Both re-verified.
- **Anon RPC surface.** All eight are token-gated and none returns a list.
- **PII in logs.** Disciplined throughout — IDs and reasons, never plaintext SA IDs, codes, tokens or card numbers. The one deliberate exception is the Peach verification probe, which dumps a body that carries setup metadata only, with a comment saying not to copy the pattern to the event path.
- **`payouts.plan_id` UNIQUE (0087)** plus `ignoreDuplicates` correctly makes three concurrent activation paths converge on one payout.
- **`claim_plan_for_settlement`** and `attemptChargeInstalment` use single-statement atomic claims with row-count verification and clean revert — the cron-vs-patient race is genuinely handled.

---

## 5. Security scorecard

Two columns: as audited, and after the remediation in §0. The second is
not a claim that these domains are now strong — several are simply no
longer holed, which is a different thing. Anything still below 7 has a
named reason in the notes.

| Domain | Audited | After | Note |
|---|---|---|---|
| Authentication | 2 | **8** | F-07's unauthenticated session mint closed and the password reset removed with it. The remaining gap is the JS-readable 400-day cookie, bounded but not closed by the session cap. |
| Authorization | 2 | **8** | The ledger write primitive is gone and `profiles` is allow-listed. Held back from 9 by F-16: admin still has unrestricted table access with no step-up. |
| API security | 6 | **8** | F-08 closed; all 100 server-action exports now authorize themselves. |
| Business logic | 2 | **7** | F-06 closed from both ends, F-03 constrained at the DB, F-10 enforced. Not higher because the limit being enforced is still a stub's. |
| Payment security | 4 | **8** | Amounts verified, replay ledger, freshness window. The swallowed-200 path and its missing dead-letter queue remain. |
| KYC security | 2 | **7** | The gate columns are no longer forgeable. The identity flow itself was always careful; what it lacked was a lock on what it wrote. |
| Database security | 3 | **8** | Column locks on the three tables that matter, the missing unique index, an allow-list that covers columns not yet written. |
| Input validation | 8 | **8** | Was already good. Unchanged, plus a `salary_amount` ceiling and a workbook size cap. |
| Rate limiting | 4 | **8** | Shared-store limiter on the seven unprotected paths, keyed on IP and account. Fails open by design, which is why not 9. |
| Bot protection | 2 | **5** | The funnel now costs an attacker budget at every paid step. Still no CAPTCHA and no device fingerprinting — the honest ceiling without one. |
| Secrets management | 9 | **9** | Unchanged. Was already the strongest area. |
| Infrastructure | 4 | **7** | Six enforcing headers, 19 advisories down to 2. CSP is Report-Only and `xlsx` is unresolved, which is the whole of the remaining 3. |
| Logging / monitoring | 5 | **6** | New alertable lines on amount mismatch, token-close failure and prototype pollution. Still no alerting on any of them — the log lines exist and nothing reads them. |
| Admin security | 6 | **6** | Unchanged, and deliberately: F-16 is a dashboard setting. |

## 6. Attack chains

### AC-1 — Pay R1.00 on a R10,000 bill (F-02 + F-10 + no amount verification)

| | |
|---|---|
| **Likelihood** | High |
| **Financial impact** | Up to 94% of every bill on the platform |
| **Ease** | Trivial — four HTTP requests, browser session only |
| **Privileges** | Any onboarded patient |
| **Detectability** | Very low — every row looks settled |

1. Accept a R10,000 bill normally. `acceptPlan` writes three instalments of R3,333.34 / R3,333.33 / R3,333.33.
2. `PATCH /rest/v1/payments?id=eq.<instalment 1>` → `{"amount": 1.00}`.
3. Call `initializeFirstPayment`. It reads the row and charges **R1.00** (`app/patient/actions.ts:238`).
4. Payment succeeds. `activateFirstInstalment` marks it collected, activates the plan, and inserts a payout of **R9,400** computed from the untouched `plans.total_amount`.
5. `PATCH /rest/v1/payments?patient_id=eq.<self>` → `{"status":"collected"}` for instalments 2 and 3.

Net: HNPL pays out R9,400, collects R1.00, and its own records show a completed plan.

### AC-2 — Synthetic identities at scale (F-05 + F-17 + no bot protection)

| | |
|---|---|
| **Likelihood** | Medium-High |
| **Financial impact** | Unbounded — it is a factory for AC-1 |
| **Ease** | Moderate — needs scripting and disposable mailboxes |
| **Privileges** | None |
| **Detectability** | Low until collections fail en masse |

Script signup (no rate limit, no CAPTCHA) → skip onboarding entirely → one `PATCH /rest/v1/profiles` per account forging `sa_id_number`, `sa_id_lookup_hash`, `liveness_verified_at`, `credit_check_status` and `onboarding_completed`. The unique index on `sa_id_lookup_hash` is satisfied with a fresh random value per account, so the one-ID-per-person control is defeated in the same request that forges the identity. Each account then runs AC-1. No Didit unit is ever consumed, so the KYC spend that would otherwise flag the volume never appears.

### AC-3 — Pay, then un-pay, while the practice keeps the money (F-06)

| | |
|---|---|
| **Likelihood** | Medium — needs the webhook to win the activation race, which happens whenever the tab closes early |
| **Financial impact** | 94% of the bill, per bill |
| **Ease** | Easy — re-open an emailed link and let a card decline |
| **Privileges** | Anyone holding a checkout token |
| **Detectability** | Low — the plan reads `cancelled`, which looks like a normal failed first payment |

Full walkthrough in F-06. The key structural point is that the invitation's `accepted_at` is stamped only by the *browser* return page, so a webhook-activated plan leaves a live token behind for up to seven days.

### AC-4 — Session theft from a shared counter browser (F-07 + F-11)

| | |
|---|---|
| **Likelihood** | Medium |
| **Financial / privacy impact** | Full account takeover: identity, card metadata, ability to take new credit in the victim's name |
| **Ease** | Easy given URL access |
| **Privileges** | None |
| **Detectability** | Low — but the victim's password is silently rotated, which they will eventually notice |

The QR flow is designed around a shared physical counter. A `checkoutId` in browser history, or leaked by `Referer` because no `Referrer-Policy` is set, is a bearer credential for a session as that patient.

### AC-5 — Rogue till (F-14 + F-08)

| | |
|---|---|
| **Likelihood** | Low |
| **Impact** | Bills issued against arbitrary SA IDs; practice roster and patient plans exposed |
| **Ease** | Hard — brute-force plus a second factor |
| **Privileges** | None |
| **Detectability** | Medium — `till_devices` rows are visible to a manager |

Brute-force the unlimited 8-digit registration code, or reach `inviteMemberIntoPractice` directly (F-08) and become a manager with the power to set the PIN outright.

---

## 7. What was done, and what is left

### Done — the four that could cost money today

1. **The ledger is no longer patient-writable.** Migration 0121 drops
   `patients_update_own_plans`, `patients_update_own_payments` and
   `patients_insert_payments_for_own_plans`, adds `protect_plans_write()`
   and `protect_payments_write()` behind them, and installs
   `payments_plan_instalment_uniq`. The writes moved to the privileged
   client inside `acceptPlan`, `payWithSavedCard`, `declinePlan` and
   `initializeFirstPayment` — reads still go through the session client, so
   RLS is still what establishes ownership, and every privileged write
   re-states `patient_id` explicitly because service-role bypasses the
   filter it used to inherit.
2. **The KYC gate is server-set.** Migration 0122 makes `profiles` an
   allow-list of nine columns.
3. **The checkout replay is closed twice.** `initiateCheckout` allow-lists
   plan states and never deletes a settled row; `activateFirstInstalment`
   closes the invitation and counter session on every activation path,
   including the webhook's.
4. **The completion page is bound to its token**, and no longer resets
   anyone's password to make a session.

Plus F-08 (directive removed), F-09a/b (amounts verified, replay ledger,
freshness), and F-15's `next` upgrade.

### Done — the before-launch tier

F-03, F-10, F-11 (headers, CSP Report-Only), F-12, F-13, F-14, F-17, F-19.

### Left, and why

| Item | Why it is not in this commit |
|---|---|
| **F-16 — MFA + step-up for admin/sales** | Supabase Auth project setting. Enable enrolment first; the step-up on `markBatchPaid`, `markPayoutPaid`, `changePracticeFeePercent`, `grantSalesRole` and `grantBrandAdmin` depends on it existing. |
| **F-18 — email confirmation, practice approval** | Deployed-project state, not code. Verify both in the dashboard. |
| **F-15 — `xlsx`** | The fix exists only on the vendor's CDN. Repointing the install source is a supply-chain decision; §0 has the detail. Bounded meanwhile by the size cap and prototype tripwire. |
| **Enforce the CSP** | Report-Only first, for a week, then fold the real third-party origins in. Shipping a guessed policy would break card capture. |
| **Replace `stubAffordabilityPolicy`** | Needs real underwriting and compliance sign-off, exactly as its own header says. F-10 means the number it returns now binds, so the swap is a one-function change when the policy exists. |
| **Alerting** | Every `ALERT`-prefixed log line in this codebase — several of them added by this commit — currently goes nowhere. Wiring them to a channel is the highest-value thing left after the above. |
| **Nonce-based CSP** | Removes the `'unsafe-inline'` placeholder in `script-src`. Separate change; should not have held up the other six headers. |

## 8. Regression tests

The two files that began as adversarial proofs are now the regression
suite. Their assertions were **inverted** when the fixes landed: where they
asserted an exploit succeeded, they now pin the refusal.

- `supabase/migrations/security-audit-2026-09.rls.test.ts` — 16 assertions.
  F-01, F-02, F-03, plus the trigger layer, plus the plans INSERT/DELETE
  bounds.
- `supabase/migrations/security-audit-2026-09-profiles.rls.test.ts` — 15
  assertions. F-04 (the control), F-05, the allow-list exemptions, the
  locked-by-default property, and the `salary_amount` ceiling.
- `app/checkout/[token]/replay-guard.test.ts` — 17 assertions covering F-06
  and F-07. Source assertions rather than a behavioural test, because
  `initiateCheckout` is ~450 lines that create an auth user, call Peach and
  set cookies; standing all of that up would test the mocks. What has to
  hold is a small set of structural facts about the guard, including the
  two negatives that came out of getting it wrong first — `processing` is
  NOT a refusal condition, and neither refusal may tell a patient whose
  payment succeeded that it failed.

Two more were extended rather than added: the Peach webhook suite gained
the timestamp-freshness cases (F-09b), and the Didit route suite gained the
one assertion that would have caught F-13 — replay the same event after a
transient failure and require the retry to actually persist.

Both run against real PostgreSQL via pglite as the non-superuser
`app_user`, and both apply the migration under test **verbatim from the
file** rather than a hand-written approximation of its end state — so what
passes is the migration, not a description of it.

Three properties are pinned deliberately and are worth not deleting:

- **The control.** `AUDIT F-04` asserts the columns the *old* deny-list
  already covered are still refused. If the harness ever stopped enforcing
  triggers, those would fail too — which is what makes the F-05 refusals
  meaningful rather than an artefact of a broken fixture.
- **The exemptions.** `AUDIT F-05b` asserts the passkey counters, the
  provider's phone field and the privileged writers still work. A lock that
  also broke the login flow would be reverted within a day.
- **The trigger layer.** `AUDIT F-01/F-02 — the triggers hold even if a
  policy comes back` re-adds a 0007-shaped policy and asserts the trigger
  still refuses. The triggers are unreachable from a patient session today;
  that is exactly why they need exercising, because a defence nobody tests
  is a defence nobody knows is broken.
