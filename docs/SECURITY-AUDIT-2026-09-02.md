# HNPL / betternow — adversarial security audit, round two

**Date:** 2026-09-02
**Branch:** `claude/web-app-security-audit-j53pdt`
**Scope:** the whole repository — `app/` (≈300 route/action/component files), `lib/`, `components/`, 124 SQL migrations, 20 API routes, 34 Server Action modules, `proxy.ts`, `next.config.ts`, `vercel.json`.
**Method:** static review of every auth, authorization, money, KYC and webhook path, plus **executable proof-of-concept tests** — three new test files, 20 assertions, all passing as exploit demonstrations. The pglite proofs run the **actual migration SQL** against a real PostgreSQL as non-superuser roles named `anon` / `authenticated` / `service_role`, so the migrations' own `GRANT`/`REVOKE` statements are what execute.
**Constraint honoured:** no production code was changed. The pre-existing suite was green before (368 files / 6,558 tests) and is green after.

**Relationship to `docs/SECURITY-AUDIT-2026-09.md`:** that audit (yesterday, 19 findings, 17 fixed) was re-verified. Its fixes hold — migrations 0121–0124 do what they claim, and I could not reopen F-01, F-02, F-03, F-05, F-07, F-09, F-10, F-12 or F-13. **Every finding below is new.** Two of them are in code that audit touched: A-04 is a race the F-10 fix introduced, and A-03 is a session-minting primitive one route away from the one F-07 closed.

---

## 1. Executive summary

**Overall security level: HIGH RISK — do not take real money or real ID numbers on this build.**

This is a genuinely well-defended codebase in most places. RLS is on every table, the money paths run through the privileged client with row-level preconditions and atomic claims, the webhook verifies HMAC with a freshness window and a replay ledger, secrets are correctly partitioned, and the finance maths is pure and tested. The engineering standard here is high and the previous audit's fixes were done properly.

What is wrong is concentrated in **three places where a credential is not what it appears to be**, and all three are reachable without any privileged access:

**Biggest authentication risk — the phone OTP is not an OTP.** The two RPCs behind it take the code's *hash* as a caller-supplied parameter and are granted directly to `anon`. So a caller writes a hash they invented and then presents the same value back, and the row is marked verified. No SMS is sent, no server pepper is needed, no code is guessed. The browser holds the anon key by construction, so this is two `fetch` calls. **The phone gate on the checkout door does not exist** (A-01, proved).

**Biggest account-takeover risk — the checkout door resets other people's passwords.** `initiateCheckout` establishes a session by setting the target account's password and signing in with it. That is correct for an account it just created, and it is an account takeover for the branch where it *reuses* an existing patient — which is exactly the branch a QR-delivered bill against a returning patient's ID number produces. The practice that raised the bill holds that token on its own screen. The same request also overwrites the patient's name, phone and `phone_verified_at` with attacker-supplied values (A-03, proved).

**Biggest financial risk — the credit limit is per-request, not per-customer.** `checkCreditLimit` reads exposure, decides, and returns; the caller writes the schedule afterwards. Nothing locks anything and no database constraint relates total exposure to the approved limit, so N simultaneous acceptances each see zero exposure and all pass. Five browser tabs give five times the limit (A-04, proved). Worse, the checkout door **skips the limit check entirely for an account it just created** (`if (!isNewUser)`), so a first bill is bounded only by `MAX_BILL_AMOUNT` — R50,000 by default against a policy limit of R5,000 (A-05).

**Biggest privacy risk — a systemic grant defect.** PostgreSQL grants `EXECUTE` on every new function to `PUBLIC`. Only three of this repo's 30-odd `SECURITY DEFINER` functions ever revoke it. So `GRANT ... TO service_role` is not exclusive, and the earlier audit's M2 fix — `REVOKE EXECUTE ... FROM authenticated` in migration 0056 — closes nothing, because the `PUBLIC` grant it never touched still applies (A-02, proved). Today that exposes invoice-number burning, arbitrary checkout-session expiry, and a card-token rewrite primitive. Tomorrow it exposes whatever function is added next.

**Biggest KYC risk — there are two front doors and only one of them checks anything.** The in-app path (`acceptPlan`, `payWithSavedCard`) enforces five gates: onboarding complete (which includes liveness and identity), not frozen, one plan at a time, credit limit, card validity. The checkout-token path (`initiateCheckout`) enforces the credit limit and nothing else — no identity verification, no liveness, no one-plan rule. A person holding a stolen SA ID number and a phone they control can take a R50,000 plan, and HNPL pays the practice 94% of it on first-payment success (A-05).

None of this is theoretical. Four of the findings ship with tests that demonstrate the exploit.

---

## 2. Attack-surface inventory

### 2.1 API routes

| Route | Method | Auth | Role | State | Money | PII | Rate limit | Notes |
|---|---|---|---|---|---|---|---|---|
| `/api/payments/peach/webhook` | POST | HMAC-SHA256 + 300 s freshness + `peach_webhook_events` replay ledger | — | ✅ | ✅ | ✅ (card, email) | none | JSON branch is **unsigned** and always 200s — see A-15 |
| `/api/verification/didit/webhook` | POST | HMAC + freshness + event ledger | — | ✅ | — | ✅ (SA ID, liveness) | none | Writes `sa_id_number`, `liveness_verified_at` |
| `/api/cron/collect-instalments` | GET/POST | `Bearer CRON_SECRET`, `timingSafeEqual` | — | ✅ | ✅ | — | n/a | Fires real card charges |
| `/api/cron/payout-batches` | GET/POST | same | — | ✅ | ✅ | — | n/a | Closes payout batches |
| `/api/cron/crm-reply-poll` | GET/POST | same | — | ✅ | ✅ (lead email) | — | n/a | |
| `/api/crm/gmail/push` | POST | Google OIDC ID token, RS256, iss/aud/email/exp verified against JWKS | — | ✅ | — | ✅ | none | Correct |
| `/api/crm/gmail/connect` · `/callback` · `/disconnect` | GET | session + sales/admin | sales/admin | ✅ | — | ✅ | none | OAuth tokens encrypted at rest |
| `/api/payment-methods/recent` | GET | session + confirmed | patient | — | — | card last4 | none | Correctly scoped to `patient_id` |
| `/api/push/subscribe` · `/unsubscribe` | POST | session | any | ✅ | — | — | none | Endpoint-ownership refusal present (F-12) |
| `/api/reverse-geocode` | GET/POST | session | any | — | — | coords | none | Server-side Google key, not referrer-restricted |
| `/api/auth/logout` | POST | session | any | ✅ | — | — | none | Global scope revoke |
| `/auth/callback` | GET | code exchange | — | ✅ | — | ✅ | none | `terms_accepted=1` is a query param — A-15 |
| `/auth/require-terms` | GET/POST | session | any | ✅ | — | — | none | |
| `/sw.js`, `/icon-*.png`, `/manifest.webmanifest` | GET | none | — | — | — | — | — | Excluded from the proxy matcher |

No CORS headers are set anywhere; nothing is cross-origin readable. No file-upload endpoint exists — the only attacker-supplied file is a CSV/XLSX parsed in memory by the CRM import action.

### 2.2 The dangerous surfaces, ranked

1. **`initiateCheckout`** (`app/checkout/[token]/actions.ts:236`) — anonymous, token-authenticated, and it creates auth users, resets passwords, mints sessions, writes profiles, rewrites payment schedules and starts a card charge. 758 lines. This is the single most dangerous function in the repository and it is reachable with no session at all.
2. **The phone-OTP RPCs** — `anon`-executable, and the only thing standing between a token and #1.
3. **`selfSettleEntirePlan`** — one call flips every outstanding instalment on a plan.
4. **`issueCounterSession` / `createBill`** — mint bills and hand out checkout tokens; authenticated by a `localStorage` device secret plus a six-digit practice-wide PIN.
5. **`/api/payments/peach/webhook`** — every state transition that means "money arrived".

### 2.3 Client-supplied values that reach a decision

| Field | Source | Server-verified? |
|---|---|---|
| `amount` / `total_amount` | practice at bill creation | ✅ `isAllowedBillAmount`, then read from the row, never from the request |
| `planType` | patient | ✅ allow-list `{2,3}` |
| `salaryDay` | patient | ✅ `isAllowedSalaryDay`; profile value wins over the request |
| `patient_id` | never accepted from a request | ✅ derived from `auth.uid()` or the token |
| `practiceId` | request (scope selector) | ✅ re-verified against `practice_members` |
| `providerMemberId` | request | ✅ re-verified: same practice, active, `role='provider'` |
| `paymentMethodId` | request | ✅ `.eq('patient_id', user.id).eq('reusable', true)` |
| `status`, `approved`, `kycStatus`, `creditScore`, `role`, `isAdmin` | never accepted | ✅ locked by 0121/0122 triggers |
| `p_code_hash` | **request → database** | ❌ **A-01** |
| `email` (session checkout path) | **request** | ❌ decides which account is taken over — **A-03** |
| `p_user_id` (phone RPCs) | **request** | ❌ never compared to `auth.uid()` — **A-06** |
| `p_practice_id` (`accept_practice_invitation`) | **request** | ❌ **A-07** |
| `p_bucket`/`p_max`/`p_window_secs` (`consume_rate_limit`) | **request** | ❌ **A-11** |

---

## 3. Findings

Severity is CVSS-flavoured but weighted for a lender holding SA ID numbers: anything that moves money or defeats identity is escalated.

---

### A-01 — The phone OTP can be self-issued: the RPCs take the code hash as a parameter

**Severity: CRITICAL**

**Location**
- `supabase/migrations/0052_phone_verification.sql:96` (`prepare_phone_verification`), `:230` (the comparison), `:165` and `:250` (`GRANT ... TO anon, authenticated`)
- `supabase/migrations/0053_phone_verification_user_keying.sql:89`, `:167`, `:200`
- widened by `0055`, `0086:23`, `0099:86` — none of which revoke anything
- consumed at `app/checkout/[token]/actions.ts:499-511` and `app/(auth)/verify-phone/actions.ts:81`, `:100`, `:174`, `:191`

**What is wrong**

The design is: the server action generates a six-digit code, hashes it as `SHA-256(code + PHONE_OTP_PEPPER)`, stores only the hash, and sends the code by SMS. That is a sound design — *if the hash can only be written by something that knows the code.*

It cannot. `prepare_phone_verification(p_token, p_phone, p_code_hash)` takes the hash as its third argument, and it is granted to `anon`. `verify_phone_otp(p_token, p_phone, p_code_hash)` compares its third argument to the stored value — also granted to `anon`. Both are `SECURITY DEFINER`, so RLS on `phone_verifications` (which has no policies at all, deliberately) does not apply.

`NEXT_PUBLIC_SUPABASE_ANON_KEY` is in the browser bundle by construction. So anyone can:

