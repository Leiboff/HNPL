# HNPL / betternow defensive security audit — 2026-09-03

## Scope, method, and limitations

This review covers the complete repository at commit `4cd42be`: the Next.js 16
application, all route handlers and Server Actions, Supabase migrations and RLS,
authentication middleware, KYC, credit, payments, payouts, CRM, scheduled jobs,
deployment configuration, dependencies, and git history. The review treated the
browser, every action argument, the public Supabase key, and every directly
reachable PostgREST operation as attacker-controlled.

The review combined static call-path tracing, migration-policy review, history and
secret-pattern searches, the existing adversarial PostgreSQL tests, an attempted
complete unit/integration run, TypeScript and ESLint, and `pnpm audit`. It did **not** call
production or third-party APIs. No production code or data was changed. Operational
Supabase settings, deployed environment values, AWS/IAM (none is defined in this
repository), provider dashboards, network egress policy, and the live database
cannot be proven from source alone and must be verified before launch.

This is a point-in-time report. It re-verified the remediations documented in the
three earlier audits rather than reporting their closed exploit proofs as current
vulnerabilities.

## Executive summary

**Overall security level: MEDIUM.** No currently open Critical code vulnerability
was reproduced. The application's strongest areas are payment-webhook authenticity,
atomic credit reservation, direct database write locks, RLS regression coverage,
server-side role derivation, and encryption/blind indexing of South African ID
numbers. The previous critical payout forgery, self-approved merchant, checkout
account-takeover, OTP, and concurrent-credit defects are covered by migrations and
regression tests.

Launch should nevertheless be blocked on three issues:

1. **Underwriting is explicitly a stub.** The system correctly and atomically
   enforces a limit, but the limit is not the output of a production affordability
   or credit-risk policy. Correct enforcement of an unfit decision is still a
   financial-loss control failure.
2. **There is no cross-account bot/fraud correlation.** Per-operation rate limits
   do not prevent a distributed actor from repeating signup, identity, credit and
   merchant/payment flows across identities, devices, IPs and payment instruments.
3. **Arbitrary push endpoints create blind SSRF.** An authenticated user can store
   an attacker-chosen HTTPS URL that `web-push` later contacts from server egress.

The largest privacy and account-takeover risks are operational: admin MFA and email
confirmation are Supabase settings and are not asserted by this repository. They
must be evidenced in the deployed project. Browser sessions have a server-enforced
absolute cap and global logout, but Supabase auth cookies remain readable by
JavaScript; the now-enforced nonce CSP materially reduces, but does not eliminate,
the consequence of a future XSS.

## Architecture and trust boundaries

- **Frontend:** Next.js 16 App Router with React 19, Server Components and client
  islands. Supabase's anon key and selected `NEXT_PUBLIC_*` configuration are
  intentionally public. Frontend gating is not counted as authorization.
- **Backend:** Next route handlers plus 34 Server Action modules. Ordinary reads
  generally use the caller-bound Supabase client; privileged writes use a
  separately-created service-role client only after caller identity and scope are
  re-derived.
- **Data:** PostgreSQL/Supabase. RLS is enabled and migration 0125 changes function
  execution to an allow-list. Migrations 0121/0122/0128/0135 protect money,
  application, profile, payout, and practice invariants; 0130 reserves credit under
  a profile row lock and a deferred exposure constraint; 0136 reconciles known RLS
  drift; 0137 exposes a service-only catalog snapshot for daily drift detection.
- **Identity:** Supabase email/password and Google OAuth; phone OTP RPCs are
  service-only and caller-bound. Didit liveness/DHA webhooks establish server-side
  identity state. SA IDs are AES-256-GCM encrypted with a separate HMAC blind index.
- **Roles:** patient, provider/practice member (staff/provider/manager capabilities),
  brand admin, sales, and admin. Admin/sales checks re-read `profiles.role`; practice
  and brand access is membership/group scoped in SQL and again in actions.
- **Money:** a practice creates a plan; a patient completes onboarding and accepts;
  `claim_credit_for_plan` atomically binds the schedule and exposure; Peach starts
  or tokenizes charges; signed webhooks activate payments; payout rows are created
  once and batched by scheduled jobs. Refund fields exist in the schema, but there
  is no public refund-issuance endpoint in the current application.
