# Referrals

> Built 2026-09-06. Split into two buttons 2026-09-06. **The infrastructure
> exists. The incentive programme does not.** This document is the map of what
> is here, what deliberately is not, and the five decisions somebody has to
> make before a reward can be paid.

---

## 1. What a patient can do today

Two things, from **Account → Refer someone** (`/patient/refer`). The screen
opens on a choice — two buttons, not a tab strip — because the two sides share
an impulse and nothing else:

| | Refer a friend | Refer a doctor |
|---|---|---|
| Who it is | A person who could use betternow | A doctor whose rooms should offer it |
| Shareable? | **Yes, and that is all it is** — share sheet, WhatsApp, email, copy link | **No** — it is a lead form |
| How it lands | They open the link and sign themselves up | A `crm_leads` row, `source='referral'`, worked by a rep |
| Attributed when | They create an account carrying the code | Never automatically — a rep works the lead |
| Converts when | *(not yet wired — see §6)* | *(not yet wired — see §6)* |

Every patient gets a code — eight characters, minted on first view of the
screen — and a link, `https://…/?ref=CODE`.

**The asymmetry is the point.** A friend signs themselves up, so a link is the
whole mechanism and the friend side offers every way to send one: the system
share sheet (`navigator.share`) where the browser has one, and named WhatsApp
and email links where it does not — desktop Firefox, desktop Chrome without OS
integration, and most embedded webviews have no sheet, and a Share button that
silently does nothing is worse than no button.

There is **no form on the friend side and no server action behind it**. A
friend referral is written by the claim path when the friend actually arrives
(§3), never speculatively when a link is sent. An earlier version emailed an
invitation from a form; that form and the `referAFriend` action behind it were
removed together, because a `'use server'` export is an HTTP endpoint whether
or not anything renders it, and one that puts mail into an uninvolved person's
inbox has no business outliving the UI that justified it. Invitations already
in the database are unaffected — `claim.ts` still matches an arriving account
onto one, and `prune_referral_invites()` still expires and scrubs them.

A doctor cannot be referred by a link. There is no signup a code could be
carried into, and a link handed to a receptionist leads nowhere, so that side
renders no share affordance at all — it is a lead form and nothing else.
Migration 0145 says the same thing one layer down:
`referrals_link_is_patient_only` refuses a practice referral with
`channel='link'`.

**Doctor, not practice — and why the row still says `practice`.** What a
patient knows is their doctor. They may not know whether the rooms trade as
"Rosebank Dental" or as "Dr A Naidoo Inc", and asking for a practice name they
have never read was the most refusable field on the old form. So the form asks
for the doctor and treats the practice name as the optional extra it is.
`referrals.kind` stays `'practice'`, because the kind records what a referral
*converts into* — a merchant on this platform, with a `converted_practice_id`
beside it — not the label on the form.

Four fields are compulsory, refused in the form **and** again in
`referADoctor` (a Server Action is an HTTP endpoint; the form is a screen the
caller owns):

| Field | Why | Where it goes |
|---|---|---|
| Doctor's name | A lead nobody can be asked for is not workable | `contact_first_name` / `contact_last_name` via `splitFullName`, and `invitee_name` on the referral |
| Specialty | The shared register (`lib/specialties.ts`) through `SpecialtyOptions` — the same dropdown as CRM new-lead, practice signup and the public lead form | `crm_leads.specialty` |
| Phone | The rep's actual next action. This replaced an email-**or**-phone rule that produced leads with an address nobody answers. Landlines allowed — a switchboard is usually right | `crm_leads.phone`, normalised to E.164 |
| Address | What makes a lead findable, dedupable and mappable. Picked from Google Places through the shared `PlacesAutocomplete`, never typed free-hand | `street_address` / `suburb` / `city` / `province` / `latitude` / `longitude` / `formatted_address` |

Address is the one field a browser cannot validate: `PlacesAutocomplete` only
reports a place once it has been *chosen*, so typed-but-unpicked text never
reaches the form's state at all. Hence the explicit hint under the field, the
guard in `onSubmit`, and the server-side refusal. Coordinates are re-checked
against `lib/maps/saBounds.ts` — a real pick always lands inside the box, so a
pair that does not either came from somewhere other than the dropdown or names
a practice we cannot onboard.

Practice name, email and a note are optional. Where no practice name is given,
the doctor's name stands in: `crm_leads.practice_name` and 0145's
`referrals_practice_named` are both NOT NULL, and the doctor's name is what
the rep asks for on the phone — never a name we invented.

