import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stripComments } from '@/lib/testing/stripComments';
import TodayActivityStrip from './TodayActivityStrip';
import { formatRand } from '@/app/practice/billHelpers';
import type { TillActivity, TillSessionRow } from '@/lib/practice/tillActivity';

// ─── The strip a receptionist reads while somebody waits ────────────────────
//
// The question it answers is "did that bill go through?", so the assertion that
// matters most is that the three answers are distinguishable BY TEXT — a
// receptionist scanning for status must not have to interpret a colour, and a
// test that only checked class names would pass on a strip nobody can read.

afterEach(cleanup);

function row(over: Partial<TillSessionRow> & { sessionId: string }): TillSessionRow {
  return {
    stage:          'completed',
    outcome:        'done',
    amount:         1450.5,
    label:          'Thabo M.',
    invoiceNumber:  `INV-${over.sessionId}`,
    labelIsInvoice: false,
    ...over,
  };
}

function activity(sessions: TillSessionRow[], over: Partial<TillActivity> = {}): TillActivity {
  return {
    sessions,
    doneCount:    sessions.filter((s) => s.outcome === 'done').length,
    pendingCount: sessions.filter((s) => s.outcome === 'pending').length,
    stoppedCount: sessions.filter((s) => s.outcome === 'stopped').length,
    sastDate:     '2026-08-14',
    truncated:    false,
    ...over,
  };
}

const THREE = [
  row({ sessionId: 'a', outcome: 'done',    stage: 'completed', amount: 1450.5,  label: 'Thabo M.' }),
  row({ sessionId: 'b', outcome: 'pending', stage: 'created',   amount: 899.99,  label: 'INV-b', labelIsInvoice: true }),
  row({ sessionId: 'c', outcome: 'stopped', stage: 'expired',   amount: 2300,    label: 'INV-c', labelIsInvoice: true }),
];

function mount(result: { error: string | null; activity?: TillActivity }) {
  const fn = vi.fn().mockResolvedValue(result);
  const view = render(<TodayActivityStrip getTodaysCounterSessions={fn} />);
  return { fn, view };
}

// ─── The three answers, in words ───────────────────────────────────────────

describe('completed, in-progress and abandoned are visibly distinguishable', () => {
  it('each carries a DISTINCT word, not just a distinct colour', async () => {
    mount({ error: null, activity: activity(THREE) });
    await screen.findByTestId('till-today-list');

    expect(screen.getByTestId('till-today-chip-a').textContent).toBe('Paid');
    expect(screen.getByTestId('till-today-chip-b').textContent).toBe('Waiting on patient');
    expect(screen.getByTestId('till-today-chip-c').textContent).toBe('Not completed');

    // All three differ from one another — the property that actually matters.
    const labels = ['a', 'b', 'c'].map((id) => screen.getByTestId(`till-today-chip-${id}`).textContent);
    expect(new Set(labels).size).toBe(3);
  });

  it('carries the outcome and stage on the row itself, so nothing depends on colour', async () => {
    mount({ error: null, activity: activity(THREE) });
    await screen.findByTestId('till-today-list');
    expect(screen.getByTestId('till-today-row-a').getAttribute('data-outcome')).toBe('done');
    expect(screen.getByTestId('till-today-row-b').getAttribute('data-outcome')).toBe('pending');
    expect(screen.getByTestId('till-today-row-c').getAttribute('data-outcome')).toBe('stopped');
  });

  it('names WHY a stopped session stopped — expired and declined read differently', async () => {
    mount({ error: null, activity: activity([
      row({ sessionId: 'e', outcome: 'stopped', stage: 'expired'  }),
      row({ sessionId: 'd', outcome: 'stopped', stage: 'declined' }),
    ]) });
    await screen.findByTestId('till-today-list');
    expect(screen.getByTestId('till-today-detail-e').textContent).toBe('Didn’t finish in time');
    expect(screen.getByTestId('till-today-detail-d').textContent).toBe('Declined');
  });

  it('a paid or waiting row carries no stopped-detail line', async () => {
    mount({ error: null, activity: activity(THREE) });
    await screen.findByTestId('till-today-list');
    expect(screen.queryByTestId('till-today-detail-a')).toBeNull();
    expect(screen.queryByTestId('till-today-detail-b')).toBeNull();
  });

  it('only a genuinely completed session is ever labelled Paid', async () => {
    // The failure that would matter: a receptionist telling a patient their
    // payment went through when it did not.
    mount({ error: null, activity: activity(THREE) });
    await screen.findByTestId('till-today-list');
    // toContain, not a \b regex: textContent concatenates without separators, so
    // "R1,450.50Paid" has no word boundary before the P and a \b test would
    // silently fail on the row that is CORRECT.
    for (const id of ['b', 'c']) {
      expect(screen.getByTestId(`till-today-row-${id}`).textContent).not.toContain('Paid');
    }
    expect(screen.getByTestId('till-today-row-a').textContent).toContain('Paid');
  });

  it('summarises the day in one line', async () => {
    mount({ error: null, activity: activity(THREE) });
    await screen.findByTestId('till-today-summary');
    expect(screen.getByTestId('till-today-summary').textContent)
      .toBe('1 paid · 1 waiting · 1 not completed');
  });
});

