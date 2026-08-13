import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stripComments } from '@/lib/testing/stripComments';
import TillShell from './TillShell';
import { TILL_DEVICE_SECRET_KEY } from './tillStorage';
import type { TillActivity } from '@/lib/practice/tillActivity';

// ─── How the strip is wired into the till ───────────────────────────────────
//
// Two things only the WIRING can get wrong, and both are silent:
//
//   1. The strip disappearing on "Start next patient". That is the entire point
//      of the feature, and it is guaranteed structurally — the strip is a
//      SIBLING of CounterSessionForm, so the reset handler cannot reach it. The
//      first block below proves it through the real components rather than by
//      reading the JSX.
//
//   2. The read arriving by any path other than the device credential. The till
//      has no Supabase user session, so there is no RLS backstop here: if this
//      read ever went client-side or grew its own auth, nothing else in the
//      system would catch it. The source pins are the guard.

vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn(), push: vi.fn() }) }));
vi.mock('qrcode', () => ({ default: { toDataURL: () => Promise.resolve('data:image/png;base64,AAA') } }));

afterEach(() => { cleanup(); vi.clearAllMocks(); });

const ROOT = resolve(process.cwd());
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

const ACTIVITY: TillActivity = {
  sessions: [
    {
      sessionId: 'earlier', stage: 'completed', outcome: 'done',
      amount: 1450.5, label: 'Thabo M.', invoiceNumber: 'INV-1', labelIsInvoice: false,
    },
  ],
  doneCount: 1, pendingCount: 0, stoppedCount: 0,
  sastDate: '2026-08-14', truncated: false,
};

function mountTill() {
  // The real key, imported rather than typed out — a wrong string here would
  // leave deviceSecret null and withDeviceRecovery would short-circuit every
  // action, so the whole file would fail for a reason that has nothing to do
  // with the strip.
  window.localStorage.setItem(TILL_DEVICE_SECRET_KEY, 'secret-abc');

  const getTodaysCounterSessions = vi.fn().mockResolvedValue({ error: null, activity: ACTIVITY });
  const issueCounterSession = vi.fn().mockResolvedValue({
    error: null, token: 'tok-1', expiresAt: new Date(Date.now() + 120_000).toISOString(), planId: 'plan-1',
  });

  render(
    <TillShell
      checkDeviceStatus={vi.fn().mockResolvedValue({
        state: 'unlocked', practiceId: 'prac-1', practiceName: 'Rosebank',
        providers: [{ memberId: 'm1', name: 'Dr One' }],
      })}
      unlockTill={vi.fn().mockResolvedValue({ error: null })}
      issueCounterSession={issueCounterSession}
      expireCounterSession={vi.fn().mockResolvedValue({ error: null })}
      getCounterSessionStage={vi.fn().mockResolvedValue({ error: null, stage: 'created' })}
      acknowledgeCounterSession={vi.fn().mockResolvedValue({ error: null })}
      getTodaysCounterSessions={getTodaysCounterSessions}
    />,
  );

  return { getTodaysCounterSessions, issueCounterSession };
}

/**
 * Issue a session through the form, using the pattern CounterSessionForm.test
 * already documents: fireEvent.change + fireEvent.submit rather than typing and
 * clicking, because happy-dom's click-triggers-submit wiring is not reliable
 * here. Waits on the countdown, which only renders once the QR panel is up.
 */
async function issueASession() {
  fireEvent.change(screen.getByLabelText(/Bill amount/i), { target: { value: '1000' } });
  fireEvent.change(screen.getByTestId('pos-said-input'), { target: { value: '9001015800086' } });
  fireEvent.submit(screen.getByTestId('pos-entry-form'));
  await waitFor(() => expect(screen.getByTestId('pos-qr-countdown')).toBeTruthy());
}

// ─── It survives the reset ─────────────────────────────────────────────────

describe('the strip survives "Start next patient"', () => {
  it('is on screen alongside the entry form', async () => {
    mountTill();
    await screen.findByTestId('pos-entry-form');
    expect(await screen.findByTestId('till-today-strip')).toBeTruthy();
    expect(screen.getByTestId('till-today-row-earlier')).toBeTruthy();
  });

  it('stays on screen while a QR is up — when the phone is most likely to ring', async () => {
    const { issueCounterSession } = mountTill();
    await screen.findByTestId('pos-entry-form');
    await screen.findByTestId('till-today-strip');

    await issueASession();
    expect(issueCounterSession).toHaveBeenCalled();
    // The form has swapped its whole body for the QR panel...
    await screen.findByText(/Scan to continue/i);
    expect(screen.queryByTestId('pos-entry-form')).toBeNull();
    // ...and the strip is still there, unchanged.
    expect(screen.getByTestId('till-today-strip')).toBeTruthy();
    expect(screen.getByTestId('till-today-row-earlier')).toBeTruthy();
  });

  it('SURVIVES the reset that discards session state', async () => {
    // The whole feature, asserted end to end: issue a session, then click the
    // button whose handler clears issued/stage/qrDataUrl, and confirm the strip
    // and its rows are untouched.
    const { issueCounterSession } = mountTill();
    await screen.findByTestId('pos-entry-form');
    await screen.findByTestId('till-today-strip');

    await issueASession();
    expect(issueCounterSession).toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: /Start next patient/i }));

    // Session state IS gone — so the reset genuinely happened and this test is
    // not passing because nothing was reset.
    await screen.findByTestId('pos-entry-form');
    expect(screen.queryByText(/Scan to continue/i)).toBeNull();

    // The strip is not.
    expect(screen.getByTestId('till-today-strip')).toBeTruthy();
    expect(screen.getByTestId('till-today-row-earlier')).toBeTruthy();
    expect(screen.getByTestId('till-today-amount-earlier').textContent).toBe('R1,450.50');
  });

  it('is not re-fetched by the reset either — it was never session state', async () => {
    const { getTodaysCounterSessions, issueCounterSession } = mountTill();
    await screen.findByTestId('till-today-strip');
    await waitFor(() => expect(getTodaysCounterSessions).toHaveBeenCalledTimes(1));

    await issueASession();
    expect(issueCounterSession).toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: /Start next patient/i }));

    expect(getTodaysCounterSessions).toHaveBeenCalledTimes(1);
  });
});