```
POST /rest/v1/rpc/prepare_phone_verification
{ "p_token": "<any live token>", "p_phone": "+27829999999", "p_code_hash": "x" }
→ "ok"

POST /rest/v1/rpc/verify_phone_otp
{ "p_token": "<same>", "p_phone": "+27829999999", "p_code_hash": "x" }
→ "ok"          ← verified_at is now set
```

No SMS is sent. `PHONE_OTP_PEPPER` is irrelevant — the attacker supplies both halves of the comparison. The 30-second cooldown, the five-sends-per-day cap and the five-attempt lock all still function; they bound a *brute force*, and this is not one.

The token can be a `patient_invitations` token **or** (since 0086) a `checkout_sessions` token, so both the emailed-link flow and the POS QR flow are affected.

**How an attacker exploits it**

`initiateCheckout` treats a fresh `verified_at` on `(invitation_token, phone_e164)` as proof that the person at the keyboard controls that number:

```ts
// app/checkout/[token]/actions.ts:499
const { data: verification } = await svc
  .from('phone_verifications')
  .select('verified_at')
  .eq('invitation_token', token)
  .eq('phone_e164',       normalizedPhone)
  .not('verified_at', 'is', null)
  .gt ('verified_at', freshnessCutoff)
  .maybeSingle();
if (!verification?.verified_at) return { ok: false, error: 'verify_phone_required' };
```

Two `fetch` calls satisfy that. The number written onto the patient's profile as `phone` with `phone_verified_at` stamped need never have received a message.

On the authenticated side it is worse, because `verifyPhoneOtpForUser` short-circuits on a pre-existing verified row before it ever looks at the code:

```ts
// app/(auth)/verify-phone/actions.ts:174
if (priorVerification?.verified_at) return { ok: true };
```

Plant the row, type any six digits, and the action stamps `profiles.phone_verified_at`.

**Example attack scenario**

A fraud ring buys a batch of leaked SA ID numbers. Each one needs a phone number that will pass verification and that the ring controls on paper but not in fact — a number belonging to the ID's real owner, so the account looks consistent to a human reviewer, or a burner they never have to keep. They plant verified rows for whichever number suits, run the checkout flow, and take a plan per ID. Nothing in the SMS provider's logs shows an OTP for those numbers, so the one artefact that would have exposed the pattern does not exist.

Separately: this is the control that stops one person opening accounts faster than SMS delivery allows. Removing it removes the cost ceiling on the bot chain in §5.

**Potential impact**

Complete bypass of the only liveness-adjacent control on the anonymous checkout door. Contaminates `profiles.phone` and `phone_verified_at` platform-wide, which are what dunning notifications, fraud correlation and support identity checks rest on. Enables A-03 without needing to receive an SMS.

**Recommended fix**

Do not let the caller choose the hash, and do not let the caller reach the RPC.

1. **Move code generation into the database.** `prepare_phone_verification` should take `(p_token, p_phone)` only, generate the code itself, store `crypt(code, gen_salt('bf'))` (or a peppered digest computed in-function from a value in `pg_settings`), and return the code to the *service-role caller only* — which then sends the SMS. Drop the three-argument signature.
2. **Revoke the RPCs from `anon` and `authenticated` entirely**, and add `REVOKE ALL ... FROM PUBLIC` (see A-02 — without that line the revoke does nothing). The server actions already hold the service-role client; there is no legitimate browser caller. This alone closes the finding even before step 1, and it is a two-line migration.
3. While there: make `verify_phone_otp` compare with a constant-time comparison and drop the `verified_at IS NOT NULL → 'ok'` short-circuit in favour of an explicit "already verified" code, so the app is not relying on a truthy row to mean a successful ceremony.

**How to test the fix**

`supabase/migrations/security-audit-2026-09-02-otp-rpc.rpc.test.ts` already contains the proof. Invert the three `A-01` assertions: after the fix, `set role anon; select prepare_phone_verification(...)` must raise `permission denied for function`, and the three-argument signature must not exist. Add an assertion that `has_function_privilege('anon', 'verify_phone_otp(text,text,text)', 'EXECUTE')` is `false`.

---

### A-02 — Every `SECURITY DEFINER` function is executable by `anon`/`authenticated` via PostgreSQL's default `PUBLIC` grant

**Severity: HIGH** (systemic — it is the reason A-01 is reachable, and it silently re-opens whatever is added next)

**Location** — the whole `supabase/migrations/` set. Concretely:
- `0056_revoke_next_invoice_number_from_authenticated.sql:14` — the earlier audit's M2 fix, which does not work
- `0084_refresh_card_token_unarchive.sql:140` — `GRANT ... TO service_role` only
- `0085_checkout_sessions.sql:174` — `expire_stale_checkout_session`, `service_role` only
- Correct counter-examples, all three of them: `0058:196` / `0080:145` (`claim_plan_for_settlement`), `0119:61-63` (`find_auth_user_by_email`), `0124:150` (`delete_expired_rate_limit_hits`)

**What is wrong**

`CREATE FUNCTION` grants `EXECUTE` to `PUBLIC` by default, and every role inherits `PUBLIC`. `GRANT EXECUTE ... TO service_role` therefore grants nothing that was not already granted; it documents intent without enforcing it. And `REVOKE EXECUTE ... FROM authenticated` removes only the *explicit* grant — the role keeps `EXECUTE` through `PUBLIC`.

Migration 0056 exists specifically to stop logged-in users burning invoice numbers. It does not:

```
0056: REVOKE EXECUTE ON FUNCTION next_invoice_number() FROM authenticated;

→ has_function_privilege('authenticated', 'next_invoice_number()', 'EXECUTE')  =  true
```

That is asserted in the proof test, against the two real migration files.

**How an attacker exploits it**

Any logged-in user, from the browser, with the anon key and their own JWT:

- `POST /rest/v1/rpc/next_invoice_number` in a loop — burns the `hnpl_invoice_seq`, so real invoices are numbered `HNPL-2026-000001`, `HNPL-2026-914338`, `HNPL-2026-914339`. Cosmetic, but it is a financial document series and reconciliation depends on it.
- `POST /rest/v1/rpc/expire_stale_checkout_session {"p_token":"…","p_force":true}` — cancels a counter session mid-flow. Needs the token, which every person standing at the till can photograph off the screen.
- `POST /rest/v1/rpc/refresh_card_token {...}` — the highest-value one. `SECURITY DEFINER`, **no `auth.uid()` check at all** (`0084:50`: *"No auth.uid() to check; the card-id parameter carries the patient"*), and it rewrites a `payment_methods` row's token, un-archives it, can make it the default, and **repoints every active plan holding the old token to the new one**. Exploitation needs a `payment_methods.id`, which is a v4 UUID and not guessable — so this is not exploitable today. It is one leaked identifier away from being a card-substitution primitive, and the only thing standing in the way is an accident of ID entropy.
- And the whole of A-01, which is reachable through the *explicit* `anon` grant rather than this one, but which cannot be closed without fixing this: `REVOKE ... FROM anon, authenticated` on those functions leaves `PUBLIC` untouched.

**Example attack scenario**

The immediate scenario is the one above. The structural scenario is the one that matters: someone adds `approve_plan_for_admin(p_plan_id)` next quarter, writes `GRANT EXECUTE ... TO service_role`, reviews it, ships it — and every patient can call it.

**Potential impact**

Today: invoice-series corruption, targeted checkout denial. Structurally: a standing, invisible privilege-escalation channel on every future privileged function.

**Recommended fix**

Two migrations, in this order.

1. **Set the default for everything future**, so nobody has to remember:
   ```sql
   ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
   -- and for each role that creates objects in this project:
   ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
     REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
   ```
2. **Sweep what exists.** Revoke from `PUBLIC` across the board, then re-grant only what the browser genuinely needs:
   ```sql
   REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
   -- then, explicitly, the ones a browser must reach:
   GRANT EXECUTE ON FUNCTION get_invitation_by_token(TEXT)            TO anon, authenticated;
   GRANT EXECUTE ON FUNCTION stamp_invitation_viewed(TEXT)            TO anon, authenticated;
   GRANT EXECUTE ON FUNCTION get_checkout_session_by_token(TEXT)      TO anon, authenticated;
   GRANT EXECUTE ON FUNCTION stamp_checkout_session_scanned(TEXT)     TO anon, authenticated;
   GRANT EXECUTE ON FUNCTION get_practice_invitation_by_token(TEXT)   TO anon, authenticated;
   GRANT EXECUTE ON FUNCTION redeem_till_registration_code(TEXT,TEXT) TO anon, authenticated;
   GRANT EXECUTE ON FUNCTION change_default_card(uuid)                TO authenticated;
   GRANT EXECUTE ON FUNCTION set_default_card_flag(uuid)              TO authenticated;
   GRANT EXECUTE ON FUNCTION archive_card(uuid)                       TO authenticated;
   GRANT EXECUTE ON FUNCTION crm_accounts_billing_summary()           TO authenticated;
   ```
   Note what is deliberately absent from that list: both phone-OTP pairs (A-01), `consume_rate_limit` (A-11), and `accept_practice_invitation` (A-07 — move its call behind the service-role client).

   `REVOKE ... FROM PUBLIC` also strips the RLS-helper predicates (`is_practice_member`, `practice_can_trade`, …). Those are called *inside* policies, which execute as the policy owner, so revoking them from `PUBLIC` is safe — but verify it in staging with the existing `.rls.test.ts` suite before pushing, because a mistake here breaks every read at once.

**How to test the fix**

The proof test's second case (`an explicit REVOKE ... FROM PUBLIC is what actually closes it`) is the shape. Add a schema-wide guard that fails the build on regression:

```sql
SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND has_function_privilege('anon', p.oid, 'EXECUTE')
   AND p.proname NOT IN (/* the explicit allow-list above */);
-- must return zero rows
```

---

### A-03 — `initiateCheckout` resets an existing patient's password, mints a session as them, and overwrites their identity fields

**Severity: CRITICAL**

**Location** `app/checkout/[token]/actions.ts` — `:373` (caller-supplied email), `:610` (the `reuse` branch), `:721-751` (the profile upsert), `:863` (the password reset), `:869` (the sign-in). Decision at `app/checkout/[token]/_lib/discriminate.ts:51`. The binding that makes it reachable is `lib/patients/billIdentity.ts:141-146` (case C).

**What is wrong**

`initiateCheckout` establishes the caller's session like this:

```ts
// :862
const sessionTempPwd = generateTempPassword();
const { error: pwdErr } = await svc.auth.admin.updateUserById(userId, { password: sessionTempPwd });
// :869
const { error: signInErr } = await supabaseAuth.auth.signInWithPassword({
  email: normalizedEmail, password: sessionTempPwd,
});
```

