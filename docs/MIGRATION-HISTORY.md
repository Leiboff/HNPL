# Migration history: the drift with production, and how to finish closing it

`supabase db push` decides what to run from the **version alone** — the four
leading digits of the filename, matched against
`supabase_migrations.schema_migrations.version`. The recorded *name* beside
each version is never consulted. When the repository and the database
disagree about what a version means, the CLI does not report a conflict; it
reports nothing, and the local file is never executed.

That happened here.

## What production actually has

| Version | Recorded in production as | In this repo |
|---|---|---|
| …0137 | matches | matches |
| 0138 | `identity_signals` | — (was `reverse_geocode_rate_limit`) |
| 0139 | `unique_verified_phone` | — |
| 0140 | `verified_phone_unique_index` | — |
| 0141 | `privileged_aal2_backstop` | `0141_privileged_aal2_backstop.sql` |
| 0142–0145 | not recorded | present, **pending** |

0138, 0139 and 0140 were applied out-of-band through the Supabase MCP and
never written back into `supabase/migrations`. The header of 0141 notes 0139
and 0140 in passing; 0138 was not noticed at all, which is what made it
expensive.

## The two halves of the drift

They are separate problems with separate fixes, and only one of them can be
fixed from the repository.

### 1. A local file on a version production had claimed — *fixed*

`0138_reverse_geocode_rate_limit.sql` sat on version 0138, which production
already recorded as `identity_signals`. The CLI matched on the version, called
it applied, and skipped the file. `supabase migration list` printed 0138 in
both columns and showed nothing wrong: the migration was not *pending*, it was
**unreachable**.

The change it carried was the `reverse_geocode` rate-limit bucket, and its
absence was silent by construction. `consume_rate_limit` answers an unknown
bucket with a warning and `true` — deliberate, since a misspelled bucket must
not become an outage (0134) — so the billable reverse-geocoding route ran with
no limit at all, and nothing logged an error or failed a test.

**Fix.** The file is retired, not renumbered. Every free version is now after
0145, and `0145_referrals_foundation.sql` already restates the bucket list in
full *including* `reverse_geocode`. A renumbered `0146` would therefore have
become the function's last declaration — the one the database ends up with and
the one `lib/security/rateLimit.buckets.test.ts` pins — and would have had to
be kept in step with 0145 forever to achieve nothing. 0145 carries the bucket,
its provenance is written into 0145's header, and pushing 0142–0145 closes the
gap in production.

### 2. Production rows this repo has no file for — *outstanding*

0138 (`identity_signals`), 0139 (`unique_verified_phone`) and 0140
(`verified_phone_unique_index`) exist only in the live database. Nothing in
this repository references an `identity_signals` object or a verified-phone
uniqueness constraint, so **their DDL cannot be reconstructed from the code**
— it has to be transcribed out of production.

Until it is, `supabase db reset`, a fresh staging project and any
disaster-recovery rebuild all produce a database *missing* those objects. For
0139/0140 in particular that means the rebuilt database is the **permissive**
one: uniqueness on a verified phone number is a security control, the same
shape as 0097 on `sa_id_lookup_hash`. This is precisely the failure mode
`0136_reconcile_rls_drift_with_production.sql` was written about — "THE
REPOSITORY IS THE INSECURE VERSION".

Closing it needs production access:

```sql
-- What the rows say they are
select version, name, statements is not null as has_sql
  from supabase_migrations.schema_migrations
 where version in ('0138', '0139', '0140');
```

`schema_migrations.statements` holds the applied SQL for migrations the CLI
ran; for changes applied through the MCP or the dashboard it may be null, in
which case the DDL has to come off the live catalog instead — `pg_indexes`,
`pg_constraint` and `\d+` on the affected tables. Either way, transcribe into
`supabase/migrations/0138_identity_signals.sql`,
`0139_unique_verified_phone.sql` and `0140_verified_phone_unique_index.sql`
written **idempotently** (`IF NOT EXISTS` / `DROP … IF EXISTS` first), so they
are a no-op against production and a real change against anything rebuilt —
the same discipline 0136 uses. Then delete the matching entries from
`PRODUCTION_ONLY_VERSIONS`; the test beside it fails until you do, which is
the review moment where "is this really what the live database has?" gets
asked.

Do **not** invent the DDL from the migration names. A guessed constraint that
does not match production is worse than a documented gap: it makes the drift
look closed.

## Applying what is pending

0142–0145 are on versions production has not recorded, so they are ordinary
pending migrations:

```bash
supabase migration list      # 0142–0145 should be the only local-only rows
supabase db push             # applies 0142, 0143, 0144, 0145 in order
```

Per CLAUDE.md these ship with the code that depends on them, in the same PR —
never separately. Note that pushing 0145 is also what restores the
`reverse_geocode` limit in production.

If a migration is ever applied out-of-band again (MCP, dashboard, psql),
reconcile `supabase_migrations.schema_migrations` to the repository's version
number in the same sitting — as was done for 0141 — and commit the file. A
version recorded under a name no file carries is the whole bug on this page.

## The guard

`lib/security/migrationHistory.ts` holds the known divergence, and
`lib/security/migrationHistory.test.ts` fails the build on:

- two files sharing a version (CLAUDE.md forbids these outright);
- **a file on a version production records under another name** — the 0138
  regression, which is otherwise invisible;
- a hole in the sequence that nothing declares — an undeclared gap is where
  the next collision hides, because the numbering looks continuous and the
  next author takes the number;
- a manifest entry whose file has quietly appeared, or vice versa;
- `nextFreeVersion` drifting: the next migration is **0146**, counted past
  *both* histories. `max(local) + 1` walks straight back into the collision.

The next migration to be authored in this repository is `0146_*.sql`.