- **External services:** Supabase, Peach Payments, Didit, Datanamix, SMSPortal,
  Gmail/Google Pub/Sub, Google Places/Geocoding, VAPID push endpoints, and Resend.
  No repository AWS configuration, object storage, general document upload, queue,
  or worker service was found. Scheduled work is four Vercel cron routes.

## Attack-surface inventory

### HTTP route handlers

| Endpoint | Method | Authentication / role | Inputs | State / data / external call | Validation, authorization, limiting |
|---|---|---|---|---|---|
| `/api/auth/logout` | POST | Supabase session | cookies | Global session revoke | caller session; no rate limit needed |
| `/auth/callback` | GET | OAuth code + consent cookie | code, next | session/profile/legal acceptance; Supabase | callback exchange; signed consent; redirect constrained |
| `/auth/require-terms` | GET, POST | session | acceptance | legal state | signed consent and confirmed caller |
| `/api/payment-methods/recent` | GET | confirmed patient | session | card metadata | patient id derived from session |
| `/api/push/subscribe` | POST | session | endpoint, p256dh, auth | push subscription; later outbound web-push | ownership protected; structural presence only; **no destination allow-list (S-03)** |
| `/api/push/unsubscribe` | POST | session | endpoint | soft delete | endpoint and user must match |
| `/api/reverse-geocode` | GET, POST | session | coordinates | Google Geocoding | coordinate validation; persistent user/IP rate bucket |
| `/api/payments/peach/webhook` | POST | Peach HMAC | bounded raw body, headers | money/payment state | 300-second window, constant-time signature, event ledger, amount/state checks, streamed size cap |
| `/api/verification/didit/webhook` | POST | Didit HMAC | identity event | KYC/PII | canonical signature, time window, event-id dedupe, stored workflow/user binding |
| `/api/crm/gmail/connect` | GET | sales/admin | session | OAuth redirect | role re-derived; state issued |
| `/api/crm/gmail/callback` | GET | sales/admin + OAuth state | code, state | encrypted Gmail tokens | cookie- and user-bound state; role re-derived |
| `/api/crm/gmail/disconnect` | POST | sales/admin | account | token/account update | caller ownership or admin scope |
| `/api/crm/gmail/push` | POST | Google OIDC | Pub/Sub envelope | CRM email/activity | RS256/JWKS, issuer/audience/email/expiry checks |
| `/api/cron/collect-instalments` | GET, POST | `Bearer CRON_SECRET` | none | charges cards, dunning, notifications | constant-time secret; atomic payment claims; persistent limits |
| `/api/cron/payout-batches` | GET, POST | `Bearer CRON_SECRET` | none | settlement batches | constant-time secret; unique plan payout and batch preconditions |
| `/api/cron/crm-reply-poll` | GET, POST | `Bearer CRON_SECRET` | none | Gmail polling/CRM PII | constant-time secret; account scoping |
| `/api/cron/rls-drift` | GET, POST | `Bearer CRON_SECRET` | none | read-only catalog comparison | constant-time secret; service-only RPC; alerts on mismatch |
| `/sw.js` | GET | public | none | service worker | generated static script; proxy-exempt intentionally |

No permissive CORS header was found. API routes remain in the proxy matcher, so the
absolute session cap is not bypassed through `/api`. API calls receive JSON 401
rather than an HTML redirect, except genuine browser document navigations such as
OAuth endpoints.

### Server Actions (the effective RPC surface)

