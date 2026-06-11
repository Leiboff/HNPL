@AGENTS.md

## Package manager

This project uses **pnpm** exclusively. Never run `npm` or `yarn` commands here — use `pnpm install`, `pnpm add <pkg>`, `pnpm run <script>`. The only lockfile is `pnpm-lock.yaml`; `package-lock.json` and `yarn.lock` are gitignored so they can't reappear by accident.

Vercel deploys with `pnpm install --frozen-lockfile`. If a `pnpm add` doesn't make it into a commit, the deploy fails with `ERR_PNPM_OUTDATED_LOCKFILE`. Always commit the lockfile changes alongside the dependency change.

The `packageManager` field in `package.json` pins the pnpm version via corepack — if you upgrade pnpm locally, update that field too.
