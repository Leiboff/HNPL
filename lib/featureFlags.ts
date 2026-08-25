// ─── Feature flags ─────────────────────────────────────────────────────
//
// Simple env-driven flags. Read at module load — flip a flag by
// changing the env var and redeploying (no per-request evaluation
// intended).
//
// Convention: the env var is `NEXT_PUBLIC_ENABLE_*` when the browser
// needs to read it (e.g. to hide a UI affordance), and `ENABLE_*`
// (server-only) when only server code branches on it. Onboarding
// seams currently branch on server-only flags because the routing
// decisions live in server components / server actions.

function readServerFlag(name: string): boolean {
  const raw = process.env[name];
  if (!raw) return false;
  return raw.trim().toLowerCase() === 'true';
}

// Turn on to activate the credit + affordability check step in the
// patient onboarding flow (between ID capture and completion).
// OFF → the step doesn't render and is treated as auto-pass in the
// state model. Flipping ON does NOT retro-lock already-completed
// patients — see profiles.onboarding_completed (write-once-true).
export const ENABLE_CREDIT_CHECK = readServerFlag('ENABLE_CREDIT_CHECK');

// (final step before completion). OFF → the step doesn't render and
// is treated as auto-pass. Same non-retro-lock semantics as above.

// Shape used by the onboarding state model + tests. Kept as a small
// object so tests can inject a specific flag combination without
// mocking process.env.
export type OnboardingFlags = {
  creditCheck: boolean;
};

export function currentFlags(): OnboardingFlags {
  return {
    creditCheck: ENABLE_CREDIT_CHECK,
  };
}
