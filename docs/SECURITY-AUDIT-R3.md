# HNPL / betternow — adversarial security audit, round three

**Branch:** `claude/outstanding-migrations-9rm40y`
**Database state:** production project `wcwuqpyjiexkvnilceko`, migrations **0001–0134 applied** (0125–0134 were applied at the start of this session; before that the database was at 0124 while the repo carried the round-two fixes).
**Scope:** whole repository — `app/` (14 API routes, 24 Server Action modules), `lib/`, `components/`, 141 migrations, `proxy.ts`, `next.config.ts`, `vercel.json` — plus the **live** RLS policy set, trigger set and constraint set read directly from the production database.
**Method:** static review, live schema introspection, dependency audit, and **executable proof-of-concept tests** against real PostgreSQL (pglite) running as non-superuser `anon`/`authenticated`/`service_role` roles.
**Constraint honoured:** no production code changed. Nothing was written to the production database except the ten pending migrations the session was asked to apply. All exploit proofs run locally.
**Suite:** green before and after — 386 files / 7,052 tests, plus 9 new proof-of-concept assertions.

**Relationship to the earlier audits.** `SECURITY-AUDIT-2026-09.md` (F-01…F-19) and `SECURITY-AUDIT-2026-09-02.md` (A-01…A-18) were both re-verified. **Their fixes hold.** I could not reopen F-01, F-02, F-03, F-05, F-07, F-09, F-10, F-12, A-01, A-03, A-04, A-05, A-06, A-07, A-08 or A-17. `payments_plan_instalment_uniq` is present; the checkout door's password-reset/session-mint primitive is gone; the onboarding gate is enforced on both doors; `claim_credit_for_plan` is atomic under a row lock with a deferred exposure constraint behind it. **Every finding below is new.**

---

## 1. Executive summary

**Overall security level: HIGH RISK — two ordinary-user-to-money paths are open. Do not take real money on this build until R3-01 and R3-02 are closed.**

Both criticals require a session, but only the cheapest kind: R3-02 needs any authenticated account, R3-01 needs a patient account with one live bill on it. Neither needs a privileged role, an admin mistake, or a stolen credential.

The last two audits were thorough and the remediation was done properly. That is exactly why what is left has a shape: **rounds one and two closed the UPDATE surface, and left INSERT open on two tables.**

Look at the pattern. `protect_plans_write`, `protect_payments_write` and `protect_applications_write` all handle INSERT, UPDATE and DELETE. `protect_profiles_columns` is UPDATE-only — but `profiles` has had no INSERT policy since migration 0030, so there is no INSERT to guard. `protect_practices_columns` is also UPDATE-only, and `practices` **does** still have an open INSERT policy from migration 0002. `payouts` has an open INSERT policy from migration 0009 and no trigger at all. Those two tables are the whole of this report's critical section.

**Biggest financial risk — a patient writes their own payout row.** `payouts` carries a patient INSERT policy, has no write trigger, and `payouts.plan_id` is `UNIQUE`. The only legitimate creator inserts with `ON CONFLICT (plan_id) DO NOTHING`. So a patient who inserts the row first **wins**, and the real write silently no-ops. They choose `net_amount`, `practice_id`, `status` and the banking snapshot for a genuine payout on a genuine bill. Set `net_amount` to a cent and the practice is defrauded; set `practice_id` to a practice the attacker controls and the money is redirected; set `status='paid'` and the practice is never paid at all, while the books say it was (R3-01, proved).

**Biggest authorization risk — anyone can create an approved merchant.** Any authenticated user may `INSERT` into `practices` with `owner_id = self`. `protect_practices_columns` pins `status`, `fee_percent`, `approved_at` and `approved_by` — but it is a `BEFORE UPDATE` trigger, so at INSERT time `status='approved'` and `fee_percent=0` are simply accepted. The owner may then insert their own `practice_members` row with `role='provider'`, which satisfies `practice_can_trade()`. Two PostgREST calls produce a **fully approved, zero-fee, trading merchant that no admin ever saw**, with the attacker's bank account on it (R3-02, proved).

Chained, those two are the classic BNPL cash-out: stand up a merchant, raise a bill against a controlled patient account, take HNPL's 94% on first-instalment success, default on instalments 2 and 3. R3-01 alone lets the same attacker skim real practices' settlements.

**Biggest privacy risk is now modest.** Round two's A-09 fix (`crm_can_see_lead`) holds and the CRM child tables are owner-scoped. `profiles` is allow-listed, SA IDs are AES-256-GCM at rest with an HMAC blind index, and I found no IDOR in the admin, brand or practice surfaces — every one re-derives authority server-side. What remains is a **blind SSRF** through the push-subscription endpoint (R3-03), which is a server-side request primitive rather than a data exposure.

**Biggest authentication risk is no longer in the code.** A-01 and A-06 are closed and the OTP RPCs are service-role-only with caller binding. What is left is operational and was already known: **no admin MFA** and **email confirmation is a dashboard setting**, neither of which is a repository change.

**What I could not break.** SQL injection (none — everything is PostgREST builders or parameterised RPCs). Command injection, `eval`, deserialisation (none). The Peach HMAC and the Didit canonical-V2 HMAC, both with freshness windows and replay ledgers. Google Pub/Sub OIDC verification. Cron `Bearer` auth with `timingSafeEqual`. The Gmail OAuth `state` (cookie-bound *and* user-id-bound). Secrets partitioning — 11 `NEXT_PUBLIC_` names, all intentionally public; no service key, pepper or encryption key in any client component; no secret in the tree or in git history. The new `sanitizeHtmlAllowList` parser, which I attacked with the five round-two bypasses and several of my own and could not defeat.