Unconditional. There is no `isNewUser` guard anywhere near it, which is fine for the branch where `userId` came from `svc.auth.admin.createUser` a few lines earlier — and is an account takeover for the other branch:

```ts
// _lib/discriminate.ts:51
if (planPatientId !== null && planPatientId === existing.id) {
  return { action: 'reuse', userId: existing.id };
}
```

`reuse` means: *this plan is already bound to this existing account, so carry on with it.* The `reject-organic-collision` guard directly below it — the one that refuses a confirmed account and sends the caller to `/login` — only fires when the plan is bound to **somebody else**. The exact case where the account is most valuable is the case that is waved through.

And on the counter-session path the email is the caller's:

```ts
// :371
const emailInput = (input.email ?? '').trim().toLowerCase();
if (!isValidEmail(emailInput)) return { ok: false, error: 'Enter a valid email address.' };
normalizedEmail = emailInput;
```

Before the password reset, the same request also overwrites the account's identity fields (`:721-751`), again with no `isNewUser` condition:

```ts
const profileFields = {
  id: userId, role: 'patient', email: normalizedEmail,
  first_name: firstName.trim(), last_name: lastName.trim(),
  phone: normalizedPhone, sa_id_number: encryptedSaId, sa_id_lookup_hash: saIdLookupHash,
  salary_day: salaryDay, phone_verified_at: phoneVerifiedAt,
  terms_accepted_at: new Date().toISOString(), …
};
await svc.from('profiles').upsert(profileFields, { onConflict: 'id' });
```

`profiles` is otherwise an allow-list locked by migration 0122. This path holds the service-role client, so the lock does not apply.

**How an attacker exploits it — the full chain**

The attacker is a practice: any staff member with the biller capability, or anyone holding an unlocked till (device secret in `localStorage` plus the six-digit practice PIN).

1. **Bind a plan to the victim.** Raise a QR-delivered bill using the victim's SA ID number — which the practice has, because they photocopied the ID card at reception. `resolveBillIdentity` case C (`billIdentity.ts:141`) stamps `plans.patient_id = <victim>` for a returning patient under QR delivery, by design, and `createBill`/`issueCounterSession` hand back a `checkout_sessions` token. Under QR delivery the token is **rendered as a QR code on the practice's own screen** (`app/practice/bills/new/BillQrPanel.tsx`).
2. **Satisfy the phone gate.** Enter a phone the attacker controls and receive the real SMS — the anonymous `prepare_phone_verification` places no constraint on which number is verified against a token. Or skip the SMS entirely via A-01.
3. **Call `initiateCheckout`** with `{ token, email: <victim's email>, phone: <attacker's>, firstName, lastName, planType, termsAccepted: true }`. `findExistingAuthUser` resolves the victim; `discriminateExistingUser` returns `reuse` because the plan is bound to them; the SA-ID duplicate check at `:596` passes because `idOwner.id === prospectiveUserId`.
4. **Outcome.** The victim's password is destroyed (they are locked out, and the reset does not notify them). The victim's `first_name`, `last_name`, `phone` and `phone_verified_at` are replaced with the attacker's. The attacker's browser holds a live session as the victim.

The attacker then has the patient portal: every plan and bill, `/patient/account/personal`, saved cards (`change_default_card`, `archive_card`), `selfSettleEntirePlan` on the victim's plans, and the masked SA ID. They can also add a passkey and keep access after any password reset the victim performs.

If the attacker does not know the email address, the three distinct error strings at `:524`, `:596` and the success path form a clean oracle: `"An account with this email already exists"` (wrong-but-real address), `"An account already exists for this ID number"` (unknown address), or it proceeds (correct address). Candidate addresses can be tested against a token.

**Example attack scenario**

A receptionist at a participating practice is bribed R2,000 per account. Each shift they raise QR bills for R1 against the ID numbers of patients seen that week, take over each account, settle nothing, and read out the SA ID and plan history for resale. Nothing in the practice's own dashboard shows a takeover — the bills look like abandoned R1 checkouts, and abandoned checkouts are routine.

A second, non-insider variant: a `checkout_sessions` token is a bearer credential displayed on a screen at a reception desk and printed onto a QR. Anyone who photographs one for a returning patient's bill and can guess or learn that patient's email address gets the same result.

**Potential impact**

Full customer account takeover by a merchant, plus victim lockout, plus silent rewrite of the identity fields that the credit file, dunning notifications and any future regulatory reporting rest on. Under POPIA this is a reportable compromise of special personal information, and the "audit trail" would show the takeover as the victim's own activity.

**Recommended fix**

`initiateCheckout` must never mint a session for an account it did not create.

1. **Refuse `reuse` for a confirmed account.** Return the existing `requireLogin` shape — the branch already written for `reject-organic-collision` — so the real patient signs in and lands on `/patient/orders/<planId>/confirm`. This is the correct product behaviour too: an existing customer paying a new bill should authenticate, not be re-onboarded.
2. **If a session must be minted** (a genuinely unconfirmed shell account created by an earlier abandoned checkout), use the mutation-free shape the F-07 fix already adopted at `app/checkout/[token]/complete/page.tsx:399` — `admin.generateLink({type:'magiclink'})` then `verifyOtp`. Never `updateUserById({password})`.
3. **Gate the profile upsert on `isNewUser`.** For an existing account, write only the fields this flow legitimately establishes for *this bill* (`salary_day` if unset) and never `first_name`, `last_name`, `phone`, `sa_id_number` or `phone_verified_at`.
4. **Collapse the oracle.** All three refusals on the counter-session path should return one message: *"Please sign in to continue with this bill."*
5. **Reconsider case C.** A QR bill for a returning patient does not need `plans.patient_id` pre-bound — the patient binds it themselves when they scan. Issuing it unbound removes the precondition this whole chain needs. If pre-binding stays, the counter-session path must not accept an email at all: resolve it from the bound profile.

**How to test the fix**

`app/checkout/[token]/session-mint-ato.adversarial.test.ts` pins all four structural facts today. After the fix, invert the three `DEFECT:` assertions and add a behavioural test on `discriminateExistingUser`: a confirmed account must never yield `reuse`, whatever `planPatientId` says. Then, end to end in a staging project: raise a QR bill against an existing patient's SA ID, POST `initiateCheckout` with their email, and assert the response is `requireLogin` and that `auth.users.encrypted_password` for that user is unchanged.

---

### A-04 — The credit limit is a check-then-act with no atomicity, so concurrent requests multiply it

**Severity: HIGH**

**Location** `lib/underwriting/creditLimit.ts:126-172`; callers at `app/patient/actions.ts:178` (`acceptPlan`), `:536` (`payWithSavedCard`) and `app/checkout/[token]/actions.ts:666`.

**What is wrong**

`checkCreditLimit` reads `profiles.approved_credit_limit`, sums uncollected instalments across live plans, compares, and returns. The write that commits the new exposure happens afterwards, in the caller. Between the read and the write there is no row lock (`FOR UPDATE`), no serialisable transaction, and — the layer that would catch it regardless — no database constraint relating `payments` in aggregate to `approved_credit_limit`.

This was introduced by the previous audit's F-10 fix. F-10 was correct that nothing enforced the limit; the enforcement it added is correct sequentially and vacuous concurrently.

**How an attacker exploits it**

Open two bills. Submit both acceptances at the same moment. Two lambdas, two connections, both read exposure = 0, both find headroom, both commit.

The proof test drives the real `checkCreditLimit`:

```
limit R5,000 · two concurrent checks of R5,000 · both ok:true
→ committed exposure R10,000

limit R5,000 · five concurrent checks of R5,000 · all ok:true
→ committed exposure R25,000
```

No timing precision is needed. Two browser tabs and two clicks inside the same second is enough; `Promise.all` from a console script is trivial. Nothing about the requests is malformed — the ordering *is* the attack, which is also why nothing logs it.

**Example attack scenario**

A customer with a R5,000 approved limit visits four practices in a week and asks each for a R5,000 procedure bill by email. They hold all four checkout links, then submit all four inside one second. All four pass. On each first-payment success HNPL creates a payout and pays the practice 94% — R18,800 out the door against R5,000 of underwritten exposure. The customer's first instalment is R2,500 per plan; they let instalments 2 and 3 fail. HNPL's loss is R18,800 minus R10,000 collected, and the dunning ladder never had a chance because the exposure was never real.

Repeat with a ring of ten customers and the practice's own cooperation, and the loss scales linearly with no new technique.

**Potential impact**

Unbounded credit exposure — the limit is a limit per in-flight request, not per customer. Direct capital loss, since the payout is irreversible (`payouts` is `UNIQUE(plan_id)` and nothing reverses it) while the instalments are not.

**Recommended fix**

Make check-and-commit one atomic step. The pattern is already in this codebase — `claim_plan_for_settlement` (0058/0080) is exactly the right shape.

1. **A `SECURITY DEFINER` RPC that does both**, e.g. `claim_credit_for_plan(p_plan_id, p_patient_id, p_plan_type, p_today)`. Inside one transaction: `SELECT approved_credit_limit FROM profiles WHERE id = p_patient_id FOR UPDATE` (the lock is what serialises concurrent callers), re-derive exposure, refuse or insert the schedule, return the claim. `acceptPlan`, `payWithSavedCard` and `initiateCheckout` all call it instead of `checkCreditLimit` + a separate insert. Revoke it from `PUBLIC`, `anon` and `authenticated` (A-02) — service-role only.
2. **Belt and braces at the database level**, so an application-layer mistake cannot reopen it: a `CONSTRAINT TRIGGER ... DEFERRABLE INITIALLY DEFERRED` on `payments` that re-derives the patient's exposure at commit and raises if it exceeds `approved_credit_limit`. Deferred is the important word — it fires after all of a transaction's rows land, so a legitimate multi-row schedule insert is evaluated once, as a whole.
3. **Add the one-plan-at-a-time rule to the checkout door.** `isBlockedFromNewPlan` guards `acceptPlan` and `payWithSavedCard` and is absent from `initiateCheckout`. Whatever the product decision on repeat customers, the two doors should not disagree.

**How to test the fix**

`lib/underwriting/creditLimit.race.adversarial.test.ts` pins the interleaving. After the fix, move it to pglite (the `.pglite.test.ts` convention is already in the repo) and run two real concurrent transactions against the new RPC: exactly one must claim, the other must return `over_limit`. Then assert the deferred trigger independently by attempting a direct service-role insert that exceeds the limit and expecting a raise.

---

### A-05 — The checkout door has no KYC gate, and skips even the credit limit for accounts it just created

**Severity: HIGH**

**Location** `app/checkout/[token]/actions.ts:236-994` (no `requireOnboarded`, no `isBlockedFromNewPlan`), `:665` (`if (!isNewUser)`). Compare `app/patient/actions.ts:128` and `:441`. Limits at `lib/config/billAmountLimits.ts:43-44`; policy at `lib/underwriting/stubAffordabilityPolicy.ts:31`.

