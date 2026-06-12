@AGENTS.md

## Package manager

This project uses **pnpm** exclusively. Never run `npm` or `yarn` commands here — use `pnpm install`, `pnpm add <pkg>`, `pnpm run <script>`. The only lockfile is `pnpm-lock.yaml`; `package-lock.json` and `yarn.lock` are gitignored so they can't reappear by accident.

Vercel deploys with `pnpm install --frozen-lockfile`. If a `pnpm add` doesn't make it into a commit, the deploy fails with `ERR_PNPM_OUTDATED_LOCKFILE`. Always commit the lockfile changes alongside the dependency change.

The `packageManager` field in `package.json` pins the pnpm version via corepack — if you upgrade pnpm locally, update that field too.

## Database migrations

Migrations live in-repo at `supabase/` (alongside `app/`, `lib/`, etc.) — `supabase/config.toml` + `supabase/migrations/*.sql`. They were moved here from a sibling tree on the same commit that reconciled their numbering; if you find references to a sibling `../supabase/`, update them.

Rule: a feature and the migrations it depends on are committed together in the same PR — never separately. A migration without the code that uses it is dead; code without the migration it depends on is broken. Both must land at once.

The Supabase CLI extracts the migration version from the leading digits of the filename (e.g. `0041_…`). Two files at the same version are ambiguous — never create one. If a rename is required, also reconcile `supabase_migrations.schema_migrations` so the CLI doesn't try to re-apply.