| Area and exported operations | Authentication / object authorization | Sensitive inputs and effects | Limits |
|---|---|---|---|
| Phone auth: request/verify/skip; phone-change start/request/verify/cancel | session user or high-entropy checkout token; OTP RPC binds caller/token/phone | phone, OTP; stamps verification | persistent phone, identity/token and IP buckets; send/attempt/burn caps |
| Signup/resend/password completion | Supabase flow, invitation binding where applicable | email, password, identity linkage | Supabase controls plus action limits; deployed email-confirmation setting must be checked |
| Patient onboarding: phone, salary, identity start/submit, credit check/refresh | session user; profile id always derived | salary, encrypted SA ID, KYC provider session, credit decision | action buckets; third-party cost correlation remains weak |
| Patient plans: accept, initialize payment/card, saved card, decline, settle instalment/all | confirmed patient; plan/payment/card queried with `patient_id = auth.uid()` | money and plan state | persistent rate limits, atomic claims, provider amount read server-side |
| Checkout: initiate, resume capture, finalize password, request/verify OTP | opaque invitation/session token plus email/phone/identity binding; existing accounts are never password-reset | account creation, plan acceptance, first charge | token/phone/IP buckets, TTLs, one-time state transitions |
| Practice bills/POS: create bill, unlock/register devices, issue/expire/read/ack session | active scoped practice membership or hashed device secret + practice PIN; provider membership rechecked | amount, patient identity, provider member, bill/session creation | amount allow-list in actions; PIN/device limits; DB amount bound still missing (S-05) |
| Practice members/devices/settings | owner/manager capability and practice scope re-derived | member role/capabilities, device revocation, PIN | administrative action limits vary; audit sensitive changes |
| Brand: branches, group details, team, banking | brand-admin group relation re-derived; branch must belong to group | merchant and settlement destination data | role/object checks; banking changes audited |
| Admin: approvals/suspension, fee, groups, sales grants, payouts, collection retry, audit note | `profiles.role = admin` (sales where explicitly allowed), read server-side | roles, merchant trading, fees, payouts, card retry, audit | action-level limits on money paths; **MFA operationally unproven (S-02)** |
| CRM: leads, contacts, tasks, imports, email, signatures, Gmail admin | sales/admin plus `crm_can_see_lead`/owner scope | patient/provider contact PII, files-as-text, outbound mail | CSV/XLSX size caps; import dependency risk (S-06); signature post-sanitize merge (S-04) |
| Contact/public leads | public or patient session | contact PII/message | persistent public/user/IP buckets; generic response |

### Database objects and invariants

The principal tables are `profiles`, `practices`, `practice_groups`,
`practice_members`, `applications`, `plans`, `payments`, `payment_methods`,
`payouts`, `payout_batches`, checkout/invitation/phone verification tables, identity
verification fields/events, admin/plan audit events, rate-limit hits, push
subscriptions, and CRM lead/contact/activity/task/Gmail tables. Direct browser
writes are security-relevant because the anon key is public. The current migration
set closes unrestricted money/practice INSERT paths, protects owner/admin columns
with triggers, and limits `SECURITY DEFINER` execution. A daily job compares the
deployed RLS catalog with migration replay.

Important database invariants include unique payout-per-plan, unique payment per
plan/instalment, one SA-ID blind index, webhook event IDs, token uniqueness, guarded
state columns, atomic credit claiming, and checkout TTL/state predicates. SQL is
PostgREST-builder or parameterised PL/pgSQL; no request-data SQL concatenation was
found.

## Current findings

### S-01 — Production underwriting is a stub

**Severity: High**  
**Location:** `lib/underwriting/stubAffordabilityPolicy.ts`; invoked by
`lib/onboarding/actions.ts` and enforced by `lib/underwriting/claimCredit.ts` /
`supabase/migrations/0130_claim_credit_for_plan.sql`.

**What is wrong.** The credit limit is generated by an explicitly named stub rather
than a production affordability/risk policy. The later reservation machinery is
strong, but it cannot compensate for a decision that ignores the required lending
inputs or has not been independently validated.

**Exploit scenario.** An otherwise valid or synthetically assembled identity enters
the minimum data that makes the stub approve. The attacker repeats across identities,
spends each correctly reserved allowance at a colluding practice, takes the practice
payout after the first instalment, and defaults. No race or parameter tampering is
required; the expected workflow itself produces the loss.

**Impact.** Systematic adverse selection, irresponsible-lending/regulatory exposure,
and direct principal loss at scale.

**Recommended fix.** Replace the stub with a versioned, server-only policy that
uses verified income, existing exposure, identity/KYC risk signals and bureau data;
records inputs, model/policy version, reason codes and decision; supports manual
review; fails closed on provider uncertainty; and is approved by credit-risk and
legal owners. Keep the existing atomic claim and deferred database constraint.

**Test the fix.** Contract-test boundary incomes and expenses, stale/missing bureau
data, provider timeouts, manipulated client amounts, repeat identities, concurrent
claims, policy-version replay, and the deferred exposure constraint. Independently
validate expected approval/default bands with a non-production portfolio fixture.