**What is wrong**

There are two doors onto a payment plan and they enforce different rules.

| Gate | `acceptPlan` / `payWithSavedCard` | `initiateCheckout` |
|---|---|---|
| Onboarding complete (email, phone, salary, **identity**, **liveness**, credit check) | ✅ `requireOnboarded` | ❌ absent |
| Not frozen by a default | ✅ | ✅ |
| One plan at a time | ✅ `isBlockedFromNewPlan` | ❌ absent |
| Credit limit | ✅ always | ⚠️ **only `if (!isNewUser)`** |
| Card valid past the final instalment | ✅ | n/a (fresh card) |

The `if (!isNewUser)` skip is defensible in isolation — a just-created account has `approved_credit_limit = NULL`, so `checkCreditLimit` would return `no_limit` and refuse every counter sale. But the consequence is that **the one plan that is never limit-checked is the customer's first**, and the first plan is the one that triggers a real 94% payout of HNPL's own capital.

The ceiling that remains is `MAX_BILL_AMOUNT`, default **R50,000** (`NEXT_PUBLIC_MAX_BILL_AMOUNT`). The affordability policy grants **R5,000**. So the unwritten rule is: first bill, ten times the policy limit, no identity verification, no liveness, no affordability, on the strength of a typed name, an SA ID number, and a phone OTP that A-01 shows is not an OTP.

A related ordering gap: `runCreditCheck` (`lib/onboarding/actions.ts:605`) is a Server Action any patient can invoke directly. It checks `role === 'patient'` and nothing else — not that the identity step passed. So a patient can grant themselves `credit_check_status='passed'` and `approved_credit_limit = 5000` while skipping Didit entirely. `onboarding_completed` still stays false (so the in-app door holds), but `checkCreditLimit` — the checkout door's only gate — now passes.

**How an attacker exploits it**

Obtain an SA ID number belonging to somebody with no BetterNow account (leaked datasets are widely traded in South Africa; `findPatientBySaId` tells you for free whether the ID is already registered, by which error you get). Get a bill raised — walk into a participating practice and ask, or collude with one. At checkout, type the victim's name and ID, verify a phone you control, take R50,000. HNPL pays the practice R47,000. Let the first instalment be the only one that clears.

**Example attack scenario**

A practice and an operator split the proceeds. The practice raises R50,000 bills to order against ID numbers the operator supplies. Each plan takes one R16,667 first instalment on a prepaid card the operator funds, HNPL pays the practice R47,000, and instalments two and three fail. Net R30,333 extracted per identity, and the identity used is not the operator's — the debt, the default and the credit-bureau consequence land on a stranger who never heard of the platform.

**Potential impact**

Direct capital loss at R47,000 per identity. Every one of those plans is unenforceable — the signature is not the ID holder's — so the receivable is fictional and the loss is total. Regulatory exposure under the NCA (reckless credit: no affordability assessment was performed) and POPIA (processing special personal information without a lawful basis).

**Recommended fix**

1. **Set an explicit unverified-account ceiling** rather than falling through to `MAX_BILL_AMOUNT`. Replace `if (!isNewUser)` with a real policy value — `FIRST_PLAN_LIMIT`, at or below the affordability grant — and enforce it for new accounts through the same atomic claim as A-04. A new account should have a limit, not an absent one.
2. **Require identity verification before HNPL's capital moves**, even if not before the plan is created. The cleanest form: `initiateCheckout` may create the plan and take the first instalment, but `activateFirstInstalment` refuses to create the `payouts` row unless `liveness_verified_at IS NOT NULL` and `identity_verification_status = 'approved'`. The patient is then routed through Didit before the practice is paid. That preserves the counter experience — the card is charged at the till — and puts the KYC gate exactly where the money leaves.
3. **Give `runCreditCheck` a precondition.** It should refuse unless every step before `credit-check` in `stepListFor` is complete — `computeOnboarding` already computes that; call it and check `status.step === 'credit-check'`.
4. **Bring the two doors into line** on `isBlockedFromNewPlan`. If the product wants repeat customers exempt, express that once, in one place, and apply it on both paths.

**How to test the fix**

Add a test that asserts `initiateCheckoutBody()` contains no unconditional credit-limit skip and that `FIRST_PLAN_LIMIT` bounds the new-account branch. For the payout gate, extend `lib/payments/activateFirstInstalment.test.ts`: a plan whose patient has `liveness_verified_at = null` must produce `ok:false, step:'payout'` (or an explicit `withheld` outcome) and **no** `payouts` row. For `runCreditCheck`, assert it returns an error when `sa_id_number` is null.

---

### A-06 — The `*_for_user` phone RPCs accept any `p_user_id` and never compare it to `auth.uid()`

**Severity: MEDIUM** (HIGH in combination with A-01)

**Location** `supabase/migrations/0053_phone_verification_user_keying.sql:89`, `:167`; re-issued without an auth check by `0055:133` and `0099:86`. Granted to `authenticated` at `0053:154` and `:218`.

**What is wrong**

Both functions take the target user as a parameter. `verify_phone_otp_for_user` has no ownership check whatsoever. `prepare_phone_verification_for_user` gained one in 0055 — but it checks the *phone*, not the *caller*: `p_phone` must match the target's `profiles.phone` or `phone_pending`. Nothing anywhere asks whether `auth.uid() = p_user_id`.

Note what the 0099 header says about this: *"profiles.phone is already patient-writable … so a caller could always point the guard at a number of their choosing."* That reasoning holds for the caller's **own** profile. It does not hold for somebody else's, and the guard is applied to the profile named by `p_user_id`.

**How an attacker exploits it**

Any logged-in user, against any user id they know:

- **Attempt burn / onboarding lockout.** Five calls to `verify_phone_otp_for_user(victim, victim_phone, 'guess')` and the row returns `too_many_attempts`. The victim, holding the correct code, is locked out of phone verification — which blocks the onboarding step, which blocks `requireOnboarded`, which blocks them accepting any bill. Proved in the test file. Repeatable indefinitely.
- **Phone-number oracle.** `phone_mismatch` versus `ok` distinguishes a wrong candidate number from the right one, so candidate numbers can be tested against a known user id until one lands. Proved in the test file.
- **With A-01**, plant a verified row on another account outright.

User ids are v4 UUIDs, so this needs one to start from — but they are not secrets in this system: `plans.patient_id` is readable by every practice member of the treating practice, `provider_id` appears on payouts, and the checkout flow puts `SHOPPER_patientId` into a Peach `customParameters` field.

**Potential impact**

Targeted denial of onboarding (a customer who cannot verify a phone cannot transact), and disclosure of a patient's cellphone number — special personal information under POPIA when linked to a healthcare payment record.

**Recommended fix**

Add the binding, then remove the reachability.

```sql
IF auth.uid() IS NULL OR auth.uid() <> p_user_id THEN
  RETURN 'invalid_user';   -- same code for both, so it is not an oracle
END IF;
```

Then drop `p_user_id` from the signature entirely and use `auth.uid()` — a parameter that must always equal a value the function can read itself should not be a parameter. Finally revoke both from `authenticated` and `PUBLIC` (A-01, A-02) so only the service-role caller reaches them; at that point pass the id explicitly again, from a server action that sourced it from `getUser()`.

**How to test the fix**

The `A-01b` block in the proof test already sets `auth.uid()` to the attacker and calls against the victim. Invert its three assertions.

---

### A-07 — `accept_practice_invitation` does not check who owns the practice it links

**Severity: MEDIUM**

**Location** `supabase/migrations/0068_practice_invitations.sql:124-148`; granted to `authenticated` at `:148`.

**What is wrong**

```sql
CREATE OR REPLACE FUNCTION accept_practice_invitation(p_token TEXT, p_practice_id UUID)
… SECURITY DEFINER …
  UPDATE practice_invitations
     SET accepted_at = now(), accepted_by_practice_id = p_practice_id
   WHERE token = p_token AND accepted_at IS NULL AND expires_at > now()
  RETURNING lead_id INTO v_lead_id;
```

`p_practice_id` is written verbatim. Nothing checks that the caller owns or is a member of it. The header explains the `SECURITY DEFINER` as *"so the update proceeds even when the caller is the newly-created practice-admin session (which has no read access to the row)"* — a real problem, solved by removing the read restriction rather than the authorisation.

**How an attacker exploits it**

Any authenticated user holding a live practice-invitation token — the invited practitioner, or anyone who received a forwarded signup email — calls it with an arbitrary `p_practice_id`. The invitation is burned (`accepted_at` set), so the genuine practitioner's signup link stops working, and the CRM lead is linked to a practice of the caller's choosing. Since `crm_flip_lead_onboarded_on_practice_approve` and `crm_accounts_billing_summary` key off `converted_practice_id`, the sales attribution and the account's billing view follow.

The token is single-use and scoped to one lead, so this is not a mass-assignment vector. It is a denial of a partner's onboarding plus corruption of the sales record.

**Potential impact**

Onboarding denial for an invited practice; CRM attribution corruption; a lead's billing summary pointed at an unrelated practice.

**Recommended fix**

Add the membership check inside the function, and make the failure indistinguishable from a bad token:

```sql
IF NOT EXISTS (
  SELECT 1 FROM practice_members
   WHERE practice_id = p_practice_id AND user_id = auth.uid() AND active
) AND NOT EXISTS (
  SELECT 1 FROM practices WHERE id = p_practice_id AND owner_id = auth.uid()
) THEN
  RETURN NULL;
END IF;
```

Better: the practice-signup action already holds the service-role client at the point it calls this. Move the call onto that client and revoke the function from `authenticated` and `PUBLIC` (A-02). Then no browser can reach it at all.

**How to test the fix**

A pglite RPC test in the `0070_accept_practice_invitation.rpc.test.ts` style: user A holding a live token, calling with user B's `practice_id`, must get `NULL` and leave `accepted_at` null.

---

### A-08 — `sanitizeSignatureHtml` is a regex blocklist and leaks executable HTML into `dangerouslySetInnerHTML`

**Severity: MEDIUM**

**Location** `lib/gmail/signature.ts:101-128`. Rendered at `app/crm/settings/SignatureEditor.tsx:168` and `app/crm/leads/[id]/ComposeEmailSheet.tsx:372`; also shipped in outbound email via `composeWithSignature`.

**What is wrong**

The function removes a fixed list of tags, strips `\s+on[a-z]+=…`, and rewrites `javascript:`/`vbscript:`/`data:` inside `href`/`src`/`action`/`formaction`. Blocklist sanitizers of this shape are bypassable as a class. Four bypasses, all confirmed by the proof test:

