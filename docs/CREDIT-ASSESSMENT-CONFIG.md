# Gated credit assessment — configuration

What to set for UAT and for live, plus the lifecycle defaults.
Everything here is read from the environment; nothing is committed.

## Point it at UAT first

The default is UAT. `EXPERIAN_ENVIRONMENT` must be set to `LIVE`
**explicitly** — an unset or misspelled value resolves to UAT, so the
failure mode of a bad deploy is "talks to the test bureau", not "bills
production enquiries".

| Variable | UAT | Live | Notes |
|---|---|---|---|
| `EXPERIAN_ENVIRONMENT` | `UAT` (or unset) | `LIVE` | Selects the host. Anything other than `LIVE` means UAT. |
| `EXPERIAN_USERNAME` | UAT service user | live service user | Sent as `pUsername`. Never in a repo file. |
| `EXPERIAN_PASSWORD` | UAT password | live password | Sent as `pPassword`, in cleartext in the SOAP body. See "Logging" below. |
| `EXPERIAN_ORIGIN` | `BetterNow` | `BetterNow` | `pMyOrigin` / `pOrigin`. Defaults to `BetterNow` if unset. |
| `EXPERIAN_ORIGIN_VERSION` | `1.0` | `1.0` | `pOriginVersion` on the affordability call only. |
| `EXPERIAN_SCORE_VERSION` | `4.0` | `4.0` | **Read the warning below before changing this.** |
| `EXPERIAN_SCORECARD_PREFERENCE` | `SU,STS` | `SU,STS` | Ordered. **Has direct commercial effect** — see below. |
| `EXPERIAN_ENQUIRY_TYPE` | unset | unset | No such parameter exists today. See "Enquiry type". |
| `ENABLE_CREDIT_CHECK` | `true` to test | `true` when you're ready | Off → no bureau call anywhere and no limit is granted. |
| `CREDIT_STALENESS_MONTHS` | `6` | `6` | Shorten in UAT to exercise re-assessment without waiting. |
| `CREDIT_DECLINE_COOLDOWN_MONTHS` | `3` | `3` | Shorten in UAT to re-test a declined applicant. |

Hosts are derived, not configured: `apis-uat.experian.co.za` for UAT and
`apis.experian.co.za` for live, both on **:443**. The REST endpoints on
:9443 answer `-204` on every request and are never constructed — a test
asserts no client source mentions the port.

## `EXPERIAN_SCORE_VERSION` selects the risk model

This is the one setting that can go wrong silently. `pVersion` does not
version the request format — it chooses which **scorecard family** the
bureau answers with, and each family has its own band cutoffs:

| Value | Family | Cards | Band table |
|---|---|---|---|
| `1.0` | CPA & NLR | `CPA`, `NLR` | spec §4.1 |
| `2.0` | Compuscore V3 | `CT`, `CU` | spec §4.2 |
| `4.0` | Sigma suite | `SS`, `SU`, `SBF`, `SRC`, `SCM`, `STS` | spec §5.3 |

Set it wrong and the call still succeeds, still returns a plausible
three-digit score, and gets banded against the wrong cutoffs —
mispricing every limit rather than failing. An unrecognised value throws
rather than defaulting to a family.

`4.0` is what the captured UAT call sent and what returned `SU`/`STS`.
Note it is **undocumented in the v2.1 integration PDF** (© 2021), whose
own table lists only `1.0` and `2.0`; the Sigma cutoffs come from §5.3 of
a later revision.

## `EXPERIAN_SCORECARD_PREFERENCE` is a pricing decision

One call returns several scorecards, and this list decides which one
bands the applicant. First card with a usable score wins.

The captured UAT applicant came back `SU = -1` (Sigma Unsecured Credit
cannot score them — no accounts open more than three months) and
`STS = 620` (Sigma Transcend, the thin-file card). With the default
`SU,STS` they are banded **Low Risk** off Transcend — and then capped at
**R1,000** by the Transcend cap below, rather than taking the R10,000 the
Low Risk band would otherwise allow.

So the fallback decides whether the applicant is *served at all*; the cap
decides *how much*. Both are pinned by tests.

### The Sigma Transcend cap

`SCORECARD_LIMIT_CAPS` in `lib/underwriting/coefficients.ts` caps any
limit decided by **STS at R1,000**, on top of whatever the band ceiling
allows. It is a versioned coefficient, not an env var — changing it forces
a `COEFFICIENT_VERSION` bump, so limits priced under the cap stay
distinguishable from limits priced without it.

