/**
 * Resolve a build identifier to render discreetly in the patient account
 * footer — or `null` when there genuinely isn't one.
 *
 * ─── WHAT IS ACTUALLY AVAILABLE ───────────────────────────────────────
 *
 * Nothing in this app exposed a version string before this file. To be
 * explicit about what was checked:
 *
 *   • package.json has `"version": "0.1.0"`, but nothing surfaced it.
 *   • next.config.ts is empty — no `env` block, no `generateBuildId`.
 *   • there is no NEXT_PUBLIC_* version variable anywhere in the repo.
 *
 * So this reads the two variables that a real deploy sets by itself, and
 * returns null when neither is present. It does NOT invent a number, and it
 * does not add build configuration to manufacture one.
 *
 * ─── WHY THIS NEEDS NO CLIENT EXPOSURE ────────────────────────────────
 *
 * The account page is a server component, so it reads these server-side and
 * passes the finished STRING down as a prop. That is why neither variable
 * needs a NEXT_PUBLIC_ prefix: the values never reach the client bundle,
 * only the rendered text does. Adding NEXT_PUBLIC_ equivalents would put
 * deployment metadata in every client bundle in the app to save one prop.
 *
 * ─── LOCAL DEV RETURNS NULL, AND THAT IS THE POINT ────────────────────
 *
 * `VERCEL_GIT_COMMIT_SHA` is set by Vercel and absent locally.
 * `npm_package_version` is set by the package manager when a script runs and
 * is not guaranteed in production. When neither resolves, the footer renders
 * nothing at all — no "unknown", no "dev", no placeholder. That is the same
 * rule the provenance lines follow, applied here.
 */

/** Just enough of the environment to resolve a version. Injectable for tests. */
export type VersionEnv = {
  VERCEL_GIT_COMMIT_SHA?: string | undefined;
  npm_package_version?:   string | undefined;
  /**
   * Index signature so `process.env` (ProcessEnv, which is all index
   * signature and no declared keys) is assignable. Without it TS rejects the
   * default parameter: two types whose only overlap is optional keys have
   * "no properties in common".
   */
  [key: string]: string | undefined;
};

/** Commit SHAs are rendered short — seven characters, as git itself does. */
const SHA_DISPLAY_LENGTH = 7;

/**
 * A display string like `v0.1.0 · a1b2c3d`, or whichever half is available,
 * or `null` when neither is.
 *
 * Blank and whitespace-only values are treated as absent, because an env var
 * set to the empty string is how a misconfigured pipeline presents itself and
 * `v` alone on the footer is worse than nothing.
 */
export function resolveAppVersion(env: VersionEnv = process.env): string | null {
  const version = env.npm_package_version?.trim();
  const sha     = env.VERCEL_GIT_COMMIT_SHA?.trim();

  const parts: string[] = [];
  if (version) parts.push(`v${version}`);
  if (sha)     parts.push(sha.slice(0, SHA_DISPLAY_LENGTH));

  return parts.length > 0 ? parts.join(' · ') : null;
}