| Payload | Why it survives |
|---|---|
| `<img/onerror=alert(1) src=x>` | `/` is a legal attribute separator and is not `\s`, so the three `\s+on[a-z]+` patterns never match |
| `<svg/onload=alert(1)>` | same |
| `<a href="j&#97;vascript:alert(1)">` | the regex matches the literal string; the HTML parser decodes the entity **after** sanitisation |
| `<a href="java\nscript:alert(1)">` | browsers strip control characters from URLs before scheme matching; the regex does not |
| `<script src="//evil.example/x.js"` (unterminated) | the paired pattern needs a closing tag, the self-closing pattern needs a `>`; browsers recover and open the element |

**How an attacker exploits it**

`crm_signatures` is per-user (`user_id = auth.uid()`, `role IN ('sales','admin')`), so today the in-app rendering is self-inflicted — a rep XSSing their own browser. Two things make it worth fixing anyway:

- `crm_signatures_self_select` grants **`role = 'admin'`** read access to every rep's signature. Any admin surface that renders another user's signature turns this into sales → admin escalation, and an admin session on this platform can change credit limits, settle payouts and export customer data.
- The sanitised HTML is sent to leads by email. Email clients are a different and less forgiving rendering target, and a malformed signature is a deliverability and reputation problem even without script execution.

**Potential impact**

Today: self-XSS, and a latent sales → admin escalation the moment an admin view renders another user's signature. The function is also the obvious thing to reach for the next time user HTML needs sanitising, and it will be wrong there too.

**Recommended fix**

Replace it with a parser-based allow-list and delete the regexes. `isomorphic-dompurify` or `sanitize-html` with an explicit tag/attribute allow-list (`a[href] img[src,alt,width,height] table tr td div span strong em br p`, `href` restricted to `https:` and `mailto:` by parsed URL scheme, no `on*` at all). Keep the function name and signature so the two call sites do not change. Until that lands, drop `htmlOverride` and render only `renderBrandSignatureHtml`, which escapes every interpolation and is not affected.

**How to test the fix**

`lib/gmail/signature.sanitizer-bypass.adversarial.test.ts` holds all five payloads. Invert the `toContain` assertions to `not.toContain`. Add the standard OWASP filter-evasion list while you are there — an allow-list will pass it and a blocklist will not.

---

### A-09 — The CRM child tables are not owner-scoped, so any sales rep reads every rep's leads

**Severity: MEDIUM**

**Location** `supabase/migrations/0069:*`, `0071:*`, `0075:*`, `0107:*`, `0110:*`, `0117:*` — all `USING ((SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin','sales'))`. Compare `0113_crm_leads_owner_scoped_rls.sql`.

**What is wrong**

Migration 0113 deliberately narrowed `crm_leads` so a `sales` user sees only rows where `owner_user_id = auth.uid()`. Its child tables were not narrowed with it:

`crm_activities`, `crm_lead_contacts`, `crm_tasks`, `crm_lead_tags`, `crm_saved_views`, `crm_email_templates`, `crm_suggestion_dismissals` — every one grants full `SELECT`/`INSERT`/`UPDATE`/`DELETE` to any `sales` role, unscoped.

So the parent row is hidden and the children are not. `crm_lead_contacts` is the richer table anyway: practitioner names, direct emails, cellphone numbers, HPCSA numbers, decision-maker flags and interest levels. `crm_activities` carries the call notes and the email bodies.

**How an attacker exploits it**

A `sales` user, from the browser with their own JWT:

```
GET /rest/v1/crm_lead_contacts?select=*                 → every contact, all reps
GET /rest/v1/crm_activities?select=*&order=created_at.desc  → every call note and email body
DELETE /rest/v1/crm_tasks?id=eq.<any>                   → another rep's pipeline
```

Exfiltration of the whole prospect database is one request. A departing rep takes the book with them; the audit trail shows an ordinary API read.

**Potential impact**

Loss of the entire commercial prospect list including practitioner personal contact details and HPCSA registration numbers (personal information under POPIA). Cross-rep tampering with tasks and activities, with `crm_audit_log` visible only to admins.

**Recommended fix**

Extend 0113's predicate to every child table, correlating through the parent lead so one definition governs:

```sql
CREATE OR REPLACE FUNCTION crm_can_see_lead(p_lead_id uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT (SELECT role FROM profiles WHERE id = auth.uid()) = 'admin'
      OR EXISTS (SELECT 1 FROM crm_leads l
                  WHERE l.id = p_lead_id AND l.owner_user_id = auth.uid());
$$;
```

Then rewrite each child policy as `USING (crm_can_see_lead(lead_id))` with the matching `WITH CHECK`. `crm_saved_views` and `crm_suggestion_dismissals` have no `lead_id`; scope those on `user_id = auth.uid()`. `crm_email_templates` is plausibly shared — if so, make it `SELECT` for all sales and `INSERT`/`UPDATE`/`DELETE` for admin only, rather than leaving write open.

**How to test the fix**

The repo already has `0112_0113_crm_owner_scoped_rls.rls.test.ts`. Extend it: two `sales` users, one lead each, and assert every child table returns zero rows across the boundary for `SELECT`, `UPDATE` and `DELETE`.

---

### A-10 — `crm_leads` UPDATE lets a sales rep hand a lead to another owner

**Severity: LOW**

**Location** `supabase/migrations/0113_crm_leads_owner_scoped_rls.sql` — the UPDATE policy.

**What is wrong** The `USING` clause correctly requires `owner_user_id = auth.uid()` for a `sales` caller. The `WITH CHECK` clause drops the predicate and requires only `role = 'sales'`. So the row the rep may write is scoped, but the value they may write into `owner_user_id` is not.

**How an attacker exploits it** A rep reassigns their own lead to another rep — dumping a dead lead onto a colleague's quota, or pushing a lead out of their own visibility to hide activity before it is audited. They cannot pull another rep's lead to themselves (`USING` blocks the read side), so the impact is one-directional.

**Potential impact** Sales-attribution manipulation and quota gaming. No data exposure.

**Recommended fix** Mirror the `USING` predicate into `WITH CHECK`:
```sql
WITH CHECK (
  (SELECT role FROM profiles WHERE id = auth.uid()) = 'admin'
  OR ((SELECT role FROM profiles WHERE id = auth.uid()) = 'sales'
      AND owner_user_id = auth.uid())
)
```
Reassignment should be an admin action, or a `sales`-callable RPC that logs to `crm_audit_log`.

**How to test the fix** Add to `0112_0113_crm_owner_scoped_rls.rls.test.ts`: a `sales` user updating their own lead's `owner_user_id` to another user must be refused.

---

### A-11 — `consume_rate_limit` is `anon`-executable with caller-supplied parameters

**Severity: MEDIUM**

**Location** `supabase/migrations/0124_rate_limits.sql:120` — `GRANT EXECUTE ON FUNCTION consume_rate_limit(TEXT, TEXT, INT, INT) TO anon, authenticated, service_role;`

**What is wrong** The rate limiter's own store is directly writable by the internet. Every parameter — bucket, subject, max, window — comes from the caller, and `lib/security/rateLimit.ts` is the only thing that normally supplies sensible values. The grant to `anon` is not needed: every call site (`consumeRateLimit`, `consumeAll`) builds a service-role client.

**How an attacker exploits it**

- **Targeted denial.** Spend a victim's budget before they do. `consume_rate_limit('signup', '<victim IP>', 10, 3600)` ten times and that IP cannot sign up for an hour. `('checkout_initiate', '<their token>', 10, 3600)` and their bill cannot be paid — the token expires while they retry. `('identity_session', '<their user id>', 5, 86400)` and their KYC is blocked for a day. The subject keys are guessable (an IP) or observable (a token in a URL, a user id from `customParameters`).
- **Storage exhaustion.** Each call inserts a row into `rate_limit_hits`. Nothing rate-limits the rate limiter. Rows are pruned once daily by the collection cron, so an attacker has 24 hours of unbounded inserts per cycle to fill the table and the WAL.
- **Concealment.** A limit that has been exhausted by an attacker looks identical in the logs to one exhausted by the legitimate user.

**Potential impact** Targeted denial of signup, checkout and KYC for a chosen victim, and a cheap database-bloat channel on a shared instance.

**Recommended fix** Revoke it from `anon` and `authenticated`, and from `PUBLIC` (A-02):
```sql
REVOKE ALL ON FUNCTION consume_rate_limit(TEXT, TEXT, INT, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION consume_rate_limit(TEXT, TEXT, INT, INT) TO service_role;
```
Also clamp the parameters defensively inside the function (`p_max` between 1 and 1000, `p_window_secs` between 1 and 86400) and reject unknown buckets against a fixed list, so a future accidental grant is less useful. And prune `rate_limit_hits` more often than daily — it is a `DELETE` on an index, and hourly costs nothing.

**How to test the fix** `has_function_privilege('anon', 'consume_rate_limit(text,text,int,int)', 'EXECUTE')` must be `false`. Assert the existing limiters still work through the service-role client.

---

### A-12 — No audit trail on the admin actions that move money or grant roles

**Severity: MEDIUM**

**Location** `admin_audit_log` is written by exactly two actions: `app/admin/_lib/auditActions.ts:79` (`addNote`) and `:135` (`changePracticeFeePercent`). Not written by `app/admin/payouts/actions.ts:43` (`markBatchPaid`), `:80` (`markPayoutPaid`), `app/admin/collections/actions.ts:28` (`retryCollection`), `app/admin/sales-team/actions.ts:53`/`:104` (grant/revoke `sales`), `app/admin/groups/actions.ts` (group banking), `app/brand/actions.ts:598` (`updateBranchBanking`).

**What is wrong** Migration 0048 built the right table with the right policy — `is_platform_admin() AND actor_id = auth.uid()`, so attribution cannot be forged. Then almost nothing was wired into it. `practices` has its own trigger-based trail (`log_practice_protected_changes`, 0046), and `plan_events` records the customer-visible lifecycle. Between them, the admin actions that matter most are unrecorded:

- marking a payout batch **paid** — the assertion that money left the bank
- retrying a collection — a real card charge
- granting or revoking the `sales` role — which confers read access to the whole CRM
- changing a practice's or branch's banking details — where the money goes

**How an attacker exploits it** A compromised or malicious admin session marks batches paid that were never sent, retries collections to generate noise that hides a specific charge, or changes a practice's banking details, waits for the Friday EFT, and changes them back. Nothing in the database records who did any of it or when. Vercel request logs are the only trace, they carry no actor identity, and they roll off.

**Potential impact** Undetectable insider fraud on the settlement path, and no forensic record after an admin credential compromise. A single admin account is the highest-value target on this platform (F-16 from the previous audit — MFA — is still open), and today it leaves no footprints.

**Recommended fix** One helper, called from every state-changing admin action:

```ts
await svc.from('admin_audit_log').insert({
  actor_id: user.id, action: 'payout_batch_marked_paid',
  entity_type: 'payout_batch', entity_id: batchId,
  payload: { from: 'pending', to: 'paid', gross_total: … },
});
```

