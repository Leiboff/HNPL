# Referrals

> Built 2026-09-06. **The infrastructure exists. The incentive programme does
> not.** This document is the map of what is here, what deliberately is not,
> and the five decisions somebody has to make before a reward can be paid.

---

## 1. What a patient can do today

Two things, from **Account → Refer a friend** (`/patient/refer`):

| | Refer a friend | Refer a practice |
|---|---|---|
| Who it is | A person who could use betternow | Rooms that should offer it |
| How it lands | An email invitation, or the patient's own link | A `crm_leads` row, `source='referral'` |
| Attributed when | They create an account carrying the code | Never automatically — a rep works the lead |
| Converts when | *(not yet wired — see §6)* | *(not yet wired — see §6)* |

Every patient also gets a code — eight characters, minted on first view of the
screen — and a link, `https://…/?ref=CODE`.

## 2. The pieces

```
lib/referrals/
  code.ts         mint / normalise a code. Alphabet mirrored in 0145's CHECK.
  vocabulary.ts   kinds, channels, statuses, labels. Mirrored in 0145's CHECKs.
  link.ts         the ?ref= parameter, the share link, the share message.
  attribution.ts  the cookie name and its posture.
  claim.ts        who gets credited, and the five refusals. No database.
  store.ts        the PostgREST half of claim.ts.

proxy.ts                              captures ?ref= into a cookie; spends it
                                      on the first authenticated request.
app/patient/refer/                    the screen and its three server actions.
app/api/cron/referral-maintenance/    daily expiry + POPIA scrub.
lib/email/templates/referralInvite.ts the one email a stranger receives.
supabase/migrations/0145_…            referral_codes, referrals, the guard
                                      trigger, prune_referral_invites().
```

## 3. How an attribution actually happens

```
friend taps  https://app…/?ref=A2C4K9PT
      │
      ▼
proxy.ts  ── document navigation only, first code wins ──▶  cookie hnpl_referral
      │                                                     (httpOnly, lax, 30 days)
      ▼
… landing page, signup, email OTP, four onboarding steps …
      │
      ▼
first authenticated request  ──▶  claimReferral()
      │
      ├── the code is live, is not theirs, the account is new,
      │   and nothing has claimed it before   ──▶  referrals row, status signed_up
      │
      └── otherwise: malformed / unknown_code / self_referral /
          already_attributed / account_too_old   ──▶  cookie dropped, nothing written
```

Attribution is **write-once**, enforced by a unique index rather than by the
application reading before it writes: the proxy claims on every authenticated
request, so concurrent requests genuinely race.

## 4. Who can write what

`referrals` and `referral_codes` have **SELECT policies and no write policies
at all**. A patient reads their own rows and can change nothing; a platform
admin reads everything. Every write goes through a Server Action on the
service-role client, which re-verifies the caller's role and builds the row
itself.

This is deliberate and it is the lesson of audit findings R3-01 and R3-02: a
user-reachable INSERT policy constrains *which row* you may write, never *what
is in it*, and a referral row decides who gets credited for a customer.

## 5. Personal information

A referral invitation holds a name and an email address for somebody who is
not a customer and never asked to hear from us. That is lawful as a referral
and stops being lawful once the invitation is dead.

`prune_referral_invites()` (0145), run daily by
`/api/cron/referral-maintenance`:

- **expires** a pending invitation past its 30-day window;
- **scrubs** the name, address, phone and note off invitations that have been
  dead for 90 days — keeping the referral row, which is the referrer's record
  that they made a referral, and losing the part with a person attached.

The email itself names the referrer's first name only, promises nothing, and
carries a route to have the address removed.

## 6. What the incentive programme has to decide

The seam is one column: **`referrals.qualified_at`**. Nothing in this
repository writes it. It exists so that a programme launched later can be
applied to referrals that already happened, which is the one thing that cannot
be fixed retrospectively.

Five decisions, none of which this work makes:

1. **What qualifies.** A friend signing up? Their first plan going active?
   Their first instalment clearing? The third? Each moves the fraud surface
   and the cost. For a practice: a signed agreement, or approved and trading?
2. **What is paid, and to whom.** A credit against the referrer's next
   instalment is the cheapest to build (the credit machinery exists —
   `claim_credit_for_plan`, 0130) and the most awkward for a referrer with no
   open plan. Cash needs a payout rail, a tax position, and an FSP
   conversation.
3. **Caps.** Per referrer, per period, in total. Without one, the programme's
   cost is unbounded by construction.
4. **Clawback.** A referred customer who defaults, or a referral later found
   to be self-dealing. `status='void'` is reachable from any state precisely
   so this is possible; what it should *do* is undecided.
5. **Fraud.** The correlation store (`evaluate_risk`, 0142) already joins
   device, card, identity and network across accounts. A referral programme is
   the classic reason a ring exists, so `referral_claim` probably belongs in
   `risk_known_event` — that is a migration and a policy entry, not a guess to
   make now.

### What is already in place for whoever builds it

- Every referral is recorded from today, whether or not a reward exists.
- The lifecycle is guarded: a referral cannot walk backwards out of
  `converted`, and the timestamps are stamped by the database rather than by
  a call site that might forget.
- `converted_plan_id` / `converted_practice_id` are there to hold the evidence
  of what converted, so a payment can cite it.
- The rate-limit bucket (`referral_invite`) already bounds how fast referrals
  can be created.

### What is NOT in place

- Nothing sets `status='converted'`. A patient referral does not currently
  advance when the referred customer's first plan activates, and a practice
  referral does not advance when the practice is approved. Both are a hook in
  an existing path (`activateFirstInstalment`, `approvePractice`) and both
  were left out because "converted" is only meaningful once §6.1 is answered.
- No screen, anywhere, says a referrer will get anything.