SMS is deliberately not a named channel: the URI takes a different separator
on iOS (`sms:&body=`) and Android (`sms:?body=`), so one href is wrong on one
of them — and both platforms have the share sheet, which offers Messages
properly.

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
app/patient/refer/                    the screen and its two server actions.
  ReferChoice.tsx                     the two buttons, and what hangs off each.
  ReferralShareCard.tsx               the friend side: code, link, channels.
  ReferDoctorForm.tsx                 the doctor side: the lead form.
app/api/cron/referral-maintenance/    daily expiry + POPIA scrub.
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

A referral holds a name, an address and a phone number for somebody who is not
a customer and never asked to hear from us. That is lawful as a referral and
stops being lawful once the referral is dead.

`prune_referral_invites()` (0145), run daily by
`/api/cron/referral-maintenance`:

- **expires** a pending invitation past its 30-day window;
- **scrubs** the name, address, phone and note off invitations that have been
  dead for 90 days — keeping the referral row, which is the referrer's record
  that they made a referral, and losing the part with a person attached.

Nothing on this surface emails the person being referred. The friend side
hands the patient a link to send themselves, and the doctor side says plainly
on screen that the referral goes to our team rather than to the practice.

## 6. What the incentive programme has to decide

The seam is one column: **`referrals.qualified_at`**. Nothing in this
repository writes it. It exists so that a programme launched later can be
applied to referrals that already happened, which is the one thing that cannot
be fixed retrospectively.

Five decisions, none of which this work makes:

1. **What qualifies.** A friend signing up? Their first plan going active?
   Their first instalment clearing? The third? Each moves the fraud surface
   and the cost. For a doctor: a signed agreement, or approved and trading?
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

- Nothing sets `status='converted'`. A friend referral does not currently
  advance when the referred customer's first plan activates, and a doctor
  referral does not advance when the practice is approved. Both are a hook in
  an existing path (`activateFirstInstalment`, `approvePractice`) and both
  were left out because "converted" is only meaningful once §6.1 is answered.
- No screen, anywhere, says a referrer will get anything.

---

## 7. When a referral did not land

Every refusal in §3 is silent by design at the *customer* layer — there is
nothing to show a visitor who arrived with a dead code, and nothing to show a
referrer about a friend who never signed up. That is correct, and it left the
whole path undiagnosable for an operator: five different refusals all present
as "nothing happened", and the cookie is deleted by the time anybody asks why.

So `proxy.ts` now logs one line per claim. Check them in order:

| Log line | What it means | What to do |
|---|---|---|
| *(nothing at all)* | The cookie never reached an authenticated request | The code was never captured — see the two capture rules below |
| `claim deferred — no profile row yet` | The account exists, its `profiles` row does not | Nothing; the next request retries. Repeating forever means the `on_auth_user_created` trigger is broken |
| `claim refused — claimant is not a patient` | A staff/practice/admin account tapped the link | Working as intended |
| `not attributed … outcome: self_referral` | Somebody opened their own link while signed in | Working as intended, and it is the commonest way a **test** of your own link appears to fail |
| `not attributed … outcome: account_too_old` | An existing customer tapped a friend's link | Working as intended: only accounts younger than `REFERRAL_INVITE_TTL_DAYS` are attributable |
| `not attributed … outcome: already_attributed` | Write-once: this account was already referred | Working as intended |
| `not attributed … outcome: unknown_code` | No live `referral_codes` row matches | The code was revoked, or **migration 0145 is not applied to this environment** |
| `claim threw outside claimReferral` | The role read or the service-role client failed | A real fault. `SUPABASE_SERVICE_ROLE_KEY`, or the database |

Two capture rules account for most of the "nothing at all" cases, and both are
deliberate (see the header of the referral block in `proxy.ts`):

- the code is only read on a **document navigation**, never on a fetch or an
  image request — otherwise any page on the internet could write this cookie
  with a code of its choosing;
- the **first code wins** — a cookie already holding one is not overwritten,
  which is the same rule the write-once index enforces one layer down.

**The environment check comes first, though.** Migrations in this repo are
applied to production deliberately, not by CI (see `docs/SECURITY-AUDIT-R3.md`
for the precedent). If `referral_codes` does not exist on the environment
being tested, `ensureMyReferralCode` fails and `/patient/refer` renders its
`referral-code-unavailable` notice — the friend side has no card behind its
button at all. That is what "the referral link does not work" looks like for
*every* account, not just one. `/api/cron/rls-drift` compares the repo's
migrations against the live catalog and is the fastest way to confirm it.