### S-02 — Privileged-account MFA and email-confirmation enforcement are not code-verifiable

**Severity: High until deployment evidence exists; Medium once enforced**  
**Location:** Supabase Auth project settings (outside repository); admin entry is
guarded by `app/admin/layout.tsx` and `lib/auth/requireSalesOrAdmin.ts`.

**What is wrong.** Role checks are good, but the source tree cannot prove that admin
and sales users must complete phishing-resistant MFA or that new email/password
accounts must confirm email. Password-only admin access leaves merchant approval,
fees, collections, sales grants, payouts and customer PII behind one credential.

**Exploit scenario.** Credential stuffing or mailbox/password phishing compromises
an admin. The attacker approves a mule practice, alters settlement-related settings,
retries collections, exports/views PII, or grants another privileged role. Server-side
RBAC correctly accepts the stolen privileged session.

**Impact.** Financial loss, broad PII exposure, persistent privilege escalation and
high-impact audit manipulation.

**Recommended fix.** Require WebAuthn/passkey MFA for admin and sales, enforce AAL2
in privileged layouts/actions (not merely in UI), require recent re-authentication
for role/banking/payout actions, disable shared accounts, confirm email before
onboarding/money use, and alert on recovery/MFA changes. Export the auth settings or
add a deployment smoke test so configuration drift fails release.

**Test the fix.** With a password-only session, directly invoke every admin/sales
Server Action and assert rejection for insufficient AAL. Repeat with AAL2. Verify
recovery invalidates existing sessions and that an unconfirmed user cannot reach
KYC, credit, checkout acceptance, or payment-method creation.

### S-03 — Authenticated blind SSRF through arbitrary push subscription endpoints

> **Status: Fixed in the subsequent remediation.** Registration now accepts
> only explicitly supported browser push-service HTTPS hosts on port 443, and
> the send sink independently revalidates and retires legacy invalid rows
> before `web-push` can issue a request. Adversarial hostname, IP, credential,
> scheme, and port cases are covered by unit tests.

**Severity: Medium**  
**Location:** `app/api/push/subscribe/route.ts` accepts any non-empty endpoint;
`lib/notifications/sendPush.ts` passes stored endpoints to `web-push`.

**What is wrong.** Ownership reassignment is correctly prevented, but the endpoint
is not restricted to HTTPS web-push providers, port 443, or public address space.
When a notification is generated, the server makes a request to the stored URL.

**Exploit scenario.** An authenticated attacker registers
`https://10.0.0.7:8443/internal/path` with syntactically valid push keys, then causes
a notification to their account. Differences in soft deletion after 404/410 provide
a one-bit reachability/status oracle, enabling slow internal host/port/path probing.

**Impact.** Requests from trusted application egress, internal HTTPS discovery and
use as a request relay. Cloud metadata risk depends on the deployment platform and
egress controls.

**Recommended fix.** Parse with `URL`; require `https:`, default/443 port, no userinfo,
and an exact maintained allow-list of browser push-service hostname suffixes. Resolve
DNS and reject private, loopback, link-local and reserved results at send time; recheck
after redirects and disable redirects where supported. Apply the guard both at write
and send time, and delete/quarantine legacy invalid rows.

**Test the fix.** Assert rejection for loopback, RFC1918, link-local, IPv6 local,
decimal/hex IP forms, credentials, alternate ports, look-alike suffixes and DNS
rebinding fixtures; allow known FCM/Mozilla/Apple endpoints. Assert legacy malicious
rows are never passed to `sendNotification`.

### S-04 — Signature merge fields are substituted after HTML sanitisation

**Severity: Low (currently self-XSS / outbound-content hardening)**  
**Location:** `lib/gmail/signature.ts` and its call sites in
`app/crm/settings/signatureActions.ts` and `app/crm/leads/[id]/composeEmail.ts`.

**What is wrong.** Values are HTML-escaped, preventing attribute breakout, but a
placeholder already inside `href` can turn a sanitizer-approved relative value into
`javascript:` after the URL check has completed.