---

## 2. Attack-surface inventory

### 2.1 HTTP routes (14)

| Route | Method | Auth | Role | State | Money | PII | Rate limit |
|---|---|---|---|---|---|---|---|
| `/api/auth/logout` | POST | session | any | ✓ | — | — | — |
| `/api/payment-methods/recent` | GET | session + confirmed email | patient | — | — | card meta | — |
| `/api/push/subscribe` | POST | session | any | ✓ | — | — | — |
| `/api/push/unsubscribe` | POST | session | any | ✓ | — | — | — |
| `/api/reverse-geocode` | GET | session | any | — | — | coords | in-memory, per-instance |
| `/api/payments/peach/webhook` | POST | HMAC + freshness + replay ledger | — | ✓ | ✓ | — | n/a |
| `/api/verification/didit/webhook` | POST | HMAC-V2 + freshness + event-id dedupe | — | ✓ | — | SA ID | n/a |
| `/api/crm/gmail/connect` | GET | session | sales/admin | ✓ | — | — | — |
| `/api/crm/gmail/callback` | GET | session + state cookie + uid bind | sales/admin | ✓ | — | — | — |
| `/api/crm/gmail/disconnect` | POST | session | sales/admin | ✓ | — | — | — |
| `/api/crm/gmail/push` | POST | Google OIDC (RS256, JWKS) | — | ✓ | — | — | n/a |
| `/api/cron/collect-instalments` | GET/POST | `Bearer CRON_SECRET` | — | ✓ | ✓ | — | n/a |
| `/api/cron/crm-reply-poll` | GET/POST | `Bearer CRON_SECRET` | — | ✓ | — | — | n/a |
| `/api/cron/payout-batches` | GET/POST | `Bearer CRON_SECRET` | — | ✓ | ✓ | — | n/a |

### 2.2 The surfaces that actually decide money

`acceptPlan`, `payWithSavedCard`, `selfSettleInstalment`, `selfSettleEntirePlan` (patient) · `initiateCheckout` (token, partly anon) · `createBill`, `issueCounterSession` (practice) · `approvePractice`, `changePracticeFeePercent`, `markPayoutPaid`, `markBatchPaid` (admin) · `collect-instalments`, `payout-batches` (cron).

All are rate-limited since round two, all re-derive authority server-side, and all money writes route through `claim_credit_for_plan` or a precondition-guarded service-role update. **The gap is not in these paths — it is that two tables they write to can also be written directly.**

### 2.3 Direct-to-PostgREST surface (what the browser can reach with the anon key)

This is the surface that matters, because the anon key is public by construction. Live policy set, with the two open INSERTs marked:

