# Peach Payments integration audit

**Read-only audit — nothing implemented.** Branch `audit-peach-integration`.
Goal: find any remaining field-shape / legacy-code bug of the same class as the
five already fixed (classifier success family, flat-vs-nested V2 status body,
stale `hnpl_co_` ref guard, top-level `paymentBrand`, add-card idempotency keyed
on time). Rank by severity, one-line fix + blast radius per item, **triage-only**.

Ground truth used: two real prod V2 status captures pinned in
`lib/payments/peach/client.test.ts` (checkouts `0ea34011…` and `03e9c095…`), the
form-encoded webhook fixtures, and Peach's docs (cited inline). Where neither a
captured body nor a doc could confirm a shape, it is marked **UNVERIFIED** — that
is itself a finding.

---

## Ranked punch-list (triage this)

| # | Sev | Finding | One-line fix | Blast radius |
|---|-----|---------|--------------|--------------|
| 1 | **P0 money** | `change_default_card` RPC writes the DEAD `plans.paystack_authorization_code`; collections read `plans.peach_registration_id`. "Change default card" / remove-default does **not** repoint future MIT charges — they keep hitting the old card — and the UI reports a bogus "N plans repointed" count. | New migration repointing the RPC onto `peach_registration_id` (mirror what 0078 did for `refresh_card_token`). | `change_default_card` RPC + its test; the Make-default and remove-default actions. 1 migration. |
| 2 | **P0 money** | MIT chain root: we stamp `plans.peach_initial_transaction_id` from the CIT payment's top-level `id` (sync + webhook) and send it as `standingInstruction.initialTransactionId` on every instalment 2+. Peach lists `cardholderInitiatedTransactionId` **and** `schemeTransactionId` on the successful CIT webhook — we read **neither**. Same class as the 5. | Capture `cardholderInitiatedTransactionId`/`schemeTransactionId` in `toPaymentStatus` + webhook, run one sandbox MIT to confirm which value Peach accepts as `initialTransactionId`, then stamp that. | Every instalment 2+ MIT on every multi-instalment plan. |
| 3 | **P1 money** | V2 body sends `allowStoredCards` on the saved-card one-click CIT. The `post_v2-checkout` OpenAPI documents `allowStoringDetails`, not `allowStoredCards`; V2 rejects unknown fields. Conflicts with our in-code citation of the checkout-tokenisation ref. | Confirm the exact field name against the tokenisation ref / a real one-click initiate log; rename if wrong. | `payWithSavedCard` saved-card first instalment (Flow B one-click). |
| 4 | **P2 same-class** | Webhook `handleCardRegistrationSuccess` reads `payload.customParameters?.SHOPPER_patientId` (nested), but `parseFormEventBody` produces the **bracketed-flat** key `customParameters[SHOPPER_patientId]` (no dot → never nested). Patient never resolves → card-reg webhook backstop silently no-ops. | Read the bracketed-flat key (mirror `payment-methods/complete/page.tsx`). | Flow B add-card **webhook backstop** only; the sync completion path already handles it. |
| 5 | P3 dead | `plans.payment_provider` + `payments.payment_provider` are `select`ed but never consumed; written only by DB default. Dead discriminator (the paystack-vs-peach branch was never wired). | Drop the selects, or wire the branch, or drop the columns. | Cosmetic; no behaviour. |
| 6 | P3 stale | `provider.ts:36-39` documents the ref format as `hnpl_co_<20hex>` etc — contradicts the live 16-char `bn<purpose><13>` scheme in `refs.ts` (which exists *because* those exceed Peach's 16-char cap → `800.100.156`). | Replace the comment with the compact-ref scheme. | Comment only; misleads a future dev into an over-length ref. |
| 7 | P3 dead | `hnpl_co_` / `hnpl_reg_` legacy-prefix OR-branches are now unreachable (`complete/page.tsx:154`, `webhook/route.ts:122,343`) — no legacy refs are minted. | Delete the OR-branches once no pre-0079 refs are in flight. | Harmless dead defensiveness. |
| 8 | P3 dead | MIT response echo `res.standingInstruction?.initialTransactionId` (`client.ts:595`) is returned in `ChargeResult` but never persisted/used by `chargeInstalment`. | Either persist it to reconcile/repair the root, or drop the read. | None today. |
| 9 | P3 stale | `TODO(dina)` money-path markers: `client.ts:312` (status field) and `:541` (status path) are effectively **resolved** by the two real prod captures; `:622` (refund entity) and `chargeInstalment.ts:195` (chain-root backfill) remain open. | Close the two resolved TODOs; keep :622 + chargeInstalment:195 on the triage list. | Comments / open questions. |
| 10 | P3 stale | `app/sw.js/route.ts` comments reference the removed `/api/webhooks/paystack`; verify the service-worker allow-list points at `/api/payments/peach/webhook`. | Update comment; confirm allow-list path. | SW caching only. |
| 11 | P3 dead | Dead columns with no reader and no writer: `plans.mandate_id`, `payouts.peach_payout_id`. | Drop in a cleanup migration. | None. |
| 12 | P3 smell | Refund webhook hardcodes `reason: 'card_registration'` on **every** refund and defaults `amount_cents` to `100` (R1) when `payload.amount` is absent. | Derive reason from context; don't invent an amount. | Refund bookkeeping rows only. |
| 13 | P4 style | Stale "Paystack" / "COPYandPAY" / "OPPWA" comments across many live files (code is correct; comments lie). Legacy test-only env scrubs (`PEACH_BASE_URL`, `PEACH_ENTITY_ID*`, `PEACH_ACCESS_TOKEN`). | Comment sweep. | None. |
| 14 | P4 data | Two `payment_methods` rows with `signature = NULL` (sandbox pollution from bug #4-of-5) + any still-unreconciled charged plans. | Add to the sandbox→live purge (already flagged in the prior fix). | Data only. |

---

## PART A — every Peach response field we read

### A1. V2 checkout status — `GET /v2/checkout/{id}/status` → `toPaymentStatus` (`client.ts:368`)

Read flat-or-nested via `pickField`. Ground truth: real prod captures `0ea34011…`
(`FLAT_SUCCESS_BODY`) and `03e9c095…` (`PROD_FLAT_BODY`).

| Field we read | Path/shape we assume | Peach's actual shape | Captured-log shape | Verdict |
|---|---|---|---|---|
| `result.code` | flat `'result.code'` or nested | flat dot-notation on status | `'result.code':'000.100.110'` | **MATCH** |
| `result.description` | flat/nested | flat | present in both captures | **MATCH** |
| `id` (providerPaymentId) | flat `'id'` | top-level | `id:'pay-flat-0ea3'` | **MATCH** |
| `merchantTransactionId` | flat | top-level | `bnc2b23vwkixm97y` | **MATCH** |
| `amount` | flat, `Number()*100` | string rands | `'92.00'` | **MATCH** |
| `registrationId` | flat top-level | top-level | `8ac7a49f…` | **MATCH** |
| `paymentBrand` | **top-level** `?? card.paymentBrand` | **top-level** (docs) | captures carry only `card.paymentBrand`; top-level pinned by synthetic fixture | **MATCH** (fixed bug #4) |
| `card.last4Digits` | under `card` | under `card` | `'0042'` | **MATCH** |
| `card.expiryMonth/Year` | under `card` | under `card` | `'12'/'2030'` | **MATCH** |
| `card.holder` | under `card` | under `card` | `'Jane Doe'` | **MATCH** |
| `card.binCountry` | under `card` | under `card` (docs) | not in captures | **UNVERIFIED** (display only) |
| `cardholderInitiatedTransactionId` | **not read** | present on success (docs) | not in captures | **MISSING** — see finding #2 |
| `schemeTransactionId` | **not read** | present on success (docs) | not in captures | **MISSING** — see finding #2 |
| `customParameters[...]` (sync page) | bracketed-flat key | bracketed-flat | `'customParameters[SHOPPER_patientId]':'usr-1'` | **MATCH** (sync page handles it) |

### A2. Recurring MIT charge — `POST /v1/registrations/{id}/payments` → `chargeSavedCard` (`client.ts:552`)

Parsed **directly as nested** (not via `pickField` — the /v1 surface returns nested).

| Field we read | Path we assume | Peach shape | Verdict |
|---|---|---|---|
| `result.code` | `res.result?.code` (nested) | nested on /v1 | **MATCH** (docs) |
| `result.description` | nested | nested | **MATCH** |
| `id` (providerPaymentId) | `res.id` | top-level | **MATCH** |
| `standingInstruction.initialTransactionId` (echo) | `res.standingInstruction?.initialTransactionId` | echoed on REPEATED | **UNVERIFIED** — no captured MIT body; and the value is **never persisted** (finding #8) |

### A3. Refund — `POST /v1/payments/{id}` → `refund` (`client.ts:614`) + webhook

`res.result?.code`, `res.id` — nested, **MATCH** by convention, **UNVERIFIED** against a captured refund body. Webhook `handleRefundSuccess/Failure` reads `payload.amount`, `payload.id`, `payload.result?.description` — MATCH; see finding #12 on the hardcoded `reason`/`amount` fallback.

### A4. Webhook events — `parseFormEventBody` (`webhook.ts:173`) + `route.ts`

Form-urlencoded, dotted names unflattened by splitting on `.`.

| Field | Assumed | Actual (fixtures/docs) | Verdict |
|---|---|---|---|
| `result.code` / `result.description` | dotted → nested | `result.code=…` | **MATCH** |
| `id`, `merchantTransactionId`, `amount`, `currency`, `paymentType`, `registrationId`, `checkoutId` | flat top-level | flat | **MATCH** |
| `paymentBrand` | `payload.paymentBrand ?? card.paymentBrand` | webhook carries `card.paymentBrand=…`; top-level tolerated | **MATCH** (fixed) |
| `card.last4Digits/expiryMonth/expiryYear/holder` | `card.*` dotted → nested | `card.last4Digits=…` | **MATCH** |
| `standingInstruction.initialTransactionId` | dotted → nested | `standingInstruction.initialTransactionId=…` | **MATCH** (has a dot → unflattens) |
| **`customParameters[SHOPPER_patientId]`** | **nested** `payload.customParameters?.SHOPPER_patientId` | **bracketed-flat** `customParameters[SHOPPER_patientId]=…` (no dot → NOT nested) | **MISMATCH** — finding #4 |
| `payload.id` as chain root (instalment-1) | top-level `id` | top-level | **MATCH** as a value; but semantically **UNVERIFIED** as the correct `initialTransactionId` — finding #2 |

---

## PART B — every Peach request body we send

### B1. `POST /v2/checkout` — `createCheckout` (`client.ts:415`)

| Field sent | Documented V2? | Notes |
|---|---|---|
| `authentication.entityId` | ✓ | |
| `nonce` | ✓ | required, unique per request |
| `merchantTransactionId` | ✓ | 16-char cap enforced at boundary |
| `amount`, `currency`, `paymentType` | ✓ | `amount` string rands |
| `createRegistration` | ✓ | |
| `shopperResultUrl` | ✓ | |
| `defaultPaymentMethod`, `forceDefaultMethod` | ✓ | card-only enforcement |
| `cardTokens` | ✓ | one-click |
| **`allowStoredCards`** | **✗ — not in OpenAPI** (documented name is `allowStoringDetails`) | **finding #3 — unknown-field-reject risk on the saved-card one-click** |
| **`requireCvv`** | **✗ — not documented** | **never sent today** (no caller sets it) → dead param, low risk |
| `standingInstruction` `{mode,type,expiry,frequency,numberOfInstallments,recurringType,industryPractice}` | ✓ (client whitelists; strips OPPWA-only `source`/`initialTransactionId`) | `frequency`/`numberOfInstallments` are **ints** (the `'0001'` string bug is fixed) |
| `customer` `{email,givenName,surname}` | ✓ | |
| `customParameters` (object) | ✓ | sent as JSON object on V2 (correct) |

### B2. `POST /v1/registrations/{id}/payments` — `chargeSavedCard` (`client.ts:552`)

`entityId`, `amount`, `currency`, `paymentType=DB`, `merchantTransactionId`, and
`standingInstruction.{mode=REPEATED, source=MIT, type=INSTALLMENT|UNSCHEDULED,
initialTransactionId}` — sent form-encoded (dotted). **MATCH** to the OPPWA recurring
schema (docs: subsequent MIT = `mode=REPEATED, source=MIT, initialTransactionId=<initial CIT id>`).
`source` and `initialTransactionId` are correctly on the **/v1** surface here (they are the
fields V2 rejects). Open question is *which* CIT value is the right `initialTransactionId`
(finding #2).

### B3. `POST /v1/payments/{id}` — `refund` (`client.ts:614`)

`entityId`, `amount`, `currency`, `paymentType=RF|RV`, `merchantTransactionId`. **MATCH**;
entity choice (recurring vs checkout) is an open `TODO(dina)` (`client.ts:622`).

### B4. `DELETE /v1/registrations/{id}` — `deleteRegistration`

`entityId` query param only. **MATCH**.

---

## PART C — legacy / dead / contradictory

- **Paystack schema still written:** `change_default_card` RPC (`0040:84`) — finding #1 (money). `refresh_card_token` was fixed by 0078; this sibling RPC was missed.
- **Dead discriminators:** `plans.payment_provider`, `payments.payment_provider` (selected, never consumed) — finding #5.
- **Dead columns (NEITHER read nor written):** `plans.mandate_id` (`0001:65`), `payouts.peach_payout_id` (`0001:93`) — finding #11.
- **Legacy-read-only (OK):** `refunds.paystack_refund_id` (admin display of historic rows).
- **Contradictory ref-format comment:** `provider.ts:36-39` — finding #6.
- **Unreachable legacy-prefix branches:** `complete/page.tsx:154`, `webhook/route.ts:122,343` — finding #7.
- **Removed-function references:** none dangling. `getCardRegistrationStatus` correctly gone (only negative-assertion tests). COPYandPAY module + `PeachCopyAndPayWidget` + `NEXT_PUBLIC_PEACH_WIDGET_URL` + `resourcePath` confirmed absent from live code.
- **Money-path TODO(dina):** `client.ts:312,541` (resolvable by captures), `client.ts:622`, `chargeInstalment.ts:195`, `provider.ts:284,301` — finding #9.
- **Env:** no PEACH_* used-but-undeclared or declared-but-unused. Legacy single-credential vars (`PEACH_BASE_URL`, `PEACH_ENTITY_ID*`, `PEACH_ACCESS_TOKEN`) appear only in test cleanup. (Observation: `.env.local` with live secrets is in the working tree — out of audit scope, noted only.)
- **SW comments** reference removed paystack webhook route — finding #10.

---

## PART D — strange / risky logic (judgment; bias to simplifying)

1. **Change-default writes a column nothing reads (finding #1).** The single biggest smell: the RPC's `WHERE paystack_authorization_code IS DISTINCT FROM …` compares a column the Peach save-path never maintains, so it "repoints" a dead column for (nearly) every plan on every call and reports a fabricated count, while the real token (`peach_registration_id`) is untouched. **Simplify:** one column is the token of record (`peach_registration_id`); every repoint path must write *only* that.
2. **Chain root threaded from `id`, not the scheme id (finding #2).** We assume the CIT's `id` is a valid `initialTransactionId`. A real prod MIT did succeed (`bnc3mywzpjoilcy7`, 2026-07-22, `000.100.110`), but we can't tell from the repo whether it used `INSTALLMENT+initialTransactionId` or the `UNSCHEDULED` fallback — so the assumption is unproven. **Simplify:** capture the two scheme ids Peach already sends and stop guessing.
3. **Deterministic-ref idempotency assumes Peach dedups on identical `merchantTransactionId`.** This is the whole no-double-charge guarantee for resume/retry, and it is **assumed, not verified** against Peach behaviour. **Action:** confirm once in sandbox (submit the same ref twice), then it's load-bearing-and-proven rather than load-bearing-and-hoped.
4. **Webhook card-reg backstop silently no-ops (finding #4).** A silent catch + a shape mismatch = the backstop looks wired but never fires. **Simplify:** one shared reader for `customParameters` used by both the sync page and the webhook.
5. **Refund webhook invents data (finding #12):** `reason:'card_registration'` on all refunds, `amount_cents … : 100`. Optimistic writes that will mislabel a future instalment refund. **Simplify:** don't write a field you didn't receive.
6. **Handler-threw returns 200 (by design).** Correct posture (avoids Peach retry storms) but pair it with the existing alertable log — verify that log is actually alarmed on, or a swallowed money-path error stays invisible.
7. **Two null-signature `payment_methods` rows** (sandbox) + any unreconciled charged plans → purge/reconcile (finding #14). Not enumerated in this pass beyond the two null-sig rows.

---

## PART E — the one structural recommendation: build the integration suite

**Verdict: yes, build it.** It is the highest-leverage change here — a field-extraction
suite pinned to the captured real bodies would have caught **all five** prior bugs and
would catch findings #2 and #4 now.

**Fixtures (all already in the repo, or one capture away):**
- `FLAT_SUCCESS_BODY` (`0ea34011…`) — real flat status.
- `PROD_FLAT_BODY` (`03e9c095…`) — real flat status **with bracketed-flat `customParameters`**.
- top-level-`paymentBrand` status fixture.
- `NESTED_SUCCESS_BODY` — nested-tolerance twin.
- webhook `EVENT_BODY_SUCCESS` (payment) + the registration form body (`customParameters%5B…%5D`).
- a decline body (`800.100.152`) and the `000.400.0xx` success family.
- **one new capture** of a successful CIT carrying `cardholderInitiatedTransactionId` + `schemeTransactionId`, and one MIT response — to pin the chain root (finding #2).

**Extractions to pin (~25–30 tests):**
- `classifyResultCode`: success (`000.000/100.1/3x/6x`), the `000.400.0[^3]`/`000.400.100` charged-review family, `000.400.03x` declines, pending (`000.200/100.400.500/800.400.5`), else reject.
- `toPaymentStatus`: every field, flat **and** nested, incl. top-level `paymentBrand` precedence and (new) the two scheme ids.
- `parseFormEventBody`: `result.code` unflatten, `standingInstruction.initialTransactionId` unflatten, **and a test that resolves `SHOPPER_patientId` from a real bracketed webhook body** (would fail today → finding #4).
- `saveCardForPatient` field mapping → non-null `peach:BRAND:last4:MMYYYY` signature.
- request-body shape guards: V2 body never contains `source`/`initialTransactionId`; V2 field-name check for `allowStoredCards` vs `allowStoringDetails` (finding #3); `frequency`/`numberOfInstallments` are ints.

Cost: ~1 file, ~30 tests, a few hours. It converts every "UNVERIFIED" in this document into a pinned, regression-proof assertion.

---

*End of audit. No code changed.*