Write it **before** the state change, and record the outcome, so an action that fails halfway is still visible. For banking details specifically, use the 0046 trigger pattern instead — a trigger cannot be forgotten by a new code path. And surface it: an admin screen listing the last 100 privileged actions is what turns a log into a control.

**How to test the fix** For each action, assert an `admin_audit_log` row with the correct `actor_id`, `action` and `entity_id` after a successful call, and that a refused call writes no row (or writes one marked refused, whichever you choose — but choose).

---

### A-13 — A transport error during "settle entire bill" freezes the whole remaining balance in `processing`

**Severity: MEDIUM**

**Location** `app/patient/orders/settle-actions.ts:313-324`.

**What is wrong** `claim_plan_for_settlement` flips every outstanding instalment to `processing` with `settled_by_payment_id` set, then the provider is called. Three outcomes are handled differently:

- `rejected` → `failSettlementRow`, and the webhook's `handleSettlementChargeFailed` reverts each covered row to its snapshot status. Correct.
- success → the webhook collects them. Correct.
- **`error` (transport)** → the action returns `transport_error` and **leaves everything in `processing`**.

The comment says the row is left for reconciliation, but nothing reconciles it. `attemptChargeInstalment` claims only `scheduled`/`failed`/`defaulted`; the collection cron selects only `scheduled` and `failed`; `assessDunningFee` looks only at `failed`. A `processing` instalment with no live Peach reference is invisible to every automated path, permanently.

**How an attacker exploits it** Not really an attack — a reliability defect with a financial sign. But it is reachable on purpose: a patient who wants collection to stop can click "Settle entire bill" repeatedly during any provider incident, or from a connection engineered to drop the request. One transport error and the remaining balance is frozen, the plan never completes, no dunning fee is ever assessed, and `isPatientFrozen` never fires because nothing reaches `defaulted`.

**Potential impact** Silent, permanent write-off of the remaining balance on affected plans, with no alert. The exposure also stops counting toward `outstandingExposure` correctly relative to reality, so A-04's limit sees a plan that will never be collected as still live.

**Recommended fix**