| Table | INSERT reachable by | Guarded by trigger? |
|---|---|---|
| `plans` | practice member of a trading practice | ✓ `protect_plans_write` (INS/UPD/DEL) |
| `payments` | — (no user INSERT policy) | ✓ `protect_payments_write` |
| `applications` | practice member of a trading practice | ✓ `protect_applications_write` (0128) |
| `profiles` | — (policy dropped in 0030) | UPDATE-only lock, sufficient |
| **`payouts`** | **any patient, for their own plan** | **✗ none — R3-01** |
| **`practices`** | **any authenticated user** | **✗ UPDATE-only — R3-02** |
| `practice_members` | practice owner / manager | ✗ none (bounded by R3-02's fix) |

---

## 3. Findings

### R3-01 — A patient can forge the payout row for their own plan

**Severity: Critical**

**Location:**
- `supabase/migrations/0009_payout_on_accept.sql:8` — the `patients_insert_payout_on_accept` policy
- `lib/payments/activateFirstInstalment.ts:118` (existence fast-path), `:207` (the `ON CONFLICT DO NOTHING` upsert)
- `lib/payments/runPayoutBatches.ts:138-142` — the batch runner's source query
- `supabase/migrations/0087_payouts_plan_id_unique.sql` — the `UNIQUE (plan_id)` that makes it stick

**What is wrong.** Four correct-looking decisions combine into a hole:

1. Migration 0009 grants patients `INSERT` on `payouts` with `WITH CHECK (EXISTS (SELECT 1 FROM plans WHERE plans.id = payouts.plan_id AND plans.patient_id = auth.uid()))`. The check constrains **`plan_id` and nothing else** — `net_amount`, `practice_id`, `status`, `payout_destination`, `provider_id`, `batch_id`, `created_at` and all five `snapshot_*` banking columns are free.
2. `payouts` has **no `BEFORE INSERT` trigger**. It is the only money table without one. (Its only trigger is `trg_log_payout_settlement`, `AFTER UPDATE`.)
3. `payouts.plan_id` is `UNIQUE` (0087).
4. The one legitimate creator upserts with `ignoreDuplicates: true` → `ON CONFLICT (plan_id) DO NOTHING`, and short-circuits earlier still on an existence check at line 118.

Points 3 and 4 exist to make concurrent activation idempotent, and for that they are right. Against point 1 they invert: **whoever inserts first wins, and the system is built so the legitimate write is the one that yields.**

`activateFirstInstalment.ts:16` states the invariant in as many words — *"Nothing else may create payouts rows; payouts.plan_id is UNIQUE (0087) and this helper is its only creator."* The RLS policy has contradicted that comment since migration 0009.

**How an attacker exploits it.** The patient needs only a live bill against them — the normal state of any customer. They hold the anon key (it is in the JS bundle by design) and their own session JWT.

```http
POST /rest/v1/payouts
apikey: <anon key>
Authorization: Bearer <the patient's own session JWT>
Content-Type: application/json

{ "plan_id":     "<their own plan>",
  "practice_id": "<a practice the attacker owns — see R3-02>",
  "gross_amount": 10000, "fee_amount": 9999.99, "net_amount": 0.01,
  "status": "pending",
  "snapshot_bank_name": "Capitec",
  "snapshot_account_number": "<attacker's account>" }
```

Then they pay instalment 1 normally. `activateFirstInstalment` finds a row at line 118 and returns `{ ok: true }` without writing. The forged row is the payout of record.

**Example attack scenario.** A patient takes a real R10,000 treatment at a real dental practice.

- *Variant A — defraud the practice.* Insert with `net_amount = 0.01`. The weekly runner sums `net_amount` per practice and creates the batch. The practice is paid one cent for a R10,000 treatment already delivered. The patient's plan is genuine, so nothing looks anomalous on the customer side.
- *Variant B — redirect the settlement.* Insert with `practice_id` pointing at the attacker's own practice (R3-02 supplies one in two calls). `batchOnePractice` groups strictly by `practice_id` and **never checks practice status**, so the R9,400 is batched to the attacker's practice and its bank account.
- *Variant C — silent non-payment.* Insert with `status='paid'` and `paid_at=now()`. The runner's `.eq('status','pending')` filter excludes it forever. The practice is never paid, the reconciliation view says it was, and `trg_log_payout_settlement` (AFTER UPDATE) never fires because there was no update.

**Impact.** Direct financial loss on every plan the attacker holds, bounded only by how many bills they can get raised against them. Corruption of settlement records for real practices. Attacker-controlled banking data in `payouts.snapshot_*`, which is what reconciliation reads. Because the forged row is created *before* the legitimate path runs, there is no error, no log line, and no audit entry anywhere.

**Recommended fix.** Two lines, and the first one alone closes it:

```sql
-- 1. The policy is dead code. Every payouts INSERT in the tree
--    (lib/payments/activateFirstInstalment.ts:207) runs on the
--    service-role client. Nothing legitimate uses this.
DROP POLICY IF EXISTS "patients_insert_payout_on_accept" ON payouts;

-- 2. Defence in depth, matching every other money table.
CREATE OR REPLACE FUNCTION protect_payouts_write() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF hnpl_write_is_privileged() IS TRUE THEN RETURN COALESCE(NEW, OLD); END IF;
  RAISE EXCEPTION
    'payouts rows are written only by activateFirstInstalment and the payout '
    'runner, on the privileged client (audit R3-01)';
END; $$;

DROP TRIGGER IF EXISTS trg_protect_payouts_write ON payouts;
CREATE TRIGGER trg_protect_payouts_write
  BEFORE INSERT OR UPDATE OR DELETE ON payouts
  FOR EACH ROW EXECUTE FUNCTION protect_payouts_write();
```

I verified the policy is unused: the only `.insert`/`.upsert` against `payouts` anywhere in `app/` or `lib/` is `activateFirstInstalment.ts:207`, on a service-role client. Dropping it changes no legitimate behaviour.

**How to test the fix.** Invert the four assertions in `supabase/migrations/security-audit-r3-payouts-practices.rls.test.ts` (`describe('R3-01 …')`) from "the insert succeeds" to `.rejects.toThrow(/row-level security|not writable/)`. That file already sets up a real `authenticated` role against real policies, so the inversion is a two-word change per assertion.

---

### R3-02 — Any authenticated user can create a fully approved, trading practice

**Severity: Critical**

**Location:**
- `supabase/migrations/0002_rls_policies.sql:101` — `authenticated_insert_practice`
- `supabase/migrations/0054_protect_owner_writable_columns.sql` — `protect_practices_columns`, created `BEFORE UPDATE` only
- `supabase/migrations/0003_practice_owner_insert_member.sql:11` — `owners_insert_own_membership`
- `app/practice/setup/page.tsx:111` — the one legitimate user-client `practice_members` insert

**What is wrong.** `authenticated_insert_practice` is `WITH CHECK ((auth.uid() IS NOT NULL) AND (owner_id = auth.uid()))`. Every other column is free. The trigger that pins the sensitive ones —

```sql
CREATE TRIGGER trg_protect_practices_columns
  BEFORE UPDATE ON practices   -- UPDATE only
```

— never fires on INSERT. And `practices_status_check` permits `'approved'`, because it must: that is the value the admin approval flow writes. So the attacker simply supplies it at creation.

`practice_can_trade()` — the RLS gate on raising bills — is:

```sql
SELECT EXISTS (SELECT 1 FROM practices WHERE id = p AND status = 'approved')
   AND EXISTS (SELECT 1 FROM practice_members
                WHERE practice_id = p AND active AND role = 'provider');
```

The second half is satisfied by `owners_insert_own_membership`, whose `WITH CHECK` only asks that the caller owns the practice — `role`, `active`, `can_create_bills` and `can_manage_practice` are all free, and `practice_members_role_check` permits `'provider'`.

`practices.group_id` is `NOT NULL` and `practice_groups` has no non-admin INSERT policy, which looks like it should block this. It does not: `patients_select_practice_for_own_plans` lets any billed patient read the full `practices` row of the practice that billed them, **including `group_id`**. One `SELECT` supplies the missing value.

**How an attacker exploits it.** Three PostgREST calls from a patient account with any bill on it:

```http
# 1. Harvest a usable group_id from the practice that billed you
GET /rest/v1/practices?id=eq.<the practice that billed me>&select=group_id

# 2. Create a practice that is already approved, at zero fee
POST /rest/v1/practices
{ "owner_id": "<self>", "name": "Totally Legit Dental", "specialty": "Dentist",
  "email": "evil@x.co", "group_id": "<harvested>",
  "status": "approved", "fee_percent": 0,
  "approved_at": "2026-09-01T00:00:00Z", "approved_by": "<self>",
  "bank_name": "Capitec", "bank_account_number": "<attacker's account>",
  "branch_code": "470010", "account_holder": "A Patient", "account_type": "savings" }

# 3. Make yourself an active provider on it
POST /rest/v1/practice_members
{ "practice_id": "<new>", "user_id": "<self>", "role": "provider",
  "active": true, "can_create_bills": true, "can_manage_practice": true }
```

`practice_can_trade()` now returns `true`. The practice can insert `plans` and `applications` through RLS, and it holds the attacker's bank account at a 0% platform fee.

**Example attack scenario — the full cash-out chain.**

1. Attacker signs up as a patient, completes KYC once with a genuine identity (or a synthetic one — see the standing bot-protection gap).
2. Steps 1–3 above: a self-approved merchant exists, invisible to the admin approval queue because it never entered it.
3. Attacker raises a R49,999 bill from that merchant against a second controlled patient account.
4. That account accepts. The credit limit binds only the *financed* portion, so the split is honoured — but the plan activates on first-instalment success.
5. `activateFirstInstalment` creates a payout for 100% of the total (`fee_percent = 0`) to the attacker's bank account.
6. Instalments 2 and 3 default. HNPL has paid out and cannot recover.

R3-01 makes step 5 unnecessary — the payout row can simply be forged with any `net_amount` — so the two findings are independently sufficient and jointly worse.

**Impact.** Complete bypass of merchant onboarding, KYB and admin approval. Direct financial loss per fraudulent plan, at 100% of bill value if `fee_percent` is set to 0. The forged practice also lands inside a real practice group, so it appears in that group's brand-admin surfaces (`is_brand_admin_of_practice`) — a real brand admin sees a branch they never created.

**Recommended fix.** Give the trigger an INSERT branch, and drop the policy:

```sql
-- 1. Pin the admin-owned columns at INSERT, not just at UPDATE.
CREATE OR REPLACE FUNCTION protect_practices_columns() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF hnpl_write_is_privileged() IS TRUE THEN RETURN NEW; END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status IS DISTINCT FROM 'pending'
       OR NEW.approved_at IS NOT NULL
       OR NEW.approved_by IS NOT NULL THEN
      RAISE EXCEPTION
        'a practice created from a user session starts at pending and '
        'unapproved — approval is an admin action (audit R3-02)';
    END IF;
    -- fee_percent is the platform's margin, never the applicant's choice.
    NEW.fee_percent := DEFAULT;
    RETURN NEW;
  END IF;

  -- ... existing UPDATE branch unchanged ...
END; $$;

DROP TRIGGER IF EXISTS trg_protect_practices_columns ON practices;
CREATE TRIGGER trg_protect_practices_columns
  BEFORE INSERT OR UPDATE ON practices
  FOR EACH ROW EXECUTE FUNCTION protect_practices_columns();

-- 2. The policy is also dead: app/signup/practice/actions.ts:282 and
--    app/brand/actions.ts both insert practices on the SERVICE-ROLE client.
DROP POLICY IF EXISTS "authenticated_insert_practice" ON practices;
```

Note `NEW.fee_percent := DEFAULT` is not valid plpgsql — use `NEW.fee_percent := 6.00` or read the column default explicitly. Flagging it so it is not copied verbatim.

Separately, tighten `owners_insert_own_membership` to pin `role`/`active`/`can_*`, or drop it and move `app/practice/setup/page.tsx:111`'s self-heal onto the service-role client. With R3-02 closed it is no longer exploitable on its own, but it is the same shape of gap.

**How to test the fix.** Invert the five `describe('R3-02 …')` assertions in the PoC file. The decisive one is `practice_can_trade()` — it must return `false` for a practice created from a user session.

---

### R3-03 — Blind SSRF through the push-subscription endpoint

**Severity: Medium**

**Location:** `app/api/push/subscribe/route.ts` (accepts `body.endpoint` with no validation beyond presence) · `lib/notifications/sendPush.ts:164-170` (hands it to `webpush.sendNotification`)

**What is wrong.** The route stores whatever `endpoint` string an authenticated caller supplies. `web-push` later issues a server-side request to it. There is no allow-list of push-service hosts — no check for `fcm.googleapis.com`, `updates.push.services.mozilla.com`, `*.notify.windows.com` or `web.push.apple.com`, and no rejection of private address space.

Round one's F-12 fix hardened *ownership* of the row (an endpoint belonging to another account is refused with 409) and that part is correct. It never constrained the endpoint's **destination**.

**How an attacker exploits it.**

```http
POST /api/push/subscribe
{ "endpoint": "https://10.0.0.7:8443/internal/admin",
  "keys": { "p256dh": "<valid b64 P-256 point>", "auth": "<16 valid bytes>" } }
```

Then they trigger any notification against their own account — a payment collected, a plan activated, a dunning notice — and the server issues a POST to that address from inside its egress. `web-push` uses the `https` module, so the request is TLS-only; it is still an arbitrary outbound server-side request with an attacker-chosen host, port and path.

The 404/410 branch in `sendPush.ts:176` soft-deletes the row on those two status codes and leaves it otherwise. The attacker can read their own `push_subscriptions` row, so **`deleted_at` is a one-bit oracle** distinguishing "that host:port answered 404/410" from anything else — a slow but working internal port and path scanner.

**Impact.** Server-side request forgery from HNPL's egress IP: internal HTTPS service probing, a boolean oracle on internal endpoints, and use of the platform as an unattributed request relay against third parties. On Vercel's runtime there is no instance metadata service to reach, which is what keeps this Medium rather than High.

**Recommended fix.** Validate at write time, in `app/api/push/subscribe/route.ts`, before the row is stored:

```ts
const PUSH_HOSTS = [
  'fcm.googleapis.com', 'android.googleapis.com',
  'updates.push.services.mozilla.com',
  'web.push.apple.com',
];
function isAllowedPushEndpoint(raw: string): boolean {
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== 'https:') return false;
  if (u.port && u.port !== '443') return false;
  return PUSH_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`));
}
```

Reject with 400 when it fails. Apply the same check in `sendPush.ts` before sending, so rows already stored cannot fire.

**How to test the fix.** A unit test posting `http://169.254.169.254/`, `https://10.0.0.1/`, and `https://evil.example/` expecting 400, plus a real FCM-shaped endpoint expecting 200.