The reasoning: Transcend scores people the traditional cards cannot, from
non-traditional data. Reading it serves applicants who would otherwise be
declined outright. But a Low Risk on the thin-file card is not the same
evidence as a Low Risk on Sigma Unsecured Credit, and should not buy the
same exposure.

The band still does its job — a Very High Risk on Transcend **declines**,
it is not capped to R1,000. We take the risk signal and refuse on it; we
just do not take the exposure when it says yes.

The assessment log records the true band, the band ceiling and the cap
separately, with `binding_constraint = 'scorecard_cap'` when the cap is
what bound. Counting how often that fires is what will justify relaxing
the cap on evidence — or keeping it.

Falling back happens **only** on an unscorable card. A band decline or a
hard sentinel (`-2` deceased, `-3` sequestrated, `-4` debt review, `-6`
fraud) stops there — otherwise an applicant refused by the unsecured
model could be approved by the thin-file one.

## Enquiry type: there is no parameter

`getScore` takes exactly `pUsername`, `pPassword`, `pIdNumber`,
`pResultType`, `pMyOrigin` and `pVersion`. There is no enquiry-purpose or
enquiry-type element in the schema, and "enquiry" appears in the spec only
inside reason-code descriptions about the consumer's own enquiry history.

So whether our score call lands as a **soft/preliminary** enquiry or a
**hard** one is not something this code can set per request — it is a
branch-level configuration on the Experian account. **Worth raising with
them as exactly that question**, because the score runs before identity
verification, against an ID that is checksum-valid but not yet confirmed
as the applicant's own.

`EXPERIAN_ENQUIRY_TYPE` exists as a hook for the day they expose one.
While unset the element is **omitted entirely** rather than sent empty —
an element the schema does not expect is how `-101` happens.

## Lifecycle defaults

- **Staleness: 6 months.** Past it, a new plan request triggers
  re-assessment *before* approval. Never a decline — a patient whose limit
  aged out has not been judged a bad risk, only judged a while ago.
- **Decline cooldown: 3 months.** Set only by a **substantive** decline.
  A pending assessment never sets it. Matched on the SA ID blind index, so
  re-registering with a fresh email does not buy a fresh billable enquiry.

Both are env-overridable; a malformed value falls back to the default
rather than disabling the control.

## Rollout order

1. `EXPERIAN_ENVIRONMENT=UAT`, credentials set, `ENABLE_CREDIT_CHECK=false`.
   Nothing calls the bureau; confirm the app is unchanged.
2. `ENABLE_CREDIT_CHECK=true` in UAT. Run a signup end to end. Check a row
   lands in `credit_assessments` with a `coefficient_version`, an `enq_id`
   and the full workings.
3. Shorten `CREDIT_STALENESS_MONTHS` to exercise re-assessment, and
   `CREDIT_DECLINE_COOLDOWN_MONTHS` to re-test a declined applicant.
4. Only then `EXPERIAN_ENVIRONMENT=LIVE` with live credentials.

Migrations `0139` and `0140` must be applied before
`ENABLE_CREDIT_CHECK=true` in any environment — the code writes columns
and calls a function they create.

## Logging and secrets

- Credentials come from the environment only. A test scans the client
  sources for hardcoded secrets.
- **The SOAP request body is never logged.** It carries `pPassword` in
  cleartext, so there is no debug flag that prints it. Failure paths log
  `redactEnvelope(envelope)`, which strips both credentials (without
  preserving the password's length) and masks the ID to its last four
  digits. A source-scanning test fails the build if any `console.*` call
  in `lib/experian/` is handed a raw envelope.
- ID numbers in logs use the existing `maskSaId` treatment. The 13-digit
  pattern used to find them in free text lives in `lib/validation/saId.ts`,
  the only place in the tree allowed to spell it out.
- No income figure, score, band or limit appears in any patient-facing
  message or client payload. `credit_assessments` has RLS enabled with no
  policies, so the anon key has no path to those rows at all.

## Worth revisiting once UAT has data

The Transcend cap is deliberately conservative: every applicant priced off
STS gets R1,000 regardless of band. That is the safe starting point, but
it means a Minimum Risk on Transcend and a bare thin file are worth the
same to us today.

Once there are Transcend-priced outcomes to look at, query
`credit_assessments` for rows with `binding_constraint = 'scorecard_cap'`
and join them to plan performance. If the Minimum and Low Risk Transcend
cohorts behave, the cap can be raised on evidence — by band, not
wholesale — with a `COEFFICIENT_VERSION` bump keeping the two populations
apart in the data.