1. On `status === 'error'`, do what the `rejected` branch does: `failSettlementRow`, and revert the covered instalments from the snapshot in the same action rather than waiting for a webhook that will never arrive (there is no Peach-side transaction to call back about).
2. Add a **stuck-`processing` sweep** to the daily cron: any `payments` row in `processing` for more than N hours with no `peach_payment_id`, or whose Peach status query returns "not found", is reverted from its snapshot and logged with an alertable prefix. This is the safety net for every path that can strand a claim, not just this one — and there are three others (`initiateCheckout`'s instalment 1, `payWithSavedCard`'s, and the cron's own claim).
3. Alert on it. A `processing` row older than a day is an operator-actionable event.

**How to test the fix** Extend `lib/checkout/declineCheckoutSessions.pglite.test.ts`'s style: claim a plan, simulate a transport error, and assert every covered instalment is back at its snapshot status with `settled_by_payment_id` null. For the sweep, seed a stale `processing` row and assert one cron run reverts it.

---

### A-14 — Terms acceptance is asserted by a URL query parameter

**Severity: LOW**

**Location** `app/auth/callback/route.ts:283` — `const consentGiven = url.searchParams.get('terms_accepted') === '1';`

**What is wrong** The legal record that a user accepted the terms and privacy policy — `terms_accepted_at`, `terms_version`, `privacy_version` — is written on the strength of a query string the user's own browser supplies. The previous audit added adversarial tests for the *refusal* direction (a user who does not accept is bounced), and those hold. The assertion direction is unguarded: appending `&terms_accepted=1` to the OAuth callback records an acceptance for a document never rendered.

**How an attacker exploits it** They do not — it is self-serving, and the "attacker" is the person whose consent it is. The exposure runs the other way: the record is not evidence. A customer disputing an NCA agreement can point out that the acceptance flag was set by a parameter they controlled, and the platform cannot show the terms were displayed.

**Potential impact** Unenforceable consent records. In a credit product under the NCA, and for POPIA §11 consent to process special personal information, that is a real weakness in a real dispute.

**Recommended fix** Bind the assertion to something the server issued. Set a short-lived signed cookie (or a `state` value stored server-side) when the login page renders the acceptance checkbox, and require it on the callback — then the record attests that the server showed the document. Store the rendered version hash alongside `terms_version`, so "which text did they accept" is answerable from the row.

**How to test the fix** Extend `app/oauth-terms-consent.test.ts`: a callback carrying `terms_accepted=1` with no matching server-issued token must return `needs-terms`.

---

### A-15 — The Peach webhook's unsigned JSON branch logs arbitrary attacker content and always returns 200

**Severity: LOW**

**Location** `app/api/payments/peach/webhook/route.ts:957-1013`.

**What is wrong** Any `POST` with `Content-Type: application/json` and a parseable body reaches a branch that requires no signature, logs the entire body twice (single-line and pretty-printed), and returns 200. The reasoning is documented and sound — Peach's registration handshake arrives before HMAC signing is configured, and the Dashboard needs a 200 — but the branch is permanent, unauthenticated and unbounded.

**How an attacker exploits it** Unauthenticated log injection: forged log lines (newlines are not escaped in the pretty-printed form) to confuse or discredit the audit trail, and unbounded volume to drive up log-ingestion cost and push real webhook events out of the retention window. A `1 MB` body, at whatever rate the platform allows, indefinitely.

**Potential impact** Log-integrity damage on the one surface where webhook forensics happen, and observability cost. No state change.

**Recommended fix** Make the branch temporary and narrow, since registration is a one-time event:
1. Gate it on an env flag (`PEACH_WEBHOOK_ALLOW_UNSIGNED_PROBE=1`) that is on during registration and off afterwards. With it off, an unsigned JSON body gets 401.
2. While on: cap the logged body (2 KB), log `JSON.stringify` output only (never the multi-line form), and spend from the shared rate limiter keyed on IP.
3. Once HMAC signing is confirmed live at Peach, delete the branch.

**How to test the fix** Add to `app/api/payments/peach/webhook/route.test.ts`: with the flag unset, an unsigned JSON body returns 401; with it set, a 5 MB body is logged truncated.

---

### A-16 — Dependency advisories: one runtime, the rest dev-only

**Severity: LOW** (the runtime one is unchanged from the previous audit's F-15)

`pnpm audit` reports 14 advisories: 11 high, 2 moderate, 1 low.

**Runtime — the only one that ships:**

| Package | Advisories | Reachability |
|---|---|---|
| `xlsx@0.18.5` | Prototype pollution (`<0.19.3`), ReDoS (`<0.20.2`) | `lib/crm/xlsxToCsv.ts`, called from the CRM import actions — `sales`/`admin` only |

Unchanged, and the previous audit's analysis is still correct: SheetJS left npm at 0.20, the fixed builds are on the vendor's CDN only, and repointing a dependency at a non-registry URL is a supply-chain decision for a human. The mitigations in `xlsxToCsv.ts` (workbook size cap, refusal on any workbook that disturbs `Object.prototype`) bound it. My addition: the attacker here must already hold a `sales` session, and prototype pollution in the Next server process is a serious primitive — so pair this with A-09 (which currently lets any sales user reach far more than their own leads) when deciding urgency. If the CDN dependency is unacceptable, replace `xlsx` with `exceljs` for the read path; the import code needs only sheet-to-CSV.

**Dev/build only — not shipped, and cheap to clear:**

| Package | Reached via | Fix |
|---|---|---|
| `brace-expansion` (4 advisories, DoS) | `eslint-config-next` → eslint → minimatch | override `^1.1.18` / `^5.0.9` |
| `js-yaml` (3 advisories, quadratic CPU) | eslint chain | override `^4.3.1` |
| `vite` (2, incl. `server.fs.deny` bypass) | vitest | override `^8.0.16`; Windows-only |
| `esbuild` (1, arbitrary file read) | vite | override `^0.28.1`; Windows dev server only |

None of these reach production; all four are one line each in `pnpm-workspace.yaml`'s existing `overrides` block, which already carries four such pins. Worth doing so the audit output stays legible — a report that is permanently noisy is a report nobody reads.

**Everything else is current:** `next@16.2.11`, `react@19.2.4`, `@supabase/ssr@0.10.3`, `@supabase/supabase-js@2.106.0` — no advisories.

---

### A-17 — Any patient can insert phantom `applications` rows against any practice

**Severity: LOW**

**Location** `supabase/migrations/0002_rls_policies.sql:153`:

```sql
CREATE POLICY "patients_insert_own_applications" ON applications
  FOR INSERT WITH CHECK (patient_id = auth.uid());
```

**What is wrong** The only predicate is that the row names the caller. `practice_id`, `bill_amount` and `status` are unconstrained — there is no check that the patient has any relationship to the practice, no trading-gate check (unlike the practice-side INSERT policy, which 0043 correctly gates on `practice_can_trade`), and no `protect_*` trigger on this table at all. `practice_members_delete_applications` (0006) is likewise unbounded by lifecycle stage, where the equivalent plan deletion is limited to `pending_acceptance` by `protect_plans_write`.

`applications` is a real bill record. In the original schema it is the request a practice raises before a plan exists, and it is read by the patient's orders view (declined applications render there) and by `practice_members_select_applications` on the practice side.

**How an attacker exploits it** A patient, from the browser:

```
POST /rest/v1/applications
{ "patient_id": "<self>", "practice_id": "<any practice>",
  "bill_amount": 99999, "status": "pending" }
```

No plan is created — `plans` INSERT requires `is_practice_biller` and the trading gate — so no money moves and the credit paths are untouched. What lands is a phantom bill record in that practice's applications list and in the patient's own orders view. A patient can also insert rows in bulk, or delete their own application history.

**Potential impact** Fabricated records in a practice's dashboard, and a patient-controlled view of their own bill history — a support and dispute-integrity problem rather than a financial one ("your system shows I was billed R99,999 by this practice"). It also means `applications` cannot be treated as evidence of anything.

**Recommended fix** Drop `patients_insert_own_applications` — nothing legitimate uses it. Both creators (`createBill`, `issueCounterSession`) run on the practice's own membership or the service-role client; a patient has never needed to insert one. Then add a `protect_applications_write` trigger on the 0121 pattern: privileged writes pass, a practice-session INSERT must start at `status = 'pending'`, and DELETE is limited to a still-pending row so it covers only the rollback it exists for.

**How to test the fix** A pglite RLS test in the `security-audit-2026-09.rls.test.ts` style: as `authenticated` with `auth.uid()` set, an INSERT into `applications` must be refused by RLS, and a DELETE of an application whose plan is past `pending_acceptance` must be refused by the trigger.

---

### A-18 — Residual hardening notes

Not findings on their own; recorded because each one narrows the blast radius of something above.

- **CSP is `Report-Only`** (`next.config.ts:60`). The reasoning is documented and correct — three third parties inject script and their origin sets are unverified. But the Supabase auth cookie is `httpOnly:false` with a 400-day refresh token, so an XSS here steals a refresh token, and the absolute session cap is the only bound. Collect a week of violation reports and enforce it. The `'unsafe-inline'`/`'unsafe-eval'` in `script-src` should go with the nonce plumbing afterwards.
- **The till device secret lives in `localStorage`** (`app/practice/pos/tillStorage.ts`). It is a bearer credential for issuing bills. Any XSS on a practice page — see the previous point — hands it over. An `httpOnly` cookie scoped to `/practice/pos` would be strictly better and no harder.
- **No rate limit** on `selfSettleInstalment`, `selfSettleEntirePlan`, `issueCounterSession`, `runCreditCheck`, `acceptPlan`, `payWithSavedCard`, or `unlockTill` (which caps PIN attempts per device but has no global bucket). Each is authenticated, so the exposure is bounded — but `issueCounterSession` mints bills and `selfSettle*` starts real charges.
- **The rate limiter fails open** by design, and the previous audit explains why. Worth revisiting for `identity_session` specifically: that bucket exists because each call spends money at a vendor, and "fail open" there means "the vendor bill is unbounded whenever the database blips". A local per-instance fallback counter would keep it from being unbounded without making it able to take the action down.
- **`practices` DELETE for owners** (`0004`) and **`plans`/`applications` DELETE for practice members** (`0006`) are broader than the rollback they exist for. `protect_plans_write` correctly limits plan deletion to `pending_acceptance`; `applications` has no equivalent trigger, so a practice member can delete application rows at any lifecycle stage. Add the same guard.
- **`payouts` is readable by any active practice member** (`0092`), including `staff`. If the payout row ever carries a banking snapshot, that widens. `scripts/check-payout-snapshot-exposure.ts` exists — run it as a test, not a script.
- **`profiles` allow-list**: `phone` is user-writable (0122), which is what lets a caller stage a value that `prepare_phone_verification_for_user`'s guard will then accept. Once A-01/A-06 are fixed this is harmless; until then it is part of the chain.

---

## 4. What I checked and found sound

Recorded so the next audit does not re-derive it, and so the fixes above are not mistaken for a general verdict.

- **Cron authentication.** All three routes use `Bearer CRON_SECRET` with `crypto.timingSafeEqual` and a length pre-check, refuse to run when the secret is unset, and gate on a constant rather than an env toggle. Correct.
- **Peach webhook signature.** `${timestamp}.${webhookId}.${url}.${body}` HMAC-SHA256, hex-decoded both sides, length-checked, `timingSafeEqual`. 300-second freshness window. `x-webhook-id` recorded in `peach_webhook_events` *after* the handlers, which is the ordering that avoids re-creating F-13. The URL comes from env, not from forwarded headers. I could not forge or replay it.
- **Amount verification** (F-09a). `verifySettledAmount` runs before every state flip on both the instalment and settlement paths, in integer cents, against `chargeAmountCents(payment.amount, dunning_fees_cents)` — the figure actually charged, not a re-derivation. Over-capture accepted deliberately; under-capture refused and logged with an alertable prefix.
- **Google Pub/Sub verification.** `lib/gmail/oidcVerify.ts` checks `alg`, `kid`, issuer, audience, email and expiry, then verifies RS256 against the live JWKS with a 1-hour cache. No `alg: none`, no `kid` confusion. Correct.
- **The 0121 / 0122 locks.** `protect_plans_write`, `protect_payments_write` and `protect_profiles_columns` do what they claim. The bypass predicate is `auth.role() = 'service_role' OR current_setting('app.privileged_write')`, and I found no `SECURITY DEFINER` function that sets that GUC — so it is unreachable from a session. `to_jsonb(NEW) <> to_jsonb(OLD)` comparison means a column added tomorrow is locked by default.
- **Card RPCs.** `change_default_card`, `set_default_card_flag` and `archive_card` all derive the patient from `auth.uid()` and scope every statement on it. Correct. (`refresh_card_token` does not, but is service-role in practice — see A-02.)
- **`claim_plan_for_settlement`.** Genuinely atomic: snapshot, multi-row claim, row-count check, clean revert on a partial claim. Revoked from `PUBLIC`. This is the model the A-04 fix should follow.
- **Payout idempotency.** `payouts` is `UNIQUE(plan_id)` (0087) and `activateFirstInstalment` upserts with `ignoreDuplicates`. Amounts derive from `plans.total_amount` and the practice's `fee_percent`, server-side, never from a request.
- **Brand-portal authorisation.** `guardBrandAdmin` / `guardBrandAdminOfPractice` read authority through the caller's own client and resolve the practice→group edge through service-role, so a `groupId` from a URL cannot widen scope. `practice_group_members` has no non-admin INSERT policy. All 12 brand actions guard before they write.
- **Admin RBAC.** All 21 admin surfaces and both CRM guards check `profiles.role` server-side through the session client before any write. No client-supplied role is trusted anywhere.
- **Bill-creation authorisation.** `practiceId` is a scope selector re-verified against `practice_members`; `providerMemberId` is re-verified for practice, active and `role='provider'`; the trading gate is checked in code *and* in RLS (`practice_can_trade`).
- **POS/till.** Device secret is 256-bit random, hashed with a pepper at rest; the practice PIN is salted scrypt with a legacy-format fallback; five attempts then a 15-minute lockout per device; idle timeout of 5 minutes plus a same-UTC-day check; every session action re-verifies that the session's practice matches the device's.
- **SA ID handling.** AES-256-GCM at rest with a separate HMAC blind index for lookup (`sa_id_lookup_hash`), unique-indexed (0097) so one ID cannot open two accounts. Masked in every practice-facing surface. Never logged.
- **SQL injection.** None. Every query goes through PostgREST's builder or a parameterised RPC. No string concatenation into SQL anywhere, including the CRM's search paths.
- **Command injection / deserialisation.** No `child_process`, no `eval`, no `new Function`, no `vm`. Nothing deserialises untrusted input except `JSON.parse` on webhook bodies.
- **File upload.** No object storage, no upload endpoint. The only attacker-supplied file is the CRM's CSV/XLSX, parsed in memory with a size cap.
- **CORS.** No `Access-Control-Allow-Origin` anywhere. Nothing is cross-origin readable.
- **Own cookies.** Both application cookies are `httpOnly`, `sameSite=lax`, `secure` in production, path-scoped, with bounded `maxAge`. Pinned by `app/cookie-posture.test.ts`.
- **Secrets.** Only eight `NEXT_PUBLIC_` variables, all intentionally public. No service-role key, pepper or encryption key in any client component. `.env*` gitignored; a scan of all 72 commits and 2,490 objects for JWT, AWS, Google and PEM key patterns found nothing but a test fixture.
- **Session management.** The absolute session cap in `proxy.ts` is enforced server-side, revokes globally before redirecting, and clears cookie names collected from both the original and the refreshed request (so a chunk-count change cannot leave a half-deleted chunked cookie). This is the layer that bounds the 400-day cookie, and it is done carefully.
- **The finance engine.** `lib/finance.ts` is pure, works in integer cents, and is tested against known answers. Rounding remainder lands on instalment 1 so the sum is exact.

---

## 5. Attack chains

Ranked by expected loss — likelihood × impact — rather than by CVSS.

### Chain 1 — Merchant-side account takeover and identity harvesting

`A-01` (self-issue the phone OTP) → `A-03` (`reuse` → password reset + session) → the patient portal.

| | |
|---|---|
| **Likelihood** | **High.** No exotic capability: an unlocked till or biller access, an SA ID number the practice already holds, and an email address. Two `fetch` calls replace the SMS. |
| **Financial impact** | Medium — indirect. The taken-over account can settle, cancel and re-plan; the direct loss is smaller than Chain 2's. |
| **Data/privacy impact** | **Severe.** Full plan history, masked SA ID, saved cards, contact details, and a silent rewrite of the victim's name and phone. Special personal information under POPIA, reportable. |
| **Ease** | **Easy.** All server-side; no timing, no race, no crypto. |
| **Privileges needed** | Practice staff, or anyone who can photograph a QR off a reception screen and learn one email address. |
| **Detectability** | **Very low.** Every action after the takeover looks like the victim's own. The password reset sends no notification. There is no `admin_audit_log` entry (A-12) and no `plan_events` entry for a session mint. |

### Chain 2 — Synthetic-identity credit extraction

`A-05` (no KYC on the checkout door, R50,000 first-bill ceiling) → `A-01` (phone OTP for a number the operator controls) → `A-04` (concurrency multiplies whatever limit does apply).

| | |
|---|---|
| **Likelihood** | **High** once the product is live and a single practice cooperates. This is the standard BNPL fraud shape and South African ID datasets are widely traded. |
| **Financial impact** | **Severe.** R47,000 of HNPL capital per identity, against a receivable that is unenforceable because the signature is not the ID holder's. Total loss, not a recovery problem. |
| **Data/privacy impact** | High — a stranger acquires a credit file and a default. |
| **Ease** | **Easy.** No technical exploitation at all for the core of it; A-01 and A-04 only raise the throughput. |
| **Privileges needed** | A cooperating practice, or the ability to walk in and ask for a bill. |
| **Detectability** | **Low at first.** It looks like ordinary business until the second instalments fail, six weeks later, in a cohort. Nothing correlates accounts by device, IP, card fingerprint or payment method today. |

### Chain 3 — Credit-limit multiplication by an ordinary customer

`A-04` alone.

| | |
|---|---|
| **Likelihood** | **Medium-high.** No insider needed. It will also happen by accident — a customer double-submitting on a flaky connection produces the same interleaving. |
| **Financial impact** | **High.** N× the approved limit per customer, with the payout irreversible and the instalments not. |
| **Data/privacy impact** | None. |
| **Ease** | **Trivial.** Two tabs, two clicks. |
| **Privileges needed** | An ordinary customer with two open bills. |
| **Detectability** | **Low.** Every request is well-formed and legitimate; only a reconciliation report comparing exposure to limits would show it, and none exists. |

### Chain 4 — Sales-side data exfiltration

`A-09` (unscoped CRM child tables) → optionally `A-16` (`xlsx` prototype pollution from the import path) → optionally `A-08` (signature XSS against an admin view).

| | |
|---|---|
| **Likelihood** | **Medium.** Departing sales reps taking the book is the most common form of this in any company; here it is one HTTP request. |
| **Financial impact** | Low direct, high commercial. |
| **Data/privacy impact** | **High.** Every practitioner lead's name, direct email, cellphone and HPCSA number, plus every call note. |
| **Ease** | **Trivial** for the exfiltration; the escalation legs are harder. |
| **Privileges needed** | A `sales` account. |
| **Detectability** | **Low.** It is an ordinary authenticated read. `crm_audit_log` records writes, not reads. |

### Chain 5 — Targeted denial of a competitor's or victim's onboarding

`A-11` (spend their rate-limit budget) + `A-06` (burn their OTP attempts) + `A-02` (expire their checkout session).

| | |
|---|---|
| **Likelihood** | **Low.** Needs a motive to harass a specific person. |
| **Financial impact** | Low — a lost sale per victim. |
| **Data/privacy impact** | Low, except the phone-number oracle in A-06. |
| **Ease** | Easy, given a user id or a token. |
| **Privileges needed** | Any account, or none. |
| **Detectability** | **Very low** — indistinguishable from the victim exhausting their own limits, which is exactly what support would conclude. |

---

## 6. Security scorecard

Scored 0–10, where 10 is "I tried hard and could not find a way in".

| Area | Score | Why |
|---|---:|---|
| **Authentication** | **3** | Session handling, the absolute cap, passkeys and the logout revoke are all done well. The phone OTP is not an OTP (A-01), and the checkout door resets other people's passwords (A-03). Those two dominate. MFA for admin/sales is still open from the last audit. |
| **Authorization** | **6** | Admin RBAC, brand scoping and bill-creation authorisation are consistently correct — the guards are there and they use the session client. Pulled down by four `SECURITY DEFINER` functions that take an identifier and never check it (A-06, A-07, and `refresh_card_token`), and by A-02 making them reachable. |
| **API security** | **6** | No client-supplied `amount`, `status`, `role` or `patient_id` is ever trusted; mass assignment is closed by 0122; validation is server-side and shared with the client. Lost points for the caller-supplied `p_code_hash` and `email` that decide who gets a session. |
| **Business logic** | **3** | The lifecycle state machine is carefully built and the preconditions are real. But the credit limit multiplies under concurrency (A-04), the checkout door skips the gates the in-app door enforces (A-05), and a transport error can freeze a balance forever (A-13). |
| **Payment security** | **8** | The strongest area. Amounts server-derived, HMAC verified with freshness, replay ledger, atomic claims, payout unique on `plan_id`, settlement snapshot-and-revert. A-13's stuck-`processing` gap is the one hole. |
| **KYC security** | **3** | Didit and DHA integration is properly built, the webhook is signature-verified and idempotent, and SA IDs are encrypted with a separate blind index. None of that is enforced on the door that actually creates plans (A-05), and the phone check that door does enforce is bypassable (A-01). |
| **Database security** | **6** | RLS on all 38 tables, no SQL injection, good use of triggers for column locks, unique constraints where they matter. Undermined by the `PUBLIC` execute default (A-02), the unscoped CRM child policies (A-09), and the absence of any database-level invariant on total credit exposure. |
| **Input validation** | **8** | Shared validators, SA ID checksum and age, phone normalisation, allow-listed salary days and plan types, bill-amount bounds, SA coordinate bounds on tampered map payloads. Good. |
| **Rate limiting** | **4** | Migration 0124's atomic `consume_rate_limit` is the right design and the limits are sized against real behaviour. But the RPC is `anon`-executable with caller-supplied parameters (A-11), it fails open including on the paid KYC bucket, and the money-moving actions have no limit at all. |
| **Bot protection** | **2** | No CAPTCHA, no proof-of-work, no device fingerprinting, no velocity checks, no correlation of accounts by device, IP, card fingerprint or payment method anywhere. SMS cost was the one natural throttle on the signup chain, and A-01 removes it. |
| **Secrets management** | **9** | Only intended values under `NEXT_PUBLIC_`; server keys never imported into a client component; the Google key split is documented and correct; SA-ID encryption and lookup keys are separate; nothing in git history. |
| **Infrastructure** | **7** | Six enforcing security headers, HSTS with preload, correct `Permissions-Policy`, no CORS, cron secrets, PWA surfaces excluded from the auth proxy. CSP still `Report-Only`, and the till secret is in `localStorage`. |
| **Logging / monitoring** | **3** | Consistent `ALERT` prefixes, `cron_runs` for job liveness, `plan_events` for the customer-visible lifecycle. But the money-moving admin actions are unrecorded (A-12), nothing detects repeated failed logins or OTP attacks, nothing correlates multiple accounts to one identity or card, and no alert exists for a stuck `processing` row or an exposure-over-limit condition. |
| **Admin security** | **4** | RBAC is correct and consistently applied, and that is genuinely most of the work. No MFA (open since the last audit), no re-authentication for settlement or role grants, and no audit trail on either (A-12). One compromised admin session is unlogged and unconstrained. |

---

## 7. Prioritised remediation plan

### Fix immediately — before any further real ID numbers or money

These are the ones with a working exploit and a loss attached.

1. **A-01 — revoke the phone-OTP RPCs from `anon`/`authenticated`/`PUBLIC`, and stop taking the hash as a parameter.** A two-line migration closes the reachability today; the signature change is the proper fix and can follow. *Effort: hours for the revoke, a day for the redesign.*
2. **A-02 — `REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC`, re-grant the ten the browser needs, and set `ALTER DEFAULT PRIVILEGES`.** Do this second, because A-01's revoke is not effective without it. Verify in staging with the existing `.rls.test.ts` suite before pushing — a mistake here breaks every read at once. *Effort: a day including verification.*
3. **A-03 — refuse `reuse` for a confirmed account; never `updateUserById({password})` on an account this flow did not create; gate the profile upsert on `isNewUser`.** *Effort: a day.*
4. **A-04 — move check-and-commit into one atomic RPC with `SELECT … FOR UPDATE` on the profile, and add the deferred constraint trigger.** `claim_plan_for_settlement` is the template. *Effort: two to three days including the pglite concurrency test.*
5. **A-05 — set an explicit first-plan limit, and gate `payouts` creation on verified identity.** The payout gate is the higher-value half: it puts the KYC requirement where HNPL's capital actually leaves. *Effort: two days, plus a product decision on the counter experience.*
6. **A-06 — bind `p_user_id` to `auth.uid()` in both `*_for_user` RPCs.** Ships with A-01. *Effort: an hour.*

### Fix before launch

7. **A-09 — owner-scope the CRM child tables.** One helper function, seven policy rewrites. *Effort: a day.*
8. **A-11 — revoke `consume_rate_limit` from `anon`/`authenticated`, clamp its parameters, prune hourly.** Ships with A-02. *Effort: hours.*
9. **A-12 — audit-log every state-changing admin action**, and add an admin screen that shows the log. Trigger-based for banking details. *Effort: two days.*
10. **A-13 — handle the transport-error branch, and add the stuck-`processing` sweep to the daily cron with an alert.** *Effort: a day.*
11. **A-07 — membership check in `accept_practice_invitation`, or move it behind the service-role client.** *Effort: hours.*
12. **A-08 — replace `sanitizeSignatureHtml` with a parser-based allow-list.** *Effort: half a day.*
13. **F-16 (still open) — MFA for `admin` and `sales`, and step-up re-authentication on settlement, role grants and banking changes.** A Supabase project setting plus the step-up wiring. With A-12 unfixed, an admin compromise is currently both unconstrained and invisible. *Effort: a day once MFA is enabled.*
14. **F-18 (still open) — confirm the deployed project has email confirmation ON and that practice approval is a real human step.** *Effort: a dashboard check.*
15. **A-10 — mirror the ownership predicate into the `crm_leads` UPDATE `WITH CHECK`.** *Effort: minutes.*
16. **A-14 — bind terms acceptance to a server-issued token and record the document hash.** Legal, not technical, but launch-blocking for an NCA product. *Effort: half a day.*
17. **Bot and velocity controls (scorecard: 2/10).** The single highest-leverage addition: correlate accounts by device fingerprint, IP, card fingerprint and payment method, and alert on clusters. Chain 2 is undetectable today precisely because nothing does this. Also add rate limits to `issueCounterSession`, `selfSettle*`, `acceptPlan`, `payWithSavedCard` and `runCreditCheck`. *Effort: a week, and worth it.*
18. **Replace `stubAffordabilityPolicy`.** Still the open item it has always been. Every limit-enforcement fix above enforces a stub until this lands; enforcing a stub correctly is progress, not underwriting.

### Improve after launch

19. **A-15 — gate the unsigned webhook probe behind an env flag, cap the logged body, then delete the branch** once Peach signing is confirmed live.
20. **A-16 — four `pnpm-workspace.yaml` overrides for the dev-only advisories**, so the audit output stays legible. Decide separately on `xlsx`: CDN pin, or swap the read path to `exceljs`.
21. **Enforce the CSP.** Collect a week of `Report-Only` violations, fold in the real Peach/Google/Didit origins, move the header key, then remove `'unsafe-inline'` with nonce plumbing.
22. **Move the till device secret from `localStorage` to an `httpOnly` cookie** scoped to `/practice/pos`.
23. **A-17 — drop `patients_insert_own_applications` and add a `protect_applications_write` trigger**, so the DELETE guard matches `protect_plans_write`'s.
24. **Reconsider the `identity_session` fail-open.** A per-instance fallback counter keeps the vendor bill bounded without letting the limiter take the action down.
25. **Detection rules** for repeated failed logins, OTP attempt bursts, refund and settlement velocity, exposure-over-limit, and stale `processing` rows. Several of these are single SQL queries against tables that already exist.

---

## 8. Proof-of-concept tests added

Three files, 20 assertions, all passing. They are written as **proofs**, not guards — each one asserts that the exploit currently works, with a header explaining which assertion to invert once the fix lands.

| File | Proves | Assertions |
|---|---|---|
| `supabase/migrations/security-audit-2026-09-02-otp-rpc.rpc.test.ts` | A-01, A-06, A-02 — real migrations, real Postgres (pglite), real `anon`/`authenticated`/`service_role` roles | 8 |
| `lib/underwriting/creditLimit.race.adversarial.test.ts` | A-04 — drives the real `checkCreditLimit`; sequential refuses, concurrent admits, five concurrent give 5× | 4 |
| `lib/gmail/signature.sanitizer-bypass.adversarial.test.ts` | A-08 — five sanitizer bypasses | 6 |
| `app/checkout/[token]/session-mint-ato.adversarial.test.ts` | A-03 — the binding, the `reuse` decision and the four structural facts of the takeover | 10 |

```
pnpm test                       # 372 files, 6,586 tests, all green
npx vitest run supabase/migrations/security-audit-2026-09-02-otp-rpc.rpc.test.ts
npx vitest run lib/underwriting/creditLimit.race.adversarial.test.ts
npx vitest run lib/gmail/signature.sanitizer-bypass.adversarial.test.ts
npx vitest run "app/checkout/[token]/session-mint-ato.adversarial.test.ts"
```

No production code was changed.