---

### R3-04 — Signature merge fields are applied *after* sanitisation, re-opening the URL check

**Severity: Low** (self-XSS only, because signatures are self-scoped)

**Location:** `lib/gmail/signature.ts:135-145` (`applySignatureMergeFields`) · `app/crm/settings/signatureActions.ts:125` · `app/crm/leads/[id]/composeEmail.ts:227` · rendered at `app/crm/settings/SignatureEditor.tsx:168` and `app/crm/leads/[id]/ComposeEmailSheet.tsx:372`

**What is wrong.** Both call sites are ordered `applySignatureMergeFields(sanitizeSignatureHtml(html), vars)` — substitution happens **after** the sanitiser has finished. `applySignatureMergeFields` escapes its values with `escapeHtml`, which handles `& < > " '` and therefore prevents attribute-breakout and tag injection. It does **not** neutralise a URL scheme, because in its intended context (text content) there is no scheme to neutralise.

A `{{email}}` placeholder inside an `href` changes that context. `sanitizeHtmlAllowList` sees `href="{{email}}"`, judges it a safe relative URL (no colon), and emits it. The merge then substitutes a value the sanitiser never inspected:

```
override:  <a href="{{email}}">click</a>
email var: javascript:alert(document.cookie)
output:    <a href="javascript:alert(document.cookie)" rel="noopener noreferrer">click</a>
```

