import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stripComments } from '@/lib/testing/stripComments';
import { OPEN_CHECKOUT_STAGES, CLOSING_STAGES } from './declineCheckoutSessions';

// ─── The 'payment_failed' stage: wiring, vocabulary, and reachability ─────
//
// The behavioural proof is in declineCheckoutSessions.pglite.test.ts, which
// runs the real UPDATE against a real Postgres with both migrations applied.
// This file covers what a database cannot:
//
//   • that the webhook's cancellation branch actually propagates, after its
//     plan write and without being able to break the route's 200
//   • that every value the CHECK permits is a value something WRITES — the
//     failure mode that produced this whole task, where 'declined' sat in the
//     constraint unwritten for months while the strip lied about those bills
//   • that the three stopped-endings keep three distinct words, because they
//     ask the front desk for three different actions

const ROOT    = resolve(process.cwd());
const read    = (p: string) => stripComments(readFileSync(resolve(ROOT, p), 'utf8'));
const rawRead = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

const MIG_0085 = rawRead('supabase/migrations/0085_checkout_sessions.sql').replace(/\r\n/g, '\n');
const MIG_0095 = rawRead('supabase/migrations/0095_checkout_session_payment_failed_stage.sql')
  .replace(/\r\n/g, '\n');

/** Every stage value the constraint permits AFTER 0095. */
const PERMITTED_STAGES: string[] = (() => {
  const m = MIG_0095.match(/CHECK \(stage IN \(([^)]*)\)\)/);
  if (!m) throw new Error('0095 no longer declares a stage CHECK');
  return m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, ''));
})();

describe('migration 0095 replaces the constraint rather than layering a second one', () => {
  it('finds the old constraint by what it CONSTRAINS, not by a guessed name', () => {
    // 0085 declares the CHECK inline and unnamed, so its name is whatever
    // Postgres derived. A DROP ... IF EXISTS on a guessed name would silently
    // do nothing, leave the original in force, and let the ADD below appear to
    // succeed while every payment_failed write is still rejected.
    expect(MIG_0095).toMatch(/FROM pg_constraint/);
    expect(MIG_0095).toMatch(/rel\.relname\s*=\s*'checkout_sessions'/);
    expect(MIG_0095).toMatch(/pg_get_constraintdef\(con\.oid\) LIKE '%stage%'/);
    expect(MIG_0095).toMatch(/DROP CONSTRAINT %I/);
  });

  it('keeps every value 0085 already permitted — this widens, it does not replace', () => {
    const before = (MIG_0085.match(/CHECK \(stage IN \(([^)]*)\)\)/)![1])
      .split(',').map((s) => s.trim().replace(/^'|'$/g, ''));
    for (const stage of before) expect(PERMITTED_STAGES).toContain(stage);
    expect(PERMITTED_STAGES).toContain('payment_failed');
    expect(PERMITTED_STAGES).toHaveLength(before.length + 1);
  });

  it('is a new migration, not an amendment of 0085', () => {
    // 0085 was amended in place once, on the stated grounds that its table had
    // "never shipped anywhere". The till has shipped since, so 0085 may already
    // be recorded as applied and an amended copy would simply be skipped.
    expect(MIG_0085).not.toContain('payment_failed');
  });
});

