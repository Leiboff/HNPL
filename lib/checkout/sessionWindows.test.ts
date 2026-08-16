import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stripComments } from '@/lib/testing/stripComments';
import {
  CHECKOUT_SCAN_TTL_TILL_MS,
  CHECKOUT_SCAN_TTL_DASHBOARD_MS,
  CHECKOUT_COMPLETION_TTL_MS,
} from './sessionTtl';

// ─── One window was doing two jobs ───────────────────────────────────────
//
// checkout_sessions.expires_at governed both "how long may this QR sit
// unscanned" and "how long may the patient take to finish". Only the first
// has a security argument behind it — a stranger photographing a QR off a
// shared reception screen. The second was simply too short: a first-time
// patient enters an ID, verifies an OTP, clears affordability, accepts
// terms and enters a card, and overrunning did not merely lapse the link —
// expire_stale_checkout_session DECLINES the plan, which is terminal. A
// slow signup at the counter destroyed the bill.

const ROOT    = resolve(process.cwd());
const read    = (p: string) => stripComments(readFileSync(resolve(ROOT, p), 'utf8'));
const readSql = (p: string) => stripComments(readFileSync(resolve(ROOT, p), 'utf8'), { sql: true });

const MIG_0098 = readSql('supabase/migrations/0098_invitation_sa_id_and_completion_window.sql');
const MIG_0085 = readSql('supabase/migrations/0085_checkout_sessions.sql');
const BILLS    = read('app/practice/bills/new/actions.ts');
const POS      = read('app/practice/pos/actions.ts');
const FORM     = read('app/practice/pos/CounterSessionForm.tsx');

describe('the SQL and the TypeScript agree on the completion window', () => {
  it('the migration hardcodes one hour', () => {
    expect(MIG_0098).toMatch(/expires_at = now\(\) \+ INTERVAL '1 hour'/);
  });

  it('CHECKOUT_COMPLETION_TTL_MS is that same hour', () => {
    // Pinned in both directions: the SQL is authoritative (it is what
    // actually runs), and drifting the constant would make every
    // client-side estimate a lie.
    expect(CHECKOUT_COMPLETION_TTL_MS).toBe(60 * 60 * 1000);
    const hours = CHECKOUT_COMPLETION_TTL_MS / (60 * 60 * 1000);
    expect(MIG_0098).toMatch(new RegExp(`INTERVAL '${hours} hour'`));
  });

  it('the window is HARDCODED, not a parameter — the function is anon-callable', () => {
    // stamp_checkout_session_scanned is GRANTed to anon (0085). A
    // caller-supplied interval would let anyone mint an arbitrarily
    // long-lived session, which is the whole threat this window exists to
    // bound.
    expect(MIG_0085).toMatch(/GRANT EXECUTE ON FUNCTION stamp_checkout_session_scanned\(TEXT\) TO anon, authenticated;/);
    const fn = MIG_0098.slice(MIG_0098.indexOf('CREATE OR REPLACE FUNCTION stamp_checkout_session_scanned'));
    // Exactly one parameter, and the interval is a literal beside now().
    expect(fn).toMatch(/stamp_checkout_session_scanned\(p_token TEXT\)/);
    expect(fn).not.toMatch(/p_window|p_interval|p_ttl|p_minutes|p_hours/);
    expect(fn).toMatch(/INTERVAL '\d+ \w+'/);
  });
});

describe('there is still exactly ONE thing that declines a stale session', () => {
  it('0098 does not touch expire_stale_checkout_session', () => {
    expect(MIG_0098).not.toMatch(/FUNCTION expire_stale_checkout_session/);
  });

  it('it needs no change — it already reads expires_at, which is now the deadline in force', () => {
    expect(MIG_0085).toMatch(/IF NOT p_force AND v_session\.expires_at > now\(\) THEN/);
    expect(MIG_0085).toMatch(/UPDATE plans\s+SET status = 'declined'/);
  });

  it('no second expiry column was introduced', () => {
    // get_checkout_session_by_token ALSO guards on expires_at > now(), so a
    // separate completion column would leave two independent "is this
    // live?" tests to keep in step — and a missed one locks the patient out
    // of their own session mid-signup while the decliner thinks it is fine.
    expect(MIG_0098).not.toMatch(/completion_expires_at|scan_expires_at/);
    expect(MIG_0085).toMatch(/AND cs\.expires_at > now\(\)/);
  });

  it('the scan stamp still refuses to revive an already-expired session', () => {
    const fn = MIG_0098.slice(MIG_0098.indexOf('CREATE OR REPLACE FUNCTION stamp_checkout_session_scanned'));
    // Extending only applies to a session that is still inside its SCAN
    // window. Without this a dead QR could be resurrected by scanning it.
    expect(fn).toMatch(/AND stage\s+= 'created'/);
    expect(fn).toMatch(/AND expires_at > now\(\)/);
    expect(fn).toMatch(/SELECT expire_stale_checkout_session\(p_token\)/);
  });
});