// ─── The patient label rule ────────────────────────────────────────────────

describe('the label prints no more of a patient than the rest of the app does', () => {
  it('renders the first-name-plus-initial form it was given', async () => {
    mount({ error: null, activity: activity([row({ sessionId: 'a', label: 'Thabo M.' })]) });
    await screen.findByTestId('till-today-list');
    expect(screen.getByTestId('till-today-label-a').textContent).toBe('Thabo M.');
  });

  it('shows the invoice number ONCE when it is standing in for the name', async () => {
    // Not twice: the fallback label IS the invoice number.
    mount({ error: null, activity: activity([
      row({ sessionId: 'b', label: 'INV-b', invoiceNumber: 'INV-b', labelIsInvoice: true }),
    ]) });
    await screen.findByTestId('till-today-list');
    const text = screen.getByTestId('till-today-row-b').textContent ?? '';
    expect(text.match(/INV-b/g)).toHaveLength(1);
  });

  it('shows the invoice number as a SECOND line when a patient name is known', async () => {
    mount({ error: null, activity: activity([
      row({ sessionId: 'a', label: 'Thabo M.', invoiceNumber: 'INV-42', labelIsInvoice: false }),
    ]) });
    await screen.findByTestId('till-today-list');
    const text = screen.getByTestId('till-today-row-a').textContent ?? '';
    expect(text).toContain('Thabo M.');
    expect(text).toContain('INV-42');
  });

  it('renders no SA ID and no cell number, whatever it is handed', async () => {
    mount({ error: null, activity: activity(THREE) });
    await screen.findByTestId('till-today-list');
    const text = screen.getByTestId('till-today-strip').textContent ?? '';
    expect(text).not.toMatch(/\d{13}/);
    expect(text).not.toMatch(/\+27|v1:iv/);
  });
});

// ─── Money ─────────────────────────────────────────────────────────────────

describe('amounts', () => {
  it('formats through the shared formatRand, cents included', async () => {
    mount({ error: null, activity: activity(THREE) });
    await screen.findByTestId('till-today-list');
    expect(screen.getByTestId('till-today-amount-a').textContent).toBe(formatRand(1450.5));
    expect(screen.getByTestId('till-today-amount-b').textContent).toBe('R899.99');
  });

  it('a missing amount renders a dash, not R0.00', async () => {
    mount({ error: null, activity: activity([row({ sessionId: 'a', amount: null })]) });
    await screen.findByTestId('till-today-list');
    expect(screen.getByTestId('till-today-amount-a').textContent).toBe('—');
  });
});

// ─── Empty, loading, error, truncation ─────────────────────────────────────

describe('the states that are not a list of sessions', () => {
  it('a quiet day gets a real empty state, not a blank panel', async () => {
    mount({ error: null, activity: activity([]) });
    const empty = await screen.findByTestId('till-today-empty');
    expect(empty.textContent).toContain('No bills issued at this till yet today');
    expect(screen.queryByTestId('till-today-list')).toBeNull();
    // And it does not fabricate a figure.
    expect(screen.getByTestId('till-today-strip').textContent).not.toMatch(/R0\.00/);
  });

  it('the day summary is withheld when there is nothing to summarise', async () => {
    mount({ error: null, activity: activity([]) });
    await screen.findByTestId('till-today-empty');
    expect(screen.queryByTestId('till-today-summary')).toBeNull();
  });

  it('shows a loading line on first load only', async () => {
    const fn = vi.fn(() => new Promise<{ error: null; activity: TillActivity }>(() => {}));
    render(<TodayActivityStrip getTodaysCounterSessions={fn} />);
    expect(screen.getByTestId('till-today-loading')).toBeTruthy();
  });

  it('surfaces a device-auth error as an alert instead of an empty list', async () => {
    mount({ error: 'This till is locked. Enter the PIN to continue.' });
    const err = await screen.findByTestId('till-today-error');
    expect(err.textContent).toContain('This till is locked');
    expect(screen.queryByTestId('till-today-empty')).toBeNull();
    expect(screen.queryByTestId('till-today-list')).toBeNull();
  });

  it('states the cap rather than ending the list silently', async () => {
    mount({ error: null, activity: activity(THREE, { truncated: true }) });
    await screen.findByTestId('till-today-truncated');
    expect(screen.getByTestId('till-today-truncated').textContent)
      .toContain('Showing the 3 most recent');
  });

  it('says nothing about a cap on a day that fits', async () => {
    mount({ error: null, activity: activity(THREE) });
    await screen.findByTestId('till-today-list');
    expect(screen.queryByTestId('till-today-truncated')).toBeNull();
  });
});