describe('every permitted stage has a writer — no value sits unreachable', () => {
  // The bug this whole line of work came from: 'declined' was designed into
  // 0085's CHECK and never written by anything, so the till reported "Waiting
  // on patient" for refused bills. A constraint value with no writer is a
  // promise the product does not keep.
  const WRITERS: Record<string, { file: string; pattern: RegExp }> = {
    created:        { file: 'app/practice/pos/actions.ts',                 pattern: /from\('checkout_sessions'\)\.insert\(/ },
    scanned:        { file: 'supabase/migrations/0085_checkout_sessions.sql', pattern: /SET stage\s+= 'scanned'/ },
    completed:      { file: 'app/checkout/[token]/complete/page.tsx',      pattern: /update\(\{ stage: 'completed' \}\)/ },
    expired:        { file: 'supabase/migrations/0085_checkout_sessions.sql', pattern: /SET stage\s+= 'expired'/ },
    declined:       { file: 'lib/checkout/declineCheckoutSessions.ts',     pattern: /'declined'/ },
    payment_failed: { file: 'lib/checkout/declineCheckoutSessions.ts',     pattern: /'payment_failed'/ },
  };

  it('the writer map covers exactly the permitted set, with nothing left over', () => {
    expect(Object.keys(WRITERS).sort()).toEqual([...PERMITTED_STAGES].sort());
  });

  it.each(PERMITTED_STAGES)('%s is written by something', (stage) => {
    const w = WRITERS[stage];
    const source = w.file.endsWith('.sql') ? rawRead(w.file) : read(w.file);
    expect(source, `${stage} via ${w.file}`).toMatch(w.pattern);
  });
});

describe('the webhook propagates its cancellation to the session', () => {
  const ROUTE = read('app/api/payments/peach/webhook/route.ts');

  it('calls the shared helper rather than inlining a second UPDATE shape', () => {
    expect(ROUTE).toMatch(/failCheckoutSessionsForPlan\(plan\.id, supabase\)/);
    expect(ROUTE).not.toMatch(/from\('checkout_sessions'\)/);
  });

  it('propagates AFTER the plan status write, which is untouched', () => {
    const planWrite = ROUTE.indexOf("update({ status: 'cancelled' })");
    const propagate = ROUTE.indexOf('failCheckoutSessionsForPlan(');
    expect(planWrite).toBeGreaterThan(0);
    expect(propagate).toBeGreaterThan(planWrite);
    // The plan write itself is byte-for-byte what it was — the task forbade
    // changing it, and the session is a follower of that record, not a peer.
    expect(ROUTE).toMatch(/from\('plans'\)\.update\(\{ status: 'cancelled' \}\)\.eq\('id', plan\.id\)/);
  });

  it('reuses the handler\'s own service-role client instead of building a second', () => {
    expect(ROUTE).toMatch(/failCheckoutSessionsForPlan\(plan\.id, supabase\)/);
  });

  it('cannot break the route\'s 200 — logged, never thrown or returned', () => {
    const from = ROUTE.indexOf('failCheckoutSessionsForPlan(');
    const tail = ROUTE.slice(from, from + 700);
    expect(tail).toMatch(/console\.error\('\[peach-webhook\] ALERT/);
    expect(tail).not.toMatch(/throw /);
    expect(tail).not.toMatch(/return NextResponse/);
  });

  it('sits behind the same three gates the cancellation does', () => {
    // instalment 1, a plan still at pending_first_payment, and a payment.failure
    // event that is not a refund/reversal. Pinned because the new stage's
    // MEANING is derived from where it is written, not from a reason string.
    const failure = ROUTE.slice(ROUTE.indexOf('async function handlePaymentFailure'));
    const gate    = failure.indexOf('payment.instalment_number === 1');
    const status  = failure.indexOf("plan.status !== 'pending_first_payment'");
    const propag  = failure.indexOf('failCheckoutSessionsForPlan(');
    expect(gate).toBeGreaterThan(0);
    expect(status).toBeGreaterThan(gate);
    expect(propag).toBeGreaterThan(status);
    expect(failure).toMatch(/paymentType === 'RF' \|\| payload\.paymentType === 'RV'/);
  });

  it("'cancelled' still has exactly ONE writer, which is what makes the stage unambiguous", () => {
    // There is no reason code to inspect at the write point — the meaning of
    // 'payment_failed' rests entirely on this branch being the only route to a
    // cancelled plan. A second writer would need its own decision, so it must
    // not slip in unnoticed.
    const all = [
      'app/api/payments/peach/webhook/route.ts',
      'app/patient/actions.ts',
      'app/checkout/[token]/actions.ts',
      'app/patient/orders/settle-actions.ts',
      'lib/payments/activateFirstInstalment.ts',
      'lib/payments/chargeInstalment.ts',
    ];
    const hits = all.flatMap((f) => {
      const matches = read(f).match(/status: 'cancelled'/g) ?? [];
      return matches.map(() => f);
    });
    expect(hits).toEqual(['app/api/payments/peach/webhook/route.ts']);
  });
});

describe('the till says what to do about it', () => {
  const STRIP = read('app/practice/pos/TodayActivityStrip.tsx');

  it('names the CARD, so the front desk reaches for another one', () => {
    expect(STRIP).toMatch(/payment_failed:\s*'Card didn’t go through'/);
  });

  it('does not blame the patient or the practice', () => {
    // The rendered WORDS only, not the keys — 'payment_failed' is a stage name
    // the database chose; "failed" is a verdict a receptionist would read out.
    const detail = STRIP.slice(STRIP.indexOf('const STOPPED_DETAIL'));
    const block  = detail.slice(0, detail.indexOf('};') + 2);
    const words  = [...block.matchAll(/:\s*'([^']+)'/g)].map((m) => m[1].toLowerCase());
    expect(words.length).toBeGreaterThan(0);
    for (const blame of ['refused', 'rejected', 'invalid', 'wrong', 'error', 'failed', 'fault']) {
      for (const word of words) expect(word, blame).not.toContain(blame);
    }
  });

  it('keeps three DISTINCT words for the three stopped endings', () => {
    // They ask for three different actions — issue it again, try another card,
    // do not retry — so two of them reading the same is a wrong instruction,
    // not a cosmetic slip.
    const detail = STRIP.slice(STRIP.indexOf('const STOPPED_DETAIL'));
    const block  = detail.slice(0, detail.indexOf('};') + 2);
    const words  = [...block.matchAll(/:\s*'([^']+)'/g)].map((m) => m[1]);
    expect(words).toHaveLength(3);
    expect(new Set(words).size).toBe(3);
  });

  it('never reads as a decline — the opposite instruction', () => {
    const detail = STRIP.slice(STRIP.indexOf('const STOPPED_DETAIL'));
    const block  = detail.slice(0, detail.indexOf('};') + 2);
    const line   = block.split('\n').find((l) => l.includes('payment_failed'))!;
    expect(line.toLowerCase()).not.toContain('declin');
  });

  it('echoes the patient\'s own screen rather than inventing a second vocabulary', () => {
    // The failure card the patient is looking at says "Payment didn't go
    // through". Across a counter, one event should not have two names.
    expect(read('app/checkout/[token]/complete/page.tsx')).toMatch(/Payment didn&apos;t go through/);
    expect(STRIP).toMatch(/didn’t go through/);
  });

  it('lands in the stopped bucket, not done or pending', () => {
    const ACTIVITY = read('lib/practice/tillActivity.ts');
    expect(ACTIVITY).toMatch(/payment_failed:\s*'stopped'/);
    expect(ACTIVITY).toMatch(/'created' \| 'scanned' \| 'completed' \| 'declined' \| 'expired' \| 'payment_failed'/);
  });
});

describe('the open/terminal split stays consistent across every surface', () => {
  it('the shared module still treats exactly created + scanned as open', () => {
    expect([...OPEN_CHECKOUT_STAGES]).toEqual(['created', 'scanned']);
    expect(MIG_0085).toContain("IF v_session.stage NOT IN ('created', 'scanned') THEN");
  });

  it('the closing stages are the two endings a PLAN imposes', () => {
    // 'expired' is not here: it is imposed by the clock, from SQL, and is the
    // one ending this module never writes.
    expect([...CLOSING_STAGES]).toEqual(['declined', 'payment_failed']);
    for (const s of CLOSING_STAGES) expect(PERMITTED_STAGES).toContain(s);
    for (const s of OPEN_CHECKOUT_STAGES) expect(CLOSING_STAGES).not.toContain(s);
  });

  it('the till\'s own terminal set is the exact complement of the open set', () => {
    // CounterSessionForm keeps its own copy — importing the shared module would
    // drag a service-role client factory into a client bundle. So the copy is
    // pinned instead: an unhandled stage there means the till polls a dead
    // session forever and "Start next patient" tries to abandon a closed one.
    const FORM = read('app/practice/pos/CounterSessionForm.tsx');
    const set  = FORM.slice(FORM.indexOf('const TERMINAL_STAGES'));
    const listed = [...set.slice(0, set.indexOf(']')).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    const expected = PERMITTED_STAGES.filter((s) => !([...OPEN_CHECKOUT_STAGES] as string[]).includes(s));
    expect(listed.sort()).toEqual(expected.sort());
  });

  it('the till no longer hand-lists stages at each decision point', () => {
    const FORM = read('app/practice/pos/CounterSessionForm.tsx');
    expect(FORM).not.toMatch(/stage !== 'completed' && stage !== 'declined'/);
    expect(FORM).not.toMatch(/stage === 'completed' \|\| stage === 'declined'/);
    expect((FORM.match(/isTerminalStage\(/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it('the server-side stage type admits the new value too', () => {
    expect(read('app/practice/pos/actions.ts')).toMatch(/'payment_failed'/);
  });
});