The `isSafeUrl` check — the whole point of round two's A-08 rewrite — is bypassed, not by defeating the parser but by writing into the string after it ran.

**Why this is Low.** `crm_signatures` is self-scoped by RLS (`crm_signatures_self_select/insert/update/delete`, migration 0072:111-133), `loadMySignature` and `previewMySignature` are `user_id = g.userId`, and `buildSignatureForUser` is called with the sender's own id. The attacker and the victim are the same person. The outbound-email path carries the same bypass to external recipients, but mail clients do not execute `javascript:` hrefs.

It is still worth fixing: it is a control that was deliberately built and is silently not applying, and one future change — an admin-managed shared signature, a template library, a "preview this rep's signature" screen — turns it into stored XSS against staff.

**Recommended fix.** Merge first, then sanitise, so every byte reaching the output has been through the parser:

```ts
const html = sanitizeSignatureHtml(applySignatureMergeFields(override, vars));
```

`escapeHtml` inside `applySignatureMergeFields` should stay — it keeps a value from being *parsed* as markup — and the sanitiser then validates the resulting URLs. Apply at both call sites.

**How to test the fix.** Assert that an override of `<a href="{{email}}">x</a>` with `email = 'javascript:alert(1)'` produces an `<a>` with no `href`. Add it to `lib/gmail/signature.sanitizer-bypass.adversarial.test.ts`, which already owns this class.

---

### R3-05 — The Report-Only CSP has no reporting endpoint

**Severity: Low**

**Location:** `next.config.ts:39-62` (the `CSP_REPORT_ONLY` directive list) and `:64`

**What is wrong.** The policy is served as `Content-Security-Policy-Report-Only` and the header comment lays out the plan: *"run Report-Only in production for a week, collect the violations, fold the real origins into the directives below, then move the value to the `Content-Security-Policy` key."*

The directive list contains no `report-uri` and no `report-to`, and there is no reporting group header. A Report-Only policy with no reporting destination emits violations to each visitor's browser console and nowhere else. **The week of collection cannot happen**, so the documented path to enforcement is blocked by an omission in the policy itself — and A-18 has already carried this forward once as "collect a week of violation reports and enforce it".

