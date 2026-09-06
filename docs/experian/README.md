# Experian Person Get Score — reference implementation

The six files beside this README are the **verified reference implementation**, committed
verbatim and never edited. They were validated against the LIVE Experian service, and every
non-obvious decision in them was paid for with a billable transaction. They are the record of
what was learned; `lib/experian/` is the adaptation that actually runs.

| File | What it is |
|---|---|
| `client.ts` | SOAP transport, envelope construction, response parsing, error classification |
| `scores.ts` | Band tables, Sigma warning codes, the two "no score" conventions, the hard gate |
| `assess-at-signup.ts` | Orchestration: consent → validation → cache → attempt row → call → decide |
| `fixtures.ts` | Captured + synthetic payloads, SOAP envelope builders, the eleven error codes |
| `experian.test.ts` | The original suite, written against `node:test` |
| `bureau_enquiries.sql` | The enquiry log table, numbered `0099` as a placeholder |

## Why this is kept, and kept unmodified

Three of these files encode facts that are expensive to rediscover and easy to "fix" back into
being wrong:

- **The SOAP envelope is exact.** A prefixed namespace on the wrapper only, all six children
  unqualified, in `xs:sequence` order — not the PDF's parameter-table order. Getting either
  wrong returns `-101 "Not all variables filled in"`, which reads like a missing field rather
  than a namespace fault, and is billed.
- **A negative score is a warning code, not a low score.** `-2` is deceased. Legacy cards use
  the opposite convention: a positive value below 480. Both must go through `isRealScore()`.
- **The band tables are per scorecard.** A band 4 on NLR is not a band 4 on SU.

If the adaptation and this reference ever disagree, this directory is the ground truth for the
protocol and the tables; `lib/experian/` is the ground truth for how the repo calls it.

## What differs in `lib/experian/`

Deviations are listed in the PR description. In summary: the suite is converted to vitest,
the SA ID and hashing helpers are the repo's existing ones rather than injected stubs,
`pVersion` is read from the environment defaulting to `4.0`, `STS` is in the scorecard
preference list, and the migration is renumbered from the `0099` placeholder to `0148`.

## Excluded from build and test

`tsconfig.json` and `vitest.config.ts` both exclude `docs/`. Without that, `experian.test.ts`
would be collected by vitest and fail on its `node:test` imports — this directory is an
artefact, not part of the program.