describe('the two surfaces differ on the SCAN window, deliberately', () => {
  it('the till stays short — its screen faces a queue continuously', () => {
    expect(CHECKOUT_SCAN_TTL_TILL_MS).toBe(2 * 60 * 1000);
    expect(POS).toMatch(/CHECKOUT_SCAN_TTL_TILL_MS/);
  });

  it('the dashboard gets longer — nobody may be standing there yet', () => {
    expect(CHECKOUT_SCAN_TTL_DASHBOARD_MS).toBe(15 * 60 * 1000);
    expect(BILLS).toMatch(/CHECKOUT_SCAN_TTL_DASHBOARD_MS/);
  });

  it('and they are genuinely different, not the same constant twice', () => {
    expect(CHECKOUT_SCAN_TTL_DASHBOARD_MS).toBeGreaterThan(CHECKOUT_SCAN_TTL_TILL_MS);
  });

  it('but the COMPLETION window is identical — after a scan the issuer is irrelevant', () => {
    // Applied by the RPC, so neither surface can set its own. Asserted by
    // the absence of any per-surface completion constant.
    expect(BILLS).not.toMatch(/COMPLETION_TTL/);
    expect(POS).not.toMatch(/COMPLETION_TTL/);
  });

  it('the completion window is long enough for a real first-time signup', () => {
    // ID, OTP, affordability, terms, card. The old window gave all of that
    // two minutes.
    expect(CHECKOUT_COMPLETION_TTL_MS).toBeGreaterThanOrEqual(60 * 60 * 1000);
    expect(CHECKOUT_COMPLETION_TTL_MS).toBeGreaterThan(CHECKOUT_SCAN_TTL_TILL_MS * 20);
  });
});

describe('nothing extends the completion window once it starts', () => {
  it('no heartbeat, no activity-based renewal', () => {
    // Deliberate: a signup running past an hour has already failed by other
    // means, and a renewal path would be a new write on an anon-callable
    // surface. Simpler wins; the failure mode is recoverable by re-issuing.
    expect(MIG_0098).not.toMatch(/heartbeat|touch_checkout_session|extend_checkout/i);
    const stamps = [...MIG_0098.matchAll(/expires_at\s*=\s*now\(\)/g)];
    expect(stamps.length).toBe(1);
  });
});

describe('the till screen tells the teller the truth after a scan', () => {
  // THE finding that would have made the server change actively harmful.
  // The countdown on the till measures the SCAN window; once the patient
  // scans, the server moves the deadline and that local clock stops
  // describing anything real. Showing "QR expired" mid-signup invites
  // "Start next patient", which force-expires a LIVE session and declines
  // the plan — a timeout bug converted into a teller-triggered one.

  it('does not call a scanned session expired when its scan clock runs out', () => {
    expect(FORM).toMatch(/const scanned = stage === 'scanned';/);
    expect(FORM).toMatch(/\(secondsLeft <= 0 && !scanned\)/);
  });

  it('shows a scanned session as in progress rather than as a countdown', () => {
    expect(FORM).toMatch(/\) : scanned \? \(/);
    expect(FORM).toMatch(/Patient is paying/);
    expect(FORM).toMatch(/data-testid="pos-scanned-note"/);
  });

  it('"Start next patient" still force-expires immediately', () => {
    // A teller explicitly abandoning is a different event from a timeout
    // and stays instant — p_force bypasses expires_at entirely.
    expect(FORM).toMatch(/expireCounterSession\(issued\.token, \{ force: true \}\)/);
    expect(MIG_0085).toMatch(/IF NOT p_force AND/);
  });

  it('the natural-expiry trigger is still force:false, so it cannot kill a live session', () => {
    // Fired by the countdown at zero. After a scan the server-side deadline
    // has moved, so this call is a no-op rather than a decline.
    expect(FORM).toMatch(/expireCounterSession\(issued\.token, \{ force: false \}\)/);
  });
});