This matters more here than it usually would, and the file says why: `@supabase/ssr` writes the auth cookie with `httpOnly: false` and a 400-day refresh token, so an XSS steals a refresh token rather than a one-hour access token. CSP is the layer meant to stop the payload landing.

**Recommended fix.** Add a collection endpoint and point the policy at it:

```ts
"report-uri /api/csp-report",
"report-to csp-endpoint",
```

plus a `Reporting-Endpoints: csp-endpoint="/api/csp-report"` header and a small route that rate-limits, caps body size, and logs `blocked-uri` / `violated-directive` / `document-uri` only. Then do the week, fold in the real origins, and flip the header key. The `'unsafe-inline'` / `'unsafe-eval'` removal needs Next's nonce plumbing and is a separate change — it should not hold up enforcement of the other directives.

**How to test the fix.** Assert in `app/security-headers.test.ts` (or wherever the header set is pinned) that the Report-Only value contains `report-uri`, and that the route returns 204 for a well-formed report and 400 for an oversized body.

---

### R3-06 — The bill-amount band is enforced only in application code

**Severity: Low** (defence in depth)

**Location:** `lib/config/billAmountLimits.ts` (`isAllowedBillAmount`, `MIN_BILL_AMOUNT`, `MAX_BILL_AMOUNT`) · used in `app/practice/bills/new/actions.ts` and `app/practice/pos/actions.ts` · no corresponding DB constraint on `plans.total_amount`

**What is wrong.** `plans` has exactly two CHECK constraints (`plans_status_check`, `plans_payment_provider_check`) and none on `total_amount` — no positivity, no ceiling. `protect_plans_write` pins `status` and the acceptance columns at INSERT but does not look at the amount. So a practice member of a trading practice who posts directly to PostgREST, rather than through `createBill`, is bounded by nothing:

```http
POST /rest/v1/plans
{ "patient_id": "<any patient>", "practice_id": "<their practice>",
  "total_amount": 100000000, "status": "pending_acceptance" }
```

The limits are also published as `NEXT_PUBLIC_MIN_BILL_AMOUNT` / `NEXT_PUBLIC_MAX_BILL_AMOUNT`, so their values are in the bundle and a reader knows exactly what the app-layer check is.

Real loss is bounded by the credit limit, which binds the financed portion under `claim_credit_for_plan` — the excess lands on instalment 1 and would have to clear on a real card. This is a data-integrity and abuse concern (absurd invoices, a nuisance-billing vector against a patient, a distorted exposure surface) rather than a direct cash-out. A negative `total_amount` is the more interesting case: `calculateFee` would produce a negative payout.

**Recommended fix.**

```sql
ALTER TABLE plans ADD CONSTRAINT plans_total_amount_sane
  CHECK (total_amount > 0 AND total_amount <= 1000000) NOT VALID;
```

`NOT VALID` so existing rows are not re-checked, matching the pattern 0122 used for `profiles_salary_amount_ceiling`. Keep the ceiling well above `MAX_BILL_AMOUNT` — this is a sanity bound, not a duplicate of the product rule, and the two should not have to be kept in step.

**How to test the fix.** Extend the plans RLS pglite suite with an insert at `-1` and at `1e9`, both expecting rejection.

---

### R3-07 — Residual notes

Not findings on their own.

- **`practice_members` INSERT is unconstrained on `role` and the capability flags** (`owners_insert_own_membership`, 0003). Neutralised once R3-02 closes, since the owner can then only do this on a practice that is still `pending` and cannot trade. Worth pinning anyway.
- **`payouts` is readable by any active practice member** (0092), `staff` included, and it now carries `snapshot_*` banking columns. Round two flagged this; with R3-01 open, those columns are also *writable* by a patient. Both halves close together.
- **`/api/reverse-geocode` uses a per-instance in-memory limiter** (30 / 5 min / user). Serverless instances do not share it, and each call spends Google Geocoding quota. Move it onto `consume_rate_limit` with its own bucket.
- **Carried forward, unchanged and still correct:** admin MFA and email-confirmation are Supabase dashboard settings, not repository changes (F-16 / F-18). `stubAffordabilityPolicy` is still a stub — every limit fix in rounds two and three enforces a number no policy produced. Bot/device/velocity correlation remains the single highest-leverage addition and is a week of work, not a patch.
- **Dependencies:** `pnpm audit` reports 2 high, both the `xlsx` runtime pair (prototype pollution GHSA-4r6h-8v6p-xvw6, ReDoS GHSA-5pgg-2g8v-p4x9), unchanged from round two and deliberately not force-resolved — SheetJS left npm at 0.20 and the fixed builds are CDN-only. The exposure is the CRM import path, which is authenticated (`sales`/`admin`), size-capped and parsed in memory. Repointing a dependency at a non-registry URL is a decision for a person. Everything else is clean.

---

## 4. What I checked and found sound

Recorded so round four does not re-derive it.

