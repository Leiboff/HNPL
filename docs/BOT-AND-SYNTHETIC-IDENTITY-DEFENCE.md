# Bot and synthetic-identity defence

_Added 2026-09-02. Read `lib/security/identityGraph.ts`'s header first — it
carries the reasoning; this file is the map._

## The gap this closes

Every identity control in HNPL before this change judged **one applicant in
isolation**:

| Control | Answers |
|---|---|
| DHA / Datanamix registry query | Is this ID number real and live on the register? |
| Liveness | Is a physical human present? |
| Face match | Is that human the one the register has a photo of? |
| `sa_id_lookup_hash` (0096/0097) | Has this ID been used for an account already? |
| `claim_credit_for_plan` (0130) | May **this profile** borrow this much? |

Against a *fabricated* identity that stack is genuinely hard to beat, and it
remains the primary control. It is also, by construction, blind to the
attack that actually scales in this market — because that attack fabricates
nobody.

The going rate for renting a real South African identity is a few hundred
rand. The holder appears in person, passes liveness, passes face match,
signs, takes the cash, and walks. Every check returns green, **correctly**.
Run it forty times and the operator has forty verified borrowers and forty
credit limits.

Nothing in the system could see that those forty arrived together, because
the fraud is in the *relationship* between applications and no single
application's record contains a relationship.

## What was built

```
       signup ─────────────────► botSignals.ts        (front door: automation)
                                        │
proxy.ts mints hnpl_did cookie ─► correlationKeys.ts  (keyed, one-way link keys)
                                        │
                                identitySignals.ts    (I/O: record + fetch)
                                        │
                              ┌─────────┴─────────┐
                     identity_signals (0136)   identityGraph.ts
                     append-only ledger        (pure: is this a ring?)
                                        │
                     claimCredit.ts ringGate ──┘   ← the money door
```

| File | Role | Pure? |
|---|---|---|
| `lib/security/botSignals.ts` | Scores automation at signup | yes |
| `lib/security/correlationKeys.ts` | HMAC blind-index keys (device/ip/subnet/email/phone/card) | yes |
| `lib/security/identityGraph.ts` | **The ring detector.** Links → verdict | yes |
| `lib/security/deviceCookie.ts` | Opaque device id, minted in `proxy.ts` | yes |
| `lib/security/identitySignals.ts` | Records signals, fetches link counts | I/O |
| `lib/security/requestSignals.ts` | Assembles one request's context | I/O |
| `supabase/migrations/0136_…sql` | Ledger + `count_identity_links` RPC | — |
| `supabase/migrations/0137_…sql` | Identity promotion + practice concentration | — |
| `lib/underwriting/claimCredit.ts` | `ringGate` — the enforcement point | I/O |

## The three commitments that shape the thresholds

Smartphone sharing is **ordinary** in this market, not exceptional. A rule
that flagged the second identity on a device would fire overwhelmingly on
families, and the consequence of firing is a patient refused medical credit
at a counter with no explanation they can act on. That harm is invisible in
aggregate — the refused patient simply leaves — and lands hardest on exactly
the low-income users this product exists for.

So:

1. **Generous per-kind tolerances.** Sharing is priced as normal up to a
   threshold set from how households actually behave. Four identities on a
   device is a family. Nine is not.
2. **Corroboration before consequence.** No single kind of link, at any
   volume, can reach the blocking band alone. A ring leaks on several
   independent axes at once; a household leaks on one. Enforced
   structurally, not by threshold tuning — no choice of weights can
   distinguish a 500-identity carrier NAT from a 9-identity device ring.
3. **Time clustering is the discriminator.** A family accumulates on a
   device over months; an operator works a stack of rented IDs in an
   afternoon. Recency *multiplies* rather than adds.

`identityGraph.test.ts` writes the household cases **first** and treats them
as the binding constraint.

## Phase 1 boundary — deliberate

`ringGate` refuses on **`block`** only. A **`review`** verdict is logged and
**let through**.

This follows the precedent migration 0096 set for `sa_id_lookup_hash`: the
mechanism lands first, and the consequence waits until a human has seen what
the mechanism actually catches. A `review` verdict is only meaningful if
something reviews it, and there is no plan-review queue today — the same
trade `lib/onboarding/dhaVerification.ts` names when it says its review
route is acceptable only if the queue is staffed.