**Exploit scenario.** A sales user saves `<a href="{{email}}">x</a>` and supplies a
merge value such as `javascript:...`. Present scoping limits the browser victim to
the same user, but a later shared/admin preview feature would convert it to stored
staff XSS; outbound recipients also receive an unsafe link.

**Impact.** Unsafe outbound content now and a latent stored-XSS boundary if signature
visibility expands.

**Recommended fix.** Escape/merge first, then run the completed HTML through the
allow-list sanitizer; retain both layers. Consider context-specific placeholders so
text values can never appear in URL attributes.

**Test the fix.** Add adversarial cases for placeholders in `href`, mixed-case and
encoded schemes, quotes, entity boundaries and nested tags; assert the final emitted
HTML has no unsafe `href`.

### S-05 — Bill-amount sanity bounds are not enforced by PostgreSQL

**Severity: Low**  
**Location:** `lib/config/billAmountLimits.ts`, `app/practice/bills/new/actions.ts`,
`app/practice/pos/actions.ts`; no equivalent `plans.total_amount` CHECK constraint.

**What is wrong.** Server Actions enforce configured minimum/maximum amounts, but a
trading practice can use its own JWT and the public PostgREST API directly. RLS and
write triggers restrict ownership/status but do not impose a positive hard ceiling.

**Exploit scenario.** A compromised or malicious practice directly inserts a
negative or absurd plan amount, bypassing the action check. Credit reservation limits
normal financed exposure, reducing direct loss, but malformed records can distort
invoices, fees, reporting and downstream assumptions.

**Impact.** Data-integrity damage, nuisance billing, broken reconciliation and a
future money bug if a consumer assumes positivity.

**Recommended fix.** Add a database CHECK requiring `total_amount > 0` and a generous
absolute sanity ceiling independent of the product-configured maximum; validate
existing rows before making it fully valid. Preserve action-level product checks.

**Test the fix.** As an authenticated trading practice, directly insert negative,
zero, extreme, NaN-equivalent/precision-edge values via PostgREST and assert database
rejection; verify valid boundary and historical rows.

### S-06 — The CRM spreadsheet parser has known high-severity advisories

> **Status: Fixed in the subsequent remediation.** XLS/XLSX ingestion and
> the vulnerable `xlsx` dependency were removed. Both CRM import modes now
> accept CSV only, reject misleading file extensions, and enforce the same
> 5 MB limit in the browser that the server actions enforce.

**Severity: Medium in this deployment (upstream advisories are High)**  
**Location:** `package.json` (`xlsx` 0.18.5), CRM import actions under
`app/crm/import/`.

**What is wrong.** The npm release is affected by published prototype-pollution and
ReDoS advisories. Import is restricted to sales/admin, size-capped and parsed in
memory, which reduces but does not remove risk from malicious or compromised-staff
workbooks. The corrected upstream package is not available as a normal newer npm
release, so a blind semver bump is not an adequate remediation.

**Exploit scenario.** A malicious workbook sent to a sales user causes expensive
parsing (availability/cost impact) or manipulates object prototypes in the importing
server process. The attacker needs a privileged importer or social engineering.

**Impact.** Serverless resource exhaustion and potentially unsafe process behavior
during a privileged import.

**Recommended fix.** Prefer CSV-only ingestion or a maintained, reviewed spreadsheet
parser. If SheetJS's vendor distribution is selected, pin by integrity/hash, document
provenance and license, and exercise it in isolation. Keep strict byte, row, column,
cell and processing-time limits and normalize parsed objects into null-prototype,
allow-listed records.

**Test the fix.** Run known advisory fixtures and oversized/compression-amplified,
deep, formula and prototype-key workbooks in a resource-limited test process; assert
bounded time/memory and that `Object.prototype` is unchanged.

### S-07 — Abuse prevention is operation-local, not identity/device/instrument correlated

**Severity: High for a credit product**  
**Location:** `lib/security/rateLimit.ts`, migration 0134, individual auth/KYC/credit/
payment actions; no repository fraud-event correlation service.

**What is wrong.** Durable buckets cover important actions and emit bounded telemetry,
but a botnet or fraud ring can rotate account, phone, IP and identity. There is no
single velocity graph joining normalized identity, device, IP/ASN, card fingerprint,
bank account, phone, email, practice, KYC portrait/session, and payout destination.