- **SQL injection** — none. Every query is a PostgREST builder or a parameterised RPC; no string concatenation into SQL anywhere, including the CRM search and dedupe paths.
- **Command injection / deserialisation** — no `child_process`, `eval`, `new Function` or `vm`. Only `JSON.parse` on webhook bodies.
- **Mass assignment** — every `.update()`/`.insert()` payload in the tree is built field-by-field. The two spread-shaped writes (`app/auth/callback/route.ts:250`, `app/brand/actions.ts:498`) spread server-constructed objects, never request bodies.
- **`sanitizeHtmlAllowList`** — I re-ran round two's five bypasses and tried unterminated tags, `/`-separated attributes, entity- and percent-encoded schemes, `<svg/onload>`, quote-bearing attribute names, and drop-content nesting. It fails closed on all of them: an input the tokeniser does not understand yields *less* output. The one gap is R3-04, which is outside the parser.
- **Peach webhook** — `${timestamp}.${webhookId}.${url}.${body}` HMAC-SHA256, hex-decoded both sides, length-checked, `timingSafeEqual`, 300s freshness, `x-webhook-id` recorded in `peach_webhook_events` *after* the handlers. URL from env, not forwarded headers.
- **Didit webhook** — canonical-V2 (shortenFloats → sortKeys → stringify) HMAC, `timingSafeEqual`, 300s skew window, event-id dedupe via the PK violation itself. Handler routing keys on the stored `identity_verification_path`, never on a `workflow_id`/env comparison.
- **Cron auth** — all three routes: `Bearer CRON_SECRET`, length pre-check, `timingSafeEqual`, refuse to run when unset, gated on a constant rather than an env toggle.
- **Gmail OAuth** — `state` validated against an httpOnly cookie **and** its `userId` prefix compared to the session user. Pub/Sub OIDC verified against live JWKS with `alg`/`kid`/iss/aud/email/exp checks.
- **`claim_credit_for_plan`** — the round-two A-04 fix is genuinely atomic: `SELECT … FOR UPDATE` on the profile before any exposure read, split validated against `total_amount`, excess pinned structurally to instalment 1, survivor check after the stale-row delete, and `enforce_credit_exposure` as a `DEFERRABLE INITIALLY DEFERRED` constraint trigger with **no privileged bypass** — so it binds service-role writes too. I checked the exposure arithmetic against the excess model and it does not double-count.
- **Consent token** — HMAC-SHA256 over a versioned payload, signature verified *before* the payload is decoded, `timingSafeEqual`, 30-minute expiry, random nonce, and both the version and the document SHA-256 pinned so a changed document invalidates outstanding tokens.
- **Column locks** — `protect_plans_write`, `protect_payments_write`, `protect_applications_write`, `protect_profiles_columns` all verified against the live definitions. 0126's repair of `hnpl_write_is_privileged()` (NULL → false) is present and the guards use `IS TRUE` / `IS NOT TRUE` so polarity is safe either way.
- **Admin / brand / CRM RBAC** — every surface re-reads `profiles.role` server-side through the caller's own client before writing. No client-supplied role is trusted anywhere. `crm_can_see_lead` (0129) is the single definition of lead visibility and every child policy routes through it.
- **Secrets** — 11 `NEXT_PUBLIC_` names, all intentionally public. No server secret referenced in any `'use client'` module. `.env*` gitignored; no `.env` ever committed; a pattern scan of the full history for JWTs, AWS keys, PEM blocks and live Stripe-shaped keys found nothing.
- **Logging** — no SA ID, card number, token, password or push key is written to a log. The Didit handler logs `{ userId, sessionId }` on its ALERT paths, never the identity value.
- **CORS / cookies / headers** — no `Access-Control-Allow-Origin` anywhere. Both application cookies are `httpOnly`, `sameSite=lax`, `secure` in production, path-scoped, bounded `maxAge`. HSTS 2y+preload, `X-Frame-Options: DENY`, `frame-ancestors 'none'`, `nosniff`, `strict-origin-when-cross-origin`, a scoped `Permissions-Policy`.
- **File upload** — still no object storage and no upload endpoint. The only attacker-supplied file is the CRM CSV/XLSX, authenticated and size-capped.

---

## 5. Attack chains, ranked