// ─── Refresh ───────────────────────────────────────────────────────────────

describe('refresh is explicit — it does NOT poll', () => {
  it('reads once on mount', async () => {
    const { fn } = mount({ error: null, activity: activity(THREE) });
    await screen.findByTestId('till-today-list');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('reads again when the teller asks, and not otherwise', async () => {
    const { fn } = mount({ error: null, activity: activity(THREE) });
    await screen.findByTestId('till-today-list');
    await userEvent.click(screen.getByTestId('till-today-refresh'));
    await waitFor(() => expect(fn).toHaveBeenCalledTimes(2));
  });

  it('never reads again on its own, however long the screen is left open', async () => {
    // The behavioural version of "does not poll", and the one that matters:
    // requireUnlockedDevice stamps last_activity_at on every successful call and
    // the till re-locks after TILL_IDLE_TIMEOUT_MS of inactivity, so a strip
    // polling all day would mean an unattended front-desk till never locks
    // again.
    //
    // Asserted by advancing the clock rather than by spying on setInterval:
    // the test environment itself schedules intervals, so a spy assertion would
    // fail for reasons that have nothing to do with this component. Ten minutes
    // is longer than any plausible poll and longer than the idle timeout.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const fn = vi.fn().mockResolvedValue({ error: null, activity: activity(THREE) });
      render(<TodayActivityStrip getTodaysCounterSessions={fn} />);
      await vi.waitFor(() => expect(screen.getByTestId('till-today-list')).toBeTruthy());
      expect(fn).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
      expect(fn).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the previous list visible while refreshing', async () => {
    // A list that vanishes on every refresh is a list the reader waits for twice.
    let resolveSecond: (v: { error: null; activity: TillActivity }) => void = () => {};
    const fn = vi.fn()
      .mockResolvedValueOnce({ error: null, activity: activity(THREE) })
      .mockImplementationOnce(() => new Promise((r) => { resolveSecond = r; }));
    render(<TodayActivityStrip getTodaysCounterSessions={fn} />);
    await screen.findByTestId('till-today-list');

    await userEvent.click(screen.getByTestId('till-today-refresh'));
    expect(screen.getByTestId('till-today-list')).toBeTruthy();
    expect(screen.queryByTestId('till-today-loading')).toBeNull();

    resolveSecond({ error: null, activity: activity(THREE) });
    await waitFor(() => expect(screen.getByTestId('till-today-refresh').textContent).toBe('Refresh'));
  });
});

// ─── Source pins ───────────────────────────────────────────────────────────

describe('source pins', () => {
  const SRC  = readFileSync(resolve(process.cwd(), 'app/practice/pos/TodayActivityStrip.tsx'), 'utf8');
  const code = stripComments(SRC);

  it('formats money through the shared helper, not the local copy next door', () => {
    // CounterSessionForm carries its own formatRand — a duplicate of
    // billHelpers'. Reaching for it here would spread it further.
    expect(code).toMatch(/import \{ formatRand \} from '@\/app\/practice\/billHelpers'/);
    expect(code).not.toMatch(/function formatRand/);
    expect(code).not.toMatch(/toFixed|toLocaleString|style: 'currency'/);
  });

  it('renders no dates or times at all — there is no shared time-of-day formatter', () => {
    expect(code).not.toMatch(/new Date\(|toISOString|getHours|toLocaleTimeString|toLocaleDateString/);
    expect(code).not.toMatch(/\bHH:MM\b|padStart\(2, '0'\)/);
  });

  it('never polls', () => {
    expect(code).not.toMatch(/setInterval|setTimeout/);
  });

  it('knows nothing about device auth — TillShell injects the credential', () => {
    expect(code).not.toMatch(/deviceSecret|localStorage|requireUnlockedDevice|secret_hash/);
  });

  it('holds no session state — it cannot be reset by "Start next patient"', () => {
    // The state CounterSessionForm's handleStartNext clears. None of it lives
    // here, which is why the strip survives the reset by construction.
    // (The empty-state COPY contains the word "issued"; what must not exist is
    // state named for an issued session, so these are the identifiers.)
    expect(code).not.toMatch(/setIssued|const \[issued|issued\.token|qrDataUrl|expiresAt/);
  });

  it('queries nothing itself — it calls the injected action', () => {
    expect(code).not.toMatch(/from\('checkout_sessions'\)|createClient|supabase/);
  });
});