**Exploit scenario.** Automation performs signup → OTP → KYC → credit decision →
colluding-practice bill → first payment across many identities. Each entity remains
under its local bucket while aggregate KYC, SMS, bureau and payment costs grow and
approved principal is cashed out.

**Impact.** Scalable third-party cost abuse, synthetic/duplicate identities, mule
merchant cash-out and losses that no single endpoint's logs make obvious.

**Recommended fix.** Add risk-based velocity rules per IP/subnet/ASN, device-bound
key, phone, email domain, encrypted-identity blind index, KYC session/portrait signal,
card fingerprint, bank account, practice and global budget. Introduce staged friction,
CAPTCHA only after risk, manual review, provider spend circuit breakers, duplicate
identity/device/instrument alerts, and daily loss/cost ceilings. Never store raw
fingerprint data when a keyed stable token suffices; document POPIA purpose/retention.

**Test the fix.** Execute multi-account test matrices varying one dimension at a time,
distributed-IP cases, concurrent signup/credit requests and provider outages. Assert
aggregate thresholds, alert evidence, manual-review transitions and safe fail-closed
behavior without locking out normal household/shared-network patterns.

### S-08 — The security regression suite is not currently green

> **Status: Fixed in the subsequent remediation.** Action suites now share
> an explicit allow-through fixture for tests whose subject is downstream
> business behavior, while the rate limiter's dedicated suites continue to
> exercise IP extraction, database exhaustion, fail-closed behavior, and
> telemetry. The stale CSP source allow-list was also reconciled. A full
> diagnostic run reached all 397 files / 7,168 tests with one remaining
> signup-gate fixture failure; that identified fixture was then repaired and
> all 11 affected suites pass together (185 tests).

**Severity: Medium (assurance/process)**  
**Location:** rate-limited action tests including
`app/practice/bills/new/billIdentityRouting.test.ts`,
`app/signup/patient/signup-acceptance-recovery.test.ts`,
`app/contact/contactAction.test.ts`, `app/practice/pos/actions.test.ts`,
`app/practices/publicLeadAction.test.ts`, and
`lib/onboarding/submitIdentityForVerification.test.ts`.

**What is wrong.** The attempted full `pnpm test` run produced broad failures after
the rate-limit hardening: older action mocks do not provide an IP subject and/or the
new `consume_rate_limit` RPC, so security-sensitive happy paths and adversarial
assertions exit at the limiter instead of exercising the intended code. The run was
stopped after multiple suites showed the same systemic failure. ESLint also has 29
pre-existing errors and is deliberately non-blocking in CI.

**Impact.** A red or routinely ignored security suite cannot act as a release gate.
Regressions in identity binding, consent, POS issuance, public abuse controls and KYC
may be hidden behind harness failures, while maintainers become accustomed to noise.

**Recommended fix.** Centralize a realistic request-header/rate-limit RPC mock for
action tests, explicitly test fail-closed missing-subject behavior in the limiter's
own suite, and make all downstream fixtures pass a stable test IP/account. Restore a
green full run and make it mandatory. Clear the lint baseline, or temporarily pin an
exact allowed-error snapshot that can only decrease rather than leaving lint wholly
non-blocking.

**Test the fix.** Run `pnpm test` twice, including `--no-file-parallelism`, and require
zero failed tests; run the named suites individually to show they pass through the
limiter into the behavior they claim to assert. Run `pnpm lint` with zero errors.

## Authentication, authorization, and race-condition conclusions

- OTP codes are randomly generated and pepper-hashed; preparation/verification RPCs
  are service-only, caller-bound, replay/burn limited, and verification state is
  one-time/freshness constrained. Responses should continue to avoid enumeration.
- Sessions are refreshed through Supabase SSR, globally revoked on logout, and
  capped server-side. Auth cookies are cleared including chunked variants. The client
  inactivity guard is only a convenience layer and is correctly not trusted.
- Password recovery uses Supabase's token flow. Checkout no longer changes an
  existing account password or mints a session for a reused identity. Invitation
  claims bind token email to the authenticated email and update only an unclaimed
  plan.
