// Fixture-backed stand-ins for every module on the patient layout's path that
// would touch Supabase, auth, cookies or a server action. The capture script's
// esbuild plugin routes those imports here; the components themselves are
// bundled unmodified.
import { FIXTURE } from '../fixtures';

const TABLES: Record<string, unknown[]> = {
  plans:           [...FIXTURE.plans],
  payments:        [],
  payment_methods: [{ card_brand: FIXTURE.card.brand, last_four: FIXTURE.card.last4, is_default: true }],
};

/** Chainable query builder that resolves to the fixture table. */
function from(table: string) {
  const builder: object = new Proxy({}, {
    get(_t, key) {
      if (key === 'then') {
        return (resolve: (v: unknown) => void) => resolve({ data: TABLES[table] ?? [], error: null });
      }
      return () => builder;
    },
  });
  return builder;
}

const client = { from, rpc: async () => ({ data: null, error: null }) };

// @/lib/supabase/server
export async function createClient() { return client; }

// @/lib/auth/requestUser, @/lib/auth/requireConfirmedUser
export const getRequestUser = async () => FIXTURE.user;
export async function requireConfirmedUser() { return { user: FIXTURE.user, supabase: client }; }

// @/lib/patient/requestProfile, @/lib/patient/freeze
export const getPatientProfileForRequest = async () => ({
  ...FIXTURE.profile,
  approved_credit_limit: FIXTURE.approvedAllowance,
});
export async function isPatientFrozen() { return false; }

// @/lib/legal/termsGate, @/lib/onboarding/state
export function requireTermsAccepted() {}
export function computeOnboarding() { return { done: true }; }

// Server actions and the logout helper — never invoked in a static render.
const noop = async () => ({ error: null });
export const declinePlan         = noop;
export const skipPasskeyPrompt   = noop;
export const dontAskAgainPasskey = noop;
export async function logoutAndRedirect() {}