**The condition for flipping it**, stated so it is a decision and not a
drift: once the `[ring-gate]` alerts have run against real traffic long
enough to know the false-positive rate on `review`, and once a human queue
exists to receive them, `review` should refuse too.

## Deployment requirements

### 1. `CORRELATION_HMAC_KEY` (new, required for the control to do anything)

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Server-only. Must **never** be stored in the database — it is the only thing
standing between a stolen ledger and a reversible one (a bare SHA-256 of an
IPv4 address is a 2^32 brute-force; keyed, it is not attackable).

**Without it the system fails SAFE, not broken:** `keySignals` returns
nothing, recording no-ops, and assessment degrades to `clear`. Signups and
checkouts are unaffected. Ring detection is simply off — and silently, so
set the variable before relying on the control.

### 2. Migration `0136_identity_correlation_signals.sql`

Adds `identity_signals` (RLS on, no policies, service-role-only RPCs).
Verified end-to-end against real Postgres by
`0136_identity_correlation_signals.rpc.test.ts`.

### 3. Retention

`delete_expired_identity_signals(180)` should run on the same schedule as
0124's rate-limit reaper.

## Privacy posture

The ledger holds **no raw values** — no IPs, no User-Agents, no phone
numbers. Every `signal_hash` is an HMAC-SHA256 under
`CORRELATION_HMAC_KEY`, the same construction `profiles.sa_id_lookup_hash`
already uses. The database can tell that two rows match; it cannot tell what
they matched on.

The device id is an **opaque random value in a first-party httpOnly cookie**,
explicitly *not* a browser fingerprint — no canvas, font, WebGL or audio
probing. Those are more durable and were rejected: for a healthcare product,
a durable cross-site identifier attached to people seeking medical credit is
a category of data we should not create, and an attacker running a fresh
browser profile per identity defeats both anyway.

## Known limitations, stated plainly

- **A competent attacker driving a real browser at human pace defeats
  `botSignals` entirely.** That is the expected outcome. The job is to price
  the attack, not to stop it — the cheap version (curl in a loop, a default
  headless build, a replayed POST) fails.
- **Clearing cookies breaks the device link.** Expected. The detector is a
  set of independent axes precisely because each is individually evadable;
  an operator who clears cookies still shares a card, a network and a tempo.
- **`payment_methods.signature` is not an issuer fingerprint.** Peach
  exposes none, so it is synthesised as `brand:last4:expiry` — roughly two
  million buckets, so unrelated strangers *can* collide. This is why the
  card allowance is 2 rather than 0.
- **The first members of a ring are recorded but not caught**, because there
  was nobody ahead of them to match. Correlation cannot correlate a first
  observation. The ring is caught partway through.
- **A disciplined operator can stay under it.** Breaking one axis drops
  below the corroboration rule: clear cookies between identities (device
  gone) and use one prepaid card each (card gone) leaves only `ip`/`subnet`,
  which are capped below the review bar by construction. Batching ≤4
  identities per device stays inside the household allowance indefinitely.
  This control raises cost and catches sloppy or large rings; it is not a
  wall against a disciplined small-batch one.
- **The SA ID sequence-adjacency signal was removed, deliberately.** Batch-
  issued IDs hold near-adjacent sequence numbers, which would be real
  corroboration — but computing it needs plaintext SA IDs at claim time, and
  the ledger holds only keyed hashes precisely so that comparison is
  impossible. Shipping it as an unproduced parameter would have been worse
  than not having it. Doing it properly means computing the neighbour count
  at identity-submit time (where plaintext is briefly in hand, via a
  ±3 window of blind-index probes) and persisting the count on the profile.
  That is a viable design, not a closed door — it is simply not built.
- **No payout velocity cap.** Concentration is now *detected* on the patient
  side, but nothing bounds the value or rate of payouts to a single practice.
  See below.
- **Assessment fails open.** An attacker who can break the ledger query can
  suppress detection. Acceptable for a first deployment (it is not the only
  or primary control, and a total failure would refuse every patient at
  every practice); it should be revisited once calibration data exists. The
  `degraded` flag distinguishes "no ring found" from "could not look" so
  that day is detectable.