- Object IDs in patient money actions are always paired with `patient_id`; practice
  objects with active membership/capability and same-practice provider membership;
  brand objects with group-admin scope; CRM child objects with lead visibility; and
  admin actions with a server-read role. No open horizontal or vertical IDOR was
  reproduced.
- Credit checking and reservation are in one locked database operation. Deferred
  exposure enforcement has no service-role bypass. Payment and payout uniqueness,
  webhook event ledgers, conditional state updates and processing claims prevent the
  reviewed double-spend, double-approval, duplicate-payment and duplicate-payout
  races. Preserve those invariants in any refund implementation.

## Payment, webhook, KYC, and upload conclusions

- The frontend can choose a plan type or payment method identifier, but amounts,
  ownership, provider/practice relationship and expected state are re-read server
  side. A client "success" value is not authoritative.
- Peach authenticates the bounded raw body with HMAC over timestamp, event ID, URL
  and body; checks freshness in constant time; records event IDs; validates payment
  relationship, amount and expected transitions. Duplicate processing is idempotent.
- Didit authenticates canonicalized events, checks freshness/event ID, binds the
  event to the stored user/provider workflow and writes KYC state with the privileged
  client. Clients cannot directly set verification, liveness or credit status due
  to profile/application locks.
- No general document/object-storage upload surface exists. CRM imports accept CSV
  or XLSX content in memory, are privileged and size-limited; S-06 applies. If ID
  document upload is later added, require signature/MIME/size checks, private object
  ACLs, randomized names, malware scanning, download content disposition and explicit
  retention/deletion.
- Refund schema fields exist but no user/provider/admin refund action was found.
  Before introducing refunds, require server-derived refundable amount, an atomic
  state machine and cumulative-refund constraint, provider idempotency key/event
  ledger, destination pinning to the original instrument, dual control for exceptions,
  and audit logs.

## Browser, injection, secrets, infrastructure, and monitoring

- No `eval`, dynamic function creation, command execution, unsafe SQL concatenation,
  or unsafe deserialization was found. HTML is allow-list sanitized, with S-04 the
  remaining ordering flaw. No general user-controlled `dangerouslySetInnerHTML`
  sink was found outside reviewed sanitized content.
- The application sets HSTS, DENY/frame-ancestors, nosniff, strict-origin referrer
  policy and a restrictive Permissions Policy. A per-request nonce CSP is enforced;
  scripts exclude unsafe-inline and production unsafe-eval. Inline styles remain
  allowed for React compatibility. No permissive CORS was found.
- Service and legal cookies are HttpOnly, Secure in production and SameSite=Lax.
  Supabase auth-cookie flags are library-controlled; CSP and prompt patching remain
  important because the refresh token is readable by same-origin script.
- `.env*` is ignored and no environment file, AWS key, PEM private key, service-role
  JWT, live payment key, or hardcoded production credential was found in the current
  tree or the inspected git history patterns. Public variables are limited to values
  intended for browser use (Supabase URL/anon key, app URL, public VAPID key, Peach
  checkout entity ID, Places browser key, feature flags and UI bill bands). Provider
  secrets remain server-only.
- Docker/Docker Compose/Kubernetes/Terraform/CloudFormation and AWS configuration are
  absent. Deployment is Vercel plus Supabase. This reduces repository infrastructure
  surface but means dashboard IAM, backups, PITR, encryption, network restrictions,
  secret rotation and log retention need a separate evidence audit.
- Security-relevant logs exist for rate-limit denial/failure, webhook alerts, push
  ownership attempts, cron runs, admin changes and plan events. No reviewed log writes
  raw SA IDs, passwords, OTPs, card tokens or push keys. Missing is the cross-entity
  detection described in S-07 and explicit alert routing/SLO evidence.

## Attack-chain analysis

| Chain | Likelihood | Financial impact | Privacy | Ease / privilege | Detectability |
|---|---:|---:|---:|---|---:|
| Stub policy + distributed identities + colluding practice + first-payment payout + later default | High | Severe | Medium | Moderate; multiple identities/practice | Low without S-07 |
| Password-only admin compromise + merchant/fee/payout actions | Medium until MFA proven | Severe | Severe | Stolen admin credential | Medium; audit rows exist |
| Arbitrary push endpoint + self-notification + status/deletion oracle | Low–Medium | Low | Medium | Easy; any account | Low |
| Malicious spreadsheet + privileged importer | Low | Medium availability | Medium | Social engineering or sales/admin | Medium |
| Direct PostgREST absurd bill + downstream assumption | Low | Low–Medium | Low | Trading practice | High/visible |