// ─── Placement ─────────────────────────────────────────────────────────────

describe('placement — the primary flow stays dominant', () => {
  const SHELL = stripComments(read('app/practice/pos/TillShell.tsx'));

  it('the strip is a SIBLING of the form, not a child of it', () => {
    // What makes surviving the reset structural rather than remembered.
    const form  = SHELL.indexOf('<CounterSessionForm');
    const strip = SHELL.indexOf('<TodayActivityStrip');
    expect(form).toBeGreaterThan(0);
    expect(strip).toBeGreaterThan(form);
    // And CounterSessionForm knows nothing about it.
    const FORM = stripComments(read('app/practice/pos/CounterSessionForm.tsx'));
    expect(FORM).not.toMatch(/TodayActivityStrip|getTodaysCounterSessions|tillActivity/);
  });

  it('renders BELOW the entry form in DOM order', async () => {
    // Issuing a bill is the dominant action and must keep the top of the screen:
    // a front-desk display is often small, and pushing the amount and ID inputs
    // down to make room for a status list would cost the primary flow to serve
    // the secondary question.
    mountTill();
    const form  = await screen.findByTestId('pos-entry-form');
    const strip = await screen.findByTestId('till-today-strip');
    expect(form.compareDocumentPosition(strip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('the form is still the only thing that can issue a bill', () => {
    const STRIP = stripComments(read('app/practice/pos/TodayActivityStrip.tsx'));
    expect(STRIP).not.toMatch(/issueCounterSession|expireCounterSession|acknowledgeCounterSession/);
  });
});

// ─── Adversarial: the read path ─────────────────────────────────────────────

describe('adversarial — the read goes through device auth and nothing else', () => {
  const ACTIONS = stripComments(read('app/practice/pos/actions.ts'));

  it('the action calls requireUnlockedDevice FIRST and returns on failure', () => {
    const fn = ACTIONS.slice(ACTIONS.indexOf('export async function getTodaysCounterSessions'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    const guard = body.indexOf('requireUnlockedDevice(deviceSecret)');
    const bail  = body.indexOf('if (!auth.ok) return { error: auth.error }');
    const work  = body.indexOf('resolveTodaysTillActivity');
    expect(guard).toBeGreaterThan(0);
    expect(bail).toBeGreaterThan(guard);
    expect(work).toBeGreaterThan(bail);
  });

  it('scopes the read to the practice the GUARD resolved — practiceId is not a parameter', () => {
    // The till cannot ask for another practice's day, because it cannot name
    // one: the only thing it sends is its own secret.
    const fn = ACTIONS.slice(ACTIONS.indexOf('export async function getTodaysCounterSessions'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    expect(body).toMatch(/resolveTodaysTillActivity\(svc\(\), auth\.practiceId\)/);
    const sig = ACTIONS.slice(
      ACTIONS.indexOf('export async function getTodaysCounterSessions'),
      ACTIONS.indexOf('export async function getTodaysCounterSessions') + 160,
    );
    expect(sig).not.toMatch(/practiceId/);
  });

  it('introduces NO new auth path — no user session, no RPC, no policy of its own', () => {
    const fn = ACTIONS.slice(ACTIONS.indexOf('export async function getTodaysCounterSessions'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    expect(body).not.toMatch(/auth\.getUser|createClient\(\)|requireConfirmedUser/);
    expect(body).not.toMatch(/\.rpc\(/);
    // And the file as a whole still has no user-session concept at all.
    expect(ACTIONS).not.toMatch(/supabase\.auth\.getUser/);
  });

  it('the strip never queries the database from the client', () => {
    // checkout_sessions' own RLS policy (practice_biller_select, 0085) keys on
    // is_practice_biller and therefore on auth.uid(), which a till does not
    // have — a client-side query would return nothing even if one were written,
    // and writing a policy for it would mean granting anon access to a table
    // holding encrypted SA IDs.
    const STRIP = stripComments(read('app/practice/pos/TodayActivityStrip.tsx'));
    expect(STRIP).not.toMatch(/createClient|@supabase|from\('checkout_sessions'\)/);
    expect(STRIP).toMatch(/getTodaysCounterSessions\(\)/);
  });

  it('the strip is handed the secret by the SAME wrapper as every other action', () => {
    // withDeviceRecovery, so a till that locks or is revoked while the strip is
    // on screen falls back to the PIN screen through existing behaviour.
    expect(SHELL_SRC).toMatch(/getTodaysCounterSessions=\{withDeviceRecovery\(getTodaysCounterSessions\)\}/);
  });

  it('page.tsx passes the real server action through, adding no client fetch', () => {
    const PAGE = stripComments(read('app/practice/pos/page.tsx'));
    expect(PAGE).toMatch(/getTodaysCounterSessions,/);
    expect(PAGE).toMatch(/getTodaysCounterSessions=\{getTodaysCounterSessions\}/);
    // The route still fetches nothing server-side — the device secret lives in
    // localStorage, which a server component cannot read.
    expect(PAGE).not.toMatch(/await |createClient|from\(/);
  });
});

const SHELL_SRC = stripComments(read('app/practice/pos/TillShell.tsx'));

// ─── Adversarial: no new formatting ────────────────────────────────────────

describe('adversarial — no new date or money formatting', () => {
  const NEW_FILES = [
    'lib/practice/tillActivity.ts',
    'app/practice/pos/TodayActivityStrip.tsx',
  ];

  it.each(NEW_FILES)('%s defines no money formatter', (p) => {
    const code = stripComments(read(p));
    expect(code).not.toMatch(/function formatRand|function rand\(/);
    expect(code).not.toMatch(/toFixed|style: 'currency'|toLocaleString/);
  });

  it.each(NEW_FILES)('%s defines no date formatter', (p) => {
    const code = stripComments(read(p));
    expect(code).not.toMatch(/toLocaleDateString|toLocaleTimeString|getMonth\(\)|getHours\(\)|MONTHS\[/);
    expect(code).not.toMatch(/\bMonday\b|\bJan\b/);
  });

  it('the SAST day comes from the shared window helpers, as the hero and payouts tab do', () => {
    const code = stripComments(read('lib/practice/tillActivity.ts'));
    expect(code).toMatch(/from '@\/lib\/payments\/payoutWindow'/);
    expect(code).toMatch(/sastDateString/);
    expect(code).toMatch(/sastMidnight/);
  });

  it('the till\'s own duplicate formatRand was NOT spread into anything new', () => {
    // CounterSessionForm carries a local copy of billHelpers' formatRand. It is
    // pre-existing, renders correctly, and is out of scope for this piece — what
    // matters is that the new files import the shared one instead.
    expect(read('app/practice/pos/CounterSessionForm.tsx')).toMatch(/function formatRand/);
    for (const p of NEW_FILES) {
      expect(stripComments(read(p)), p).not.toMatch(/replace\(\/\\B\(\?=/);
    }
  });
});

// ─── Diff scope ────────────────────────────────────────────────────────────

describe('diff scope — device auth, issuance, QR and checkout untouched', () => {
  it('device/PIN auth is unchanged', () => {
    const TILL_DEVICE = stripComments(read('lib/auth/tillDevice.ts'));
    // Still the same guard shape the strip now also uses.
    expect(TILL_DEVICE).toMatch(/export async function requireUnlockedDevice/);
    expect(TILL_DEVICE).toMatch(/last_activity_at/);
    // The strip added no read-only variant, which is what a poll would have needed.
    expect(TILL_DEVICE).not.toMatch(/readOnly|skipActivity|touchActivity/);
  });

  it('issueCounterSession is untouched by this change', () => {
    const ACTIONS = stripComments(read('app/practice/pos/actions.ts'));
    const fn = ACTIONS.slice(ACTIONS.indexOf('export async function issueCounterSession'));
    const body = fn.slice(0, fn.indexOf('\nexport '));
    expect(body).not.toMatch(/tillActivity|TodayActivityStrip|resolveTodaysTillActivity/);
  });

  it('the QR flow and the countdown are untouched', () => {
    const FORM = stripComments(read('app/practice/pos/CounterSessionForm.tsx'));
    expect(FORM).toMatch(/QRCode\.toDataURL/);
    expect(FORM).toMatch(/STAGE_POLL_MS/);
    expect(FORM).not.toMatch(/tillActivity|TodayActivityStrip/);
  });

  it('nothing new writes to the database', () => {
    for (const p of ['lib/practice/tillActivity.ts', 'app/practice/pos/TodayActivityStrip.tsx']) {
      const code = stripComments(read(p));
      expect(code, p).not.toMatch(/\.insert\(|\.update\(|\.upsert\(|\.delete\(/);
    }
  });

  it('no migration was needed — it reads tables 0085 and 0088 already define', () => {
    const code = stripComments(read('lib/practice/tillActivity.ts'));
    expect(code).toMatch(/from\('checkout_sessions'\)/);
    expect(code).not.toMatch(/CREATE TABLE|ALTER TABLE/);
  });
});
