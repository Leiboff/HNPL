# Aggregate fraud and automated-abuse controls — operations

**Closes:** audit 2026-09-03 **S-07**, and the same finding carried in
2026-09-02 (§17, "bot and velocity controls, scorecard 2/10") and R3 (§12).

**Status of this document.** The repository half of S-07 is implemented. The
finding's own span-of-control note says effective implementation "also
requires fraud/risk policy, monitoring infrastructure, and operational
response" — this document is the handover for those three, and
[What is NOT in the repository](#what-is-not-in-the-repository) is the list of
what has to exist outside it before the controls are worth their thresholds.

---

## Why this exists

Every limit this system had before 0142 is **operation-local**.
`consume_rate_limit` (0124/0134) keys on one subject at a time — an IP, an
account, a token — and each of those is one rotation away from a fresh budget.

The loss chain the audit describes is made entirely of individually valid
requests:

```
automate signup → OTP → KYC across many identities → the unconditional
stub limit → a colluding or compromised practice → first payment →
merchant payout → default on the remaining instalments
```

Nothing in endpoint authorization, webhook signatures or the atomic credit
claim (0130) is wrong, and none of them see this. What was missing is a single
place where the dimensions are **joined**: the same device across nine
accounts, the same card fingerprint across four identities, one practice
receiving every new customer on the platform this week.

---

## The shape of it

| Piece | Where | What it does |
| --- | --- | --- |
| Correlation store | `risk_observations` (0142) | One row per observed (event, dimension, token). The velocity graph is two aggregates over it. |
| Decision function | `evaluate_risk` (0142) | Locks every supplied token, records, evaluates the rules, spends the budgets, returns allow / friction / review / deny. |
| Policy | `lib/risk/policy.ts` | Every threshold, with the reasoning for each. The single place a number is tuned. |
| Tokenisation | `lib/risk/tokens.ts` | Keyed HMAC of every correlation identifier. No raw identifier is ever stored. |
| Entry point | `lib/risk/evaluate.ts` | One `await` at each call site, beside the existing rate-limit bucket. |
| Review queue | `risk_reviews`, `/admin/risk` | Manual-review states, deduplicated to one open row per (account, event). |
| Budgets | `risk_budget_usage` | Daily platform ceilings on KYC, SMS, bureau, payment, payout and new credit. |
| Kill switches | `risk_kill_switches`, `/admin/risk` | Four platform-wide stops, effective on the next request, no deploy. |
| Circuit breakers | `practice_risk_posture`, `trip_practice_circuit_breaker` | Per-practice exposure, payout, new-customer and first-payment-rate holds. |
| Monitor | `/api/cron/risk-monitor`, daily 23:30 UTC | Evaluates the breakers and enforces retention; Wednesday's pass precedes Thursday batching by 30 minutes. |
| Notifier | `/api/cron/risk-alerts`, every 15 min | Emails the digest to the admin address, exactly once per finding. |
| Dashboard | `/admin` attention list | Held reviews, held practices, engaged switches and budget pressure, above every other item. |

### The dimensions, and why each one is there

Each is an attribute a ring must rotate to stay invisible. The set is chosen
so that rotating any single one is not enough.

| Dimension | Rotation cost to an attacker |
| --- | --- |
| `account` | One signup. The weakest, and the one every previous limit keyed on. |
| `identity` | A leaked SA ID per identity. The duplicate-identity edge. |
| `phone`, `email`, `email_domain` | A number per identity; a mailbox provider per campaign. |
| `ip` | A proxy hop. Free. |
| `subnet` | A different allocation. Cheap but not free. |
| `asn` | A different network operator. Real money. |
| `network_class` | A residential proxy pool instead of a data centre. Real money. |
| `device` | Discarding cookies between accounts — loses session continuity and re-solves every step-up. |
| `kyc_session` | A distinct face per identity. |
| `card` | A genuinely distinct instrument per identity. The hardest. |
| `bank_account` | A distinct payout destination per shell practice. |
| `practice`, `practice_group`, `provider` | A distinct colluding merchant. |
| `customer_merchant` | The edge itself — one customer's repeat volume at one practice. |

`network_class` is recorded **only** when it is `hosting` or `proxy`. Those are
findings; `residential` and `unknown` are absences, and recording them would put
the platform's entire legitimate traffic under one shared token — at which point
a rule sized for "40 requests from data centres in an hour" holds every customer
for review on the first busy morning. On a deployment with no IP-intelligence
feed every request is `unknown`, so the class rules simply do not apply. That is
the honest answer, and it is why item 1 of
[What is NOT in the repository](#what-is-not-in-the-repository) matters.

### The one number that matters most

`max_accounts`, not `max_events`. Event rates are what the existing per-operation
buckets already do well. **How many distinct accounts share this device, this
card, this identity, this payout destination** is the thing no per-operation
limit can express, and it is what a ring cannot keep at one without paying for
separate infrastructure per identity.

---

## Privacy and POPIA

**No raw correlation data is stored, anywhere.** Every value in
`risk_observations.token` is a keyed HMAC computed in the application
(`lib/risk/tokens.ts`). The store can answer *"are these two accounts the same
device"* and cannot answer *"what device is this"*.

Two consequences worth stating to a reviewer:

- The SA ID blind index (0096) is **re-tokenised** under the risk key even
  though it is already an HMAC, so `risk_observations` is not joinable to
  `profiles.sa_id_lookup_hash`. A correlation store that can be joined back to
  the identity table is a re-identification database.
- Re-keying (`RISK_CORRELATION_HMAC_KEY`) erases the graph. That is a
  legitimate privacy operation and it needs no schema change.

### The device identifier

A first-party cookie (`hnpl_dv`) holding 128 random bits **we** generated. A
label we issued, not a measurement of the visitor's machine.

Explicitly **not**: canvas or WebGL hashing, font or plugin enumeration,
screen/timezone entropy, audio-context fingerprinting, or any other technique
that identifies a person across sites they never consented to be linked
across and cannot clear.

The accepted cost: clearing cookies gets a new token, and so does a private
window. That is why no event keys on device alone.

`httpOnly`, `secure` in production, `sameSite=lax`, 180-day max age.

### Retention

Enforced by `prune_risk_data`, called nightly by `/api/cron/risk-monitor`.

| Table | Retention | Why |
| --- | --- | --- |
| `risk_observations` | **90 days** | The correlation graph. Long enough to see a ring pacing itself across a month; short enough that it is not a permanent record of who shares a household router. |
| `risk_events` | **180 days** | Decision evidence, for disputes and for showing a regulator the control fired. |
| `risk_blocks` | Deleted once expired | They enforce nothing after that. |
| `risk_budget_usage` | 400 days | Aggregate counters with no subject in them at all. |
| `risk_reviews` | **Never pruned on a timer** | Decision records about people. Deleting them would destroy the trail that makes the decisions accountable. Their lifecycle belongs with the account's. |

### For the ROPA / privacy notice

> **Purpose:** prevention and detection of fraud and automated abuse of a
> credit product.
> **Data:** keyed one-way tokens derived from account, identity index, phone,
> email, IP, device cookie, payment-instrument fingerprint, payout account and
> practice; no raw identifier is retained.
> **Retention:** 90 days for correlation records, 180 for decisions.
> **Lawful basis:** legitimate interest in preventing credit fraud, balanced
> by tokenisation, minimisation, and a manual-review path so no adverse
> decision is taken by automated means alone.

The last clause is what the review queue is for. **Do not remove it and leave
`deny` as the only refusal.**

---

## Operating it

### The four decisions

| Decision | What the caller does | What the customer sees |
| --- | --- | --- |
| `allow` | Proceeds. | Nothing. |
| `friction` | Proceeds only through a step-up the surface already offers. A surface with none treats this as allow-and-alert. | Nothing, or a step-up they have already seen. |
| `review` | Stops. A queue row exists. | "We need to check a few details… our team will be in touch." |
| `deny` | Refuses. | "We can't continue with this request right now." |

`review` copy deliberately does **not** read as a refusal — the subject may
well be a customer whose household shares a router with three relatives.
Neither message names a threshold: a refusal that names its rule is a tuning
oracle.

### The review queue — `/admin/risk`

Worst first (by score, then recency), not oldest first. Leaving a
duplicate-identity review for an hour costs a plan that will never be
collected; leaving a busy-practice review costs a mildly annoyed receptionist.

Three actions:

- **I'm looking at this** (`in_review`) — claims it. Not an outcome.
- **Clear** — the subject transacts normally again. *Does not erase the
  observations.* A cleared account whose device later appears on nine more
  accounts is still countable.
- **Reject** — writes standing blocks (`risk_blocks`) that refuse the next
  request everywhere that token appears. **This is the step that makes the
  second visit cheaper than the first.** A queue where rejecting just closes
  the row produces no controls at all.

Every decision is attributed and lands in `admin_audit_log` (0048). A review
already decided cannot be re-decided — the first reviewer's attribution
survives.

### The kill switches

| Switch | Stops |
| --- | --- |
| `credit_issuance` | New credit being committed. Existing plans keep collecting. |
| `vendor_spend` | Paid KYC, SMS and bureau calls. Signup stalls at the affected step. |
| `payouts` | Every merchant payout release. |
| `signup` | New account creation. |

Read on **every** decision, so engaging one takes effect immediately and
without a deploy — which is the whole reason they are rows and not environment
variables. Engaging requires a critical-tier AAL2 factor and is two clicks;
releasing is one, because the expensive mistake is only in the engaging
direction.

A switch only stops the events that name it. `payouts` must not stop a patient
paying their instalment.

### Daily budgets

Environment-overridable so a ceiling can be tightened mid-incident.

| Budget | Env var | Default |
| --- | --- | --- |
| `kyc` | `RISK_DAILY_BUDGET_KYC` | 500 sessions |
| `sms` | `RISK_DAILY_BUDGET_SMS` | 2 000 units |
| `bureau` | `RISK_DAILY_BUDGET_BUREAU` | 500 lookups |
| `payment` | `RISK_DAILY_BUDGET_PAYMENT` | 5 000 charges |
| `payout` | `RISK_DAILY_BUDGET_PAYOUT` | R1 800 000 |
| `approved_credit` | `RISK_DAILY_BUDGET_APPROVED_CREDIT` | R250 000 |

`payout` is sized against a **week** of accrual rather than a day, because
payouts are batched weekly and the whole week settles on batch day. A ceiling
set to a day's worth would not be a fraud control, it would be a Thursday
outage.

**These defaults are launch-scale guesses and must be re-set against real
volume in the first fortnight.** Set them at roughly 3× the busiest honest day
you have measured. Too high and they never fire; too low and they become an
outage nobody can distinguish from an attack.

A refused request never spends the budget — a denied call does not reach the
vendor, so charging it would let an attacker exhaust the platform's KYC
allowance using requests the platform itself rejected.

### Per-practice circuit breakers

Evaluated nightly by `/api/cron/risk-monitor` for every practice that traded
inside the window. The payout batcher also re-evaluates every candidate
practice synchronously and refuses to batch it when posture is unavailable or
breached, so best-effort cron delivery is not itself a money boundary.

| Metric | Env var | Default |
| --- | --- | --- |
| Open exposure | `RISK_PRACTICE_MAX_EXPOSURE` | R400 000 |
| Weekly payout | `RISK_PRACTICE_MAX_WEEKLY_PAYOUT` | R300 000 |
| New platform customers | `RISK_PRACTICE_MAX_NEW_CUSTOMERS` | 120 |
| First-payment rate | `RISK_PRACTICE_MIN_FIRST_PAYMENT_RATE` | 0.6 (min sample 10) |
| Window | `RISK_PRACTICE_WINDOW_DAYS` | 7 |

**One breach parks the practice for a human** (`review`). **Two or more at once
stop payouts** (`deny`). The honest large practice and the mule look identical
on any single metric; nothing legitimate produces exposure *and* a collapsed
first-payment rate at the same time.

The first-payment rate is the sharpest and cheapest signal here: a real
practice's plans almost all clear instalment 1, because the patient is standing
at the counter with their own card.

---

## Alerts

`lib/risk/alerts.ts` gives every reason a stable name so an alert, a runbook
section and a finding all use one word for one thing.

**Page:**

| Alert | Meaning |
| --- | --- |
| `duplicate_identity` | One SA ID or KYC session under more than one account. |
| `duplicate_instrument` | One payment card under several accounts. |
| `budget_exhausted` | A daily platform ceiling is spent. |
| `kill_switch` | A switch is refusing traffic. |
| `control_unavailable` | The decision could not be taken; requests are being refused. |

**Ticket:** `duplicate_device`, `identity_velocity`, `merchant_velocity`,
`customer_merchant_link`, `network_velocity`, `standing_block`.

Nothing pages on a busy practice or a busy network, deliberately. An alert that
pages on a Monday-morning dental practice is muted within a week — and the
duplicate-identity page is muted along with it.

### The digest

`/api/cron/risk-alerts` runs every 15 minutes and emails **one** message
covering everything nobody has been told about yet: newly held reviews, the
decisions behind them, engaged kill switches and any budget at or above 80%.

| Property | Behaviour | Why |
| --- | --- | --- |
| Recipient | `RISK_ALERT_EMAIL` → `ADMIN_NOTIFICATION_EMAIL` → **`admin@betternow.co.za`** | Falls back to a real address rather than skipping the send. A missed practice signup is a delayed approval; a missed duplicate-identity page is a loss. |
| Cadence | every 15 min | Nothing waits on it — every decision it reports was already enforced. Sending from the decision path would put an 8-second mail timeout in front of a customer's payment, and would send one email per finding (four hundred, for a ring working a list). |
| Exactly once | `claim_risk_notifications` (0143) stamps and returns in one statement | Two overlapping runs cannot both send. Waking somebody twice at 03:00 is how a channel gets muted, and a muted channel looks like coverage while providing none. |
| Quiet when quiet | no email when there is nothing to report | An "all clear" every 15 minutes earns a mail rule on day two, which then swallows the real alerts. |
| `[URGENT]` prefix | engaged kill switch, exhausted budget, page-severity finding, or the controls unable to decide | Restraint is the design. A subject that shouts on a busy dental practice trains the reader to stop looking. |
| Contains no tokens | rule names, counts and thresholds only | An email lands in a mailbox and a mail provider's logs, neither of which has the 90-day retention that makes the real store defensible. |

A send that fails outright releases its claim, so the batch returns to the
next digest instead of being lost. A crash *between* the claim and the send
loses one digest — the safer of the two orderings, and recoverable, because
the rows stay in `risk_events` / `risk_reviews` and on `/admin/risk`.

### On the dashboard

`/admin` shows risk items at the **top** of its attention list, above pending
practices and overdue collections:

- engaged kill switches (customers are being refused right now);
- exhausted daily budgets, then budgets above 80%;
- subjects held for review;
- practices held by the circuit breaker.

An operator reading "3 practices awaiting approval" above "new credit is
switched off" has been told the wrong thing first, which is why the ordering
is fixed rather than by severity tone.

### The log lines to collect

All JSON, one per line, on the shape `lib/security/rateLimit.ts` established.

| `event` | Where | Watch for |
| --- | --- | --- |
| `risk_decision` | every non-allow decision | `outcome: "unavailable"` — the controls are down and everything is being refused. `outcome: "unknown_event"` — the vocabulary drifted and a surface is unevaluated. |
| `risk_practice_breaker` | the nightly monitor | any occurrence |
| `risk_kill_switch` | `/admin/risk` | any occurrence |
| `risk_monitor_held_practices` | the nightly monitor | any occurrence |
| `risk_digest_send_failed` | the notifier | any occurrence — the controls are working, the queue is filling, and nobody is being told |
| `risk_digest_sent` | the notifier | `severity: "urgent"` |
| `affordability_unavailable` | the credit-check step | expected until the real check is live; unexpected after |
| `rate_limit_decision` | the existing limiter | unchanged |

No line contains a correlation token. A log carrying tokens would re-create the
joinable store inside the log aggregator, with none of the retention controls
that make the real one defensible.

---

## Configuration

| Variable | Required | Notes |
| --- | --- | --- |
| `RISK_CORRELATION_HMAC_KEY` | Strongly recommended | Falls back to `SUPABASE_SERVICE_ROLE_KEY`. Set a dedicated one so the graph can be re-keyed independently. |
| `RISK_HOSTING_ASNS` | Optional | Comma-separated, e.g. `AS16509,AS14061`. |
| `RISK_HOSTING_CIDRS` | Optional | Comma-separated CIDRs, v4 and v6. |
| `RISK_PROXY_CIDRS` | Optional | As above. |
| `RISK_DAILY_BUDGET_*` | Optional | See the budget table. |
| `RISK_PRACTICE_*` | Optional | See the breaker table. |
| `RISK_ALERT_EMAIL` | Optional | Defaults to `ADMIN_NOTIFICATION_EMAIL`, then to `admin@betternow.co.za`. |
| `RESEND_API_KEY`, `RESEND_FROM` | Required for the digest | Already required by the other notification paths. Without them the digest logs `risk_digest_send_failed` and the queue is dashboard-only. |
| `CRON_SECRET` | Required | Already required by the other scheduled jobs. |

**With no key material at all the controls fail closed** — the surface is
refused rather than run unprotected. That is deliberate: a null token would
make every rule skip, turning a missing environment variable into "the fraud
controls are off" with no outward sign.

---

## Failure behaviour

Every event's `onUnavailable` is `deny`. If the risk RPC errors, times out
(3 s) or returns something unreadable, the surface refuses.

This matches `lib/security/rateLimit.ts`, which already fails closed on the
same surfaces — a database outage refuses signup today whether or not these
controls exist. Two components disagreeing about behaviour under failure would
produce a system whose failure mode nobody can state.

**The audit asks for fail-closed behaviour "without locking out normal
household/shared-network patterns". Those are different failures.** The first
is our dependency being down and is answered above. The second is our
thresholds being wrong, and is answered by keying on several dimensions at
once and by preferring `review` to `deny` on every shared-infrastructure
dimension. Both are covered in the suites:

- `supabase/migrations/0142_fraud_risk_controls.rpc.test.ts` — the adversarial
  matrix: one dimension rotated at a time, distributed IPs, back-to-back
  requests, budget races, review transitions, retention. **And the honest
  cases: a family of four on one router, a corporate NAT with 25 employees, a
  patient retrying a declined payment eight times, a couple sharing a card.**
- `lib/risk/evaluate.test.ts` — provider outages, timeouts, missing keys.
- `app/risk-wiring.test.ts` — every step of the loss chain is still gated, and
  the decision is taken before the irreversible step.

Run the repository-controlled adversarial gate with `pnpm test:fraud`. In
addition to unit and wiring coverage, it drives complete ring scenarios
against the real migration and production policy: rotation of cheap identity
attributes, clean-browser/residential-IP rotation that converges on a shared
card, and full signal rotation that can only be bounded by the global credit
budget. The database test uses PGlite, whose single connection cannot prove
cross-session blocking; the suite separately pins the sorted advisory locks
and atomic budget statement. A production-equivalent multi-session exercise
remains a deployment release check, not something this repository should run
against live customer data.

---

## What is NOT in the repository

The audit's span-of-control note, made concrete. **The thresholds are only as
good as these.**

1. **An IP-intelligence feed.** `asn` and `network_class` come from
   `x-vercel-ip-asn` plus operator-maintained lists, and are `null` /
   `'unknown'` without them — and an `unknown` class is not recorded at all,
   so those rules do not fire either way. `lib/risk/network.ts` does not guess: an ASN from
   a stale table is worse than no ASN, because the rule fires on the wrong
   subject. Until a feed is wired, the subnet and device rules carry the
   weight.
2. **A pager, if you want one.** Findings now reach `admin@betternow.co.za`
   by email within 15 minutes and appear on `/admin` immediately — that is
   implemented. What is still outside the repository is anything that wakes
   somebody at 03:00: the digest marks urgent items `[URGENT]` in the
   subject, but turning that into a phone call is a mail-rule or
   pager-integration decision, not a code one.
3. **Somebody who reads the email.** `review` is only defensible as a
   decision if a person actually works `/admin/risk`. Target a first response
   inside one business day; a queue that is never emptied becomes a `deny`
   with extra latency, and at that point the POPIA argument in this document
   stops being true. The notification removes the excuse of not knowing — it
   cannot supply the person.
4. **Threshold tuning against real volume.** Every number in
   `lib/risk/policy.ts` carries its reasoning, and every one is a launch-scale
   estimate. Review after two weeks of live traffic and then monthly.

   The three most likely to need raising first, because each sits closest to a
   legitimate busy day: `signup`/`email_domain` (80 an hour from one mailbox
   provider), `signup`/`subnet` (30 new accounts an hour from one /24), and
   `counter_session`/`practice` (150 distinct patients billed in a day). Each
   is `review` rather than `deny` precisely because being wrong about them
   costs a human's time and not a customer's application.
5. **A fraud/risk policy document.** Who may clear a review, what evidence is
   required to reject, when a kill switch may be engaged and who is told.
6. **The credit check itself.** The R5,000 stub is **removed** — it granted
   an unconditional limit to every applicant, which is what made this loss
   chain worth running. `lib/underwriting/affordabilityPolicy.ts` is the seam
   the real check lands in; until it is configured it returns `unavailable`,
   no applicant receives a limit, and every plan acceptance is refused with
   assessment-pending copy. That is deliberate: a formula invented here would
   be an unsigned-off NCA affordability assessment, which is worse than a
   stub that announced itself.

---

## Adding a rule, a dimension or an event

The vocabulary is declared twice — in `lib/risk/vocabulary.ts` and in 0142's
`risk_known_event` / `risk_known_dimension` / `risk_known_budget`. That is
deliberate: the point is that the **database** refuses a name the application
did not declare, which it cannot do by reading the application.

`lib/risk/vocabulary.test.ts` pins the two against each other, so a name added
on one side and not the other fails the suite rather than going quietly
unevaluated. **A new name needs a migration and a change here.**

A new **rule** on an existing dimension is a change to `lib/risk/policy.ts`
alone. Give it a `rationale` — the test requires one, and the reason is that
whoever tunes it at 03:00 should not have to reconstruct your reasoning.