| # | Chain | Likelihood | Financial | Privacy | Ease | Privilege needed | Detectability |
|---|---|---|---|---|---|---|---|
| **C1** | R3-02 → self-approved 0%-fee merchant → bill a controlled account → take the payout → default | **High** | **Severe** | Low | **Trivial** (3 HTTP calls) | any authenticated user | **Very low** — never enters the approval queue |
| **C2** | R3-01 → forge the payout on a *real* bill → redirect to attacker banking (uses C1's practice) | **High** | **Severe** | Low | **Trivial** (1 HTTP call) | patient with any live bill | **Very low** — no error, no log, no audit row |
| **C3** | R3-01 variant C → `status='paid'` on real practices' payouts at scale | Medium | High (trust) | None | Trivial | patient with a bill at each practice | Low — surfaces only as practice complaints |
| **C4** | R3-03 → map internal HTTPS services via the `deleted_at` oracle | Low | None | Medium | Moderate (slow) | any authenticated user | Low |
| **C5** | R3-06 → absurd or negative invoices against a patient from a compromised practice account | Low | Low | Low | Trivial | practice member | Medium — visible to the patient |

C1 and C2 are the same afternoon's work for one attacker, and they compose: C1 supplies the destination that makes C2 pay out.

---

## 6. Security scorecard

| Area | Score | Note |
|---|---|---|
| Authentication | 8 / 10 | OTP genuinely fixed; session cap enforced server-side; no admin MFA (dashboard setting) |
| **Authorization** | **3 / 10** | RBAC and IDOR are excellent everywhere I looked — two open INSERT policies undo it |
| API security | 8 / 10 | Every route authenticates and re-derives authority; SSRF on one input |
| **Business logic** | **4 / 10** | The acceptance path is now genuinely atomic; the payout path can be pre-empted |
| **Payment security** | **4 / 10** | Webhooks, amount verification and idempotency are exemplary; the payout row is forgeable |
| KYC security | 7 / 10 | Both doors gated, DHA + face-match binding, one-SA-ID-per-account enforced by unique index |
| Database security | 6 / 10 | No injection; RLS on every table; two tables missing an INSERT trigger; one missing CHECK |
| Input validation | 8 / 10 | Server-side throughout; the sanitiser is a genuine parser now |
| Rate limiting | 7 / 10 | Shared-state buckets on every money surface; fails open by design; one in-memory holdout |
| Bot protection | 2 / 10 | Unchanged — no device, velocity or payment-method correlation |
| Secrets management | 9 / 10 | Correctly partitioned, nothing in history |
| Infrastructure | 7 / 10 | Six of seven headers enforced; CSP report-only and uncollected |
| Logging / monitoring | 5 / 10 | Audit coverage landed in 0131; nothing watches payout creation, which is where C2 hides |
| Admin security | 6 / 10 | RBAC and audit trail are right; no MFA, no re-auth on money actions |

---

## 7. Prioritised remediation plan

### Fix immediately — before any further real money

**Written: `supabase/migrations/0135_close_insert_surface_payouts_practices.sql`**, covering both criticals, with `0135_close_insert_surface.rls.test.ts` (21 assertions) proving the holes are closed *and* that the three load-bearing legitimate paths still work. **Not yet applied to production** — it is a pending migration awaiting a deliberate deploy.

1. **R3-01** — `DROP POLICY "patients_insert_payout_on_accept" ON payouts` and add `protect_payouts_write`. The policy is dead code; verified against every write path in the tree. *Done in 0135.*
2. **R3-02** — give `protect_practices_columns` an INSERT branch and rebuild the trigger as `BEFORE INSERT OR UPDATE`; drop `authenticated_insert_practice`. *Done in 0135.*

   One thing the migration had to work around, recorded because it is the way this fix goes wrong: `payouts` **cannot** take the blanket refusal `protect_plans_write` uses. `app/admin/payouts/actions.ts` settles payouts on the **session client**, not service-role, and that is deliberate — 0131's `trg_log_payout_settlement` records `auth.uid()`, so moving it to service-role would make every settlement audit row read `actor_id = NULL`. 0135's UPDATE branch therefore permits exactly one write: a platform admin changing only `status` and `paid_at`, `pending → paid`.
3. **Audit the production data for both.** Before or alongside the fix, run:
   ```sql
   -- payouts nobody's activation path would have written
   SELECT p.* FROM payouts p JOIN plans pl ON pl.id = p.plan_id
    WHERE p.practice_id IS DISTINCT FROM pl.practice_id
       OR p.snapshot_account_number IS NOT NULL
       OR p.status = 'paid' AND p.batch_id IS NULL;

   -- practices that were never approved by an admin
   SELECT id, name, owner_id, status, fee_percent, approved_at, approved_by, created_at
     FROM practices
    WHERE status = 'approved' AND (approved_by IS NULL OR approved_at IS NULL);
   ```
   Both findings leave no log, so the data is the only evidence.

### Fix before launch

4. **R3-03** — allow-list push endpoints at write time and at send time.
5. **R3-06** — `plans_total_amount_sane` CHECK.
6. **`owners_insert_own_membership`** — pin `role` and the capability flags, or move the self-heal to service-role.
7. **R3-05** — add `/api/csp-report`, point the policy at it, then start the collection week.

### Improve after launch

8. **R3-04** — swap the merge/sanitise order at both call sites.
9. Move `/api/reverse-geocode` onto `consume_rate_limit`.
10. Admin MFA and re-authentication on money actions (F-16), email confirmation (F-18) — Supabase dashboard.
11. Alerting on payout creation: a payout whose `practice_id` differs from its plan's, or which appears before its plan is `active`, should page someone.
12. Bot / device / velocity correlation — still the highest-leverage single addition.
13. Replace `stubAffordabilityPolicy` with real underwriting. Every limit enforcement built in rounds two and three enforces a stub correctly; that is not the same as underwriting.

---

## 8. Proof-of-concept tests added

`supabase/migrations/security-audit-r3-payouts-practices.rls.test.ts` — 9 assertions, all passing, run against real PostgreSQL (pglite) as a real non-superuser `authenticated` role, with the policies, triggers and constraints transcribed verbatim from the live database.

- **R3-01** (4): the patient's INSERT succeeds; the legitimate `ON CONFLICT DO NOTHING` upsert then no-ops so the forged row survives; `net_amount`, `practice_id` and the banking snapshot are all attacker-set; `status='paid'` is accepted.
- **R3-02** (5): a billed patient can read a usable `group_id`; INSERT a practice at `status='approved'` and `fee_percent=0`; grant themselves an active `provider` membership; `practice_can_trade()` returns `true`; the forged practice raises a bill through RLS.

They are written to **pass while the defects are open**. On fixing, invert each assertion rather than deleting it — the inverted form is the regression test.

No production code was modified by this audit.