The first chain is the priority because no software exploit is necessary: every step
can be a superficially valid request. The strongest conventional controls therefore
do not stop it.

## Security scorecard

| Area | Score | Rationale |
|---|---:|---|
| Authentication | 8/10 | Strong OTP/session repairs; deployed MFA/email confirmation unproven |
| Authorization | 9/10 | Layered RLS, action scoping and regression proofs; no current IDOR reproduced |
| API security | 8/10 | Auth/validation strong; push SSRF and some defence-in-depth gaps |
| Business logic | 6/10 | Atomic invariants strong; stub decisioning and aggregate fraud gap |
| Payment security | 9/10 | Server-derived amounts, signed/idempotent webhooks, guarded transitions |
| KYC security | 8/10 | Server-established Didit/DHA state and unique identity index; automation risk |
| Database security | 9/10 | RLS/write locks/function allow-list/drift detection; amount CHECK absent |
| Input validation | 8/10 | Broad allow-list validation; push URL and post-sanitize substitution gaps |
| Rate limiting | 7/10 | Durable action buckets and telemetry; cross-dimension evasion remains |
| Bot protection | 3/10 | No device/identity/instrument correlation or aggregate spend circuit breakers |
| Secrets management | 9/10 | Clean tree/history patterns and browser/server separation; deployed rotation unproven |
| Infrastructure | 7/10 | Strong application headers/drift cron; dashboard/IAM/backup evidence absent |
| Logging/monitoring | 7/10 | Audit/event/cron/rate-limit logs; correlation and alert delivery unproven |
| Admin security | 6/10 | Strong RBAC/auditing; MFA and step-up authentication not repository-enforced |

## Prioritized remediation plan

### Fix immediately

1. Replace and independently validate the underwriting stub (S-01); do not expose
   real credit before this is complete.
2. Prove and enforce phishing-resistant admin/sales MFA, AAL2 in every privileged
   action, email confirmation, recovery/session invalidation and step-up checks
   (S-02).
3. Implement aggregate fraud/device/identity/payment-instrument/practice correlation,
   provider-cost budgets and lending circuit breakers (S-07).
4. Block arbitrary push destinations at both registration and send time and purge
   unsafe stored endpoints (S-03).
5. Keep the restored security regression coverage mandatory and prevent its
   rate-limit fixture contract from drifting again (S-08).

### Fix before launch

1. Remove or isolate vulnerable XLSX parsing; CSV-only is the lowest-risk option
   (S-06).
2. Add the database bill-amount sanity constraint (S-05).
3. Merge signature values before final sanitisation and add regression cases (S-04).
4. Perform a deployment evidence review: Supabase auth settings, service-key scope
   and rotation, backups/PITR, Vercel access, third-party webhook URLs/secrets,
   Google key restrictions, outbound egress, log access/retention and alert delivery.
5. Define and test a refund state machine before enabling any refund UI/API.

### Improve after launch

1. Move inline styles into nonce-capable stylesheets and remove CSP `unsafe-inline`
   for styles; collect CSP/authorization/rate-limit metrics with privacy-safe fields.
2. Add recurring incident-response exercises for admin takeover, webhook-secret
   rotation, duplicate provider events, payout reconciliation and KYC-provider outage.
3. Add SAST/secret scanning, dependency review gates with an exception process, and
   scheduled adversarial tests for RLS, direct PostgREST access and concurrent money
   transitions.
4. Review data minimization, retention, subject-access/export controls, deletion,
   encryption-key rotation and privileged PII access against POPIA requirements.

## Fix-verification release gate

A release should require: the complete test suite; typecheck; build; RLS migration
replay and live drift comparison; direct PostgREST negative tests for every protected
table; concurrent credit/payment/payout tests; webhook forged/stale/replay/amount
tests; password-only privileged-action rejection; KYC/provider failure tests; bot
velocity simulations; secret/history scan; and a dependency audit with documented
exceptions. Production/third-party smoke tests must use approved sandbox accounts
and must never be run by this local audit suite.
