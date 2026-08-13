import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stripComments } from '@/lib/testing/stripComments';
import {
  resolveTodaysTillActivity,
  TILL_ACTIVITY_LIMIT,
} from './tillActivity';
import { sastMidnight, sastDateString } from '@/lib/payments/payoutWindow';

// ─── Today's till activity ──────────────────────────────────────────────────
//
// Three things must hold, and the fake below is built so that each one can
// actually fail:
//
//   SCOPING. The till has no Supabase user session, so RLS is not the boundary
//   here — the .eq('practice_id', …) in this module IS. A fake that ignored
//   filters would pass whether that filter existed or not, so this one honours
//   them and records every filter applied.
//
//   THE SAST DAY. "Today" is the practice's local day, and the interesting case
//   is the boundary instant: 21:59 UTC and 22:00 UTC on the same date are
//   different SAST days. Tested AT the boundary, not near it.
//
//   THE OUTCOME. Three buckets a receptionist can scan. The failure that matters
//   is an unfinished session reading as paid, so unknown stages are pinned to
//   fall to 'pending' rather than 'done'.

const PRACTICE = 'prac-1';
const OTHER    = 'prac-2';

// 14 Aug 2026, 09:00 SAST. Today's SAST day starts at 2026-08-13T22:00:00Z.
const NOW      = new Date('2026-08-14T07:00:00.000Z');
const TODAY    = '2026-08-14';
const DAY_START = sastMidnight(TODAY);            // 2026-08-13T22:00:00.000Z

type Row = Record<string, unknown>;

function session(over: Row & { id: string }): Row {
  return {
    practice_id: PRACTICE,
    stage:       'completed',
    created_at:  '2026-08-14T06:00:00.000Z',
    plans: {
      total_amount:   1450.5,
      invoice_number: `INV-${over.id}`,
      patient: { first_name: 'Thabo', last_name: 'Mokoena' },
    },
    ...over,
  };
}

// ── The fake ────────────────────────────────────────────────────────────────

type Filter = { col: string; op: 'eq' | 'gte'; val: unknown };
type Recorder = { calls: Array<{ table: string; filters: Filter[]; limit: number | null }> };

function makeClient(rows: Row[], rec: Recorder = { calls: [] }) {
  return {
    rec,
    from(table: string) {
      if (table !== 'checkout_sessions') {
        throw new Error(`fake: unmodelled table "${table}" — model it or the test is vacuous`);
      }
      const filters: Filter[] = [];
      let cap: number | null = null;
      let descending = false;

      const b: Record<string, unknown> = {
        select: () => b,
        eq:  (c: string, v: unknown) => { filters.push({ col: c, op: 'eq',  val: v }); return b; },
        gte: (c: string, v: unknown) => { filters.push({ col: c, op: 'gte', val: v }); return b; },
        order: (_c: string, o?: { ascending?: boolean }) => { descending = o?.ascending === false; return b; },
        limit: (n: number) => { cap = n; return b; },
        then: (onFulfilled: (v: { data: Row[] }) => unknown) => {
          rec.calls.push({ table, filters, limit: cap });
          let out = rows.filter((r) =>
            filters.every((f) =>
              f.op === 'eq'
                ? r[f.col] === f.val
                : String(r[f.col]) >= String(f.val),
            ),
          );
          out = [...out].sort((a, z) => String(a.created_at) < String(z.created_at) ? -1 : 1);
          if (descending) out.reverse();
          if (cap !== null) out = out.slice(0, cap);
          return Promise.resolve({ data: out }).then(onFulfilled);
        },
      };
      return b;
    },
  };
}

const run = (rows: Row[], now = NOW, limit?: number) =>
  resolveTodaysTillActivity(makeClient(rows), PRACTICE, now, limit);

// ─── The SAST day boundary ─────────────────────────────────────────────────

describe('"today" is the practice\'s SAST day, tested at the boundary instant', () => {
  it('the boundary is 22:00 UTC the previous calendar day', () => {
    // Stated so the fixtures below cannot be misread as arbitrary.
    expect(DAY_START.toISOString()).toBe('2026-08-13T22:00:00.000Z');
    expect(sastDateString(NOW)).toBe(TODAY);
  });

  it('a session at EXACTLY SAST midnight is today (inclusive)', async () => {
    const r = await run([session({ id: 'edge', created_at: DAY_START.toISOString() })]);
    expect(r.sessions.map((s) => s.sessionId)).toEqual(['edge']);
  });

  it('a session ONE MILLISECOND before SAST midnight is yesterday', async () => {
    const justBefore = new Date(DAY_START.getTime() - 1).toISOString();
    const r = await run([session({ id: 'yesterday', created_at: justBefore })]);
    expect(r.sessions).toEqual([]);
  });

  it('21:59 UTC and 22:00 UTC on 13 Aug fall on DIFFERENT SAST days', async () => {
    // The exact confusion the shared helpers exist to prevent: both are "13
    // August" in UTC, but only the second is 14 August in Johannesburg.
    const r = await run([
      session({ id: 'utc-2159', created_at: '2026-08-13T21:59:00.000Z' }),
      session({ id: 'utc-2200', created_at: '2026-08-13T22:00:00.000Z' }),
    ]);
    expect(r.sessions.map((s) => s.sessionId)).toEqual(['utc-2200']);
  });

  it('yesterday\'s sessions never appear, however many there are', async () => {
    const r = await run([
      session({ id: 'y1', created_at: '2026-08-13T10:00:00.000Z' }),
      session({ id: 'y2', created_at: '2026-08-12T10:00:00.000Z' }),
      session({ id: 't1', created_at: '2026-08-14T05:00:00.000Z' }),
    ]);
    expect(r.sessions.map((s) => s.sessionId)).toEqual(['t1']);
  });

  it('reports the SAST date it covered, so a caller can state it plainly', async () => {
    const r = await run([]);
    expect(r.sastDate).toBe(TODAY);
  });

  it('late-evening SAST still resolves to that same SAST day, not the UTC one', async () => {
    // 14 Aug 23:30 SAST is 21:30 UTC on the 14th — same UTC day here, but the
    // window must still start at the 13th 22:00Z.
    const r = await run(
      [session({ id: 'late', created_at: '2026-08-14T21:30:00.000Z' })],
      new Date('2026-08-14T21:31:00.000Z'),
    );
    expect(r.sastDate).toBe(TODAY);
    expect(r.sessions.map((s) => s.sessionId)).toEqual(['late']);
  });

  it('the query filters on created_at >= SAST midnight and nothing else time-wise', async () => {
    const rec: Recorder = { calls: [] };
    await resolveTodaysTillActivity(makeClient([], rec), PRACTICE, NOW);
    const call = rec.calls[0];
    const gte  = call.filters.find((f) => f.op === 'gte');
    expect(gte).toEqual({ col: 'created_at', op: 'gte', val: DAY_START.toISOString() });
    // No upper bound: a session cannot be created in the future, so ">= today"
    // already IS "today" — and adding an end boundary would mean stepping a day
    // forward, which is date arithmetic this module is not allowed to invent.
    expect(call.filters.filter((f) => f.op === 'gte')).toHaveLength(1);
  });
});

// ─── Adversarial: one practice's day only ──────────────────────────────────

describe('adversarial — a device never sees another practice\'s sessions', () => {
  it('another practice\'s sessions are absent even when they are today\'s', async () => {
    const r = await run([
      session({ id: 'mine',   practice_id: PRACTICE }),
      session({ id: 'theirs', practice_id: OTHER, plans: { total_amount: 999999, invoice_number: 'INV-SECRET', patient: { first_name: 'Someone', last_name: 'Else' } } }),
    ]);
    expect(r.sessions.map((s) => s.sessionId)).toEqual(['mine']);
    expect(JSON.stringify(r)).not.toContain('INV-SECRET');
    expect(JSON.stringify(r)).not.toContain('999999');
    expect(JSON.stringify(r)).not.toContain('Someone');
  });

  it('a valid device for a DIFFERENT practice gets that practice\'s day, not this one', async () => {
    // The mirror case, so the filter is not one-directional: the same row set,
    // read as prac-2, must return only prac-2's session.
    const rows = [
      session({ id: 'mine',   practice_id: PRACTICE }),
      session({ id: 'theirs', practice_id: OTHER }),
    ];
    const r = await resolveTodaysTillActivity(makeClient(rows), OTHER, NOW);
    expect(r.sessions.map((s) => s.sessionId)).toEqual(['theirs']);
  });

  it('the practice filter is applied on EVERY read this module makes', async () => {
    const rec: Recorder = { calls: [] };
    await resolveTodaysTillActivity(makeClient([session({ id: 'a' })], rec), PRACTICE, NOW);
    expect(rec.calls.length).toBeGreaterThan(0);
    for (const call of rec.calls) {
      expect(
        call.filters.find((f) => f.col === 'practice_id' && f.op === 'eq'),
        `${call.table} read without an eq practice_id`,
      ).toEqual({ col: 'practice_id', op: 'eq', val: PRACTICE });
    }
  });

  it('reads only checkout_sessions — the fake throws on anything else', async () => {
    // Guards against a future join or second query slipping in unnoticed.
    await expect(run([session({ id: 'a' })])).resolves.toBeTruthy();
  });
});

// ─── The three outcomes ────────────────────────────────────────────────────

describe('outcome buckets', () => {
  it('maps every stage 0085 allows', async () => {
    const r = await run([
      session({ id: 's-completed', stage: 'completed', created_at: '2026-08-14T06:05:00.000Z' }),
      session({ id: 's-created',   stage: 'created',   created_at: '2026-08-14T06:04:00.000Z' }),
      session({ id: 's-scanned',   stage: 'scanned',   created_at: '2026-08-14T06:03:00.000Z' }),
      session({ id: 's-declined',  stage: 'declined',  created_at: '2026-08-14T06:02:00.000Z' }),
      session({ id: 's-expired',   stage: 'expired',   created_at: '2026-08-14T06:01:00.000Z' }),
    ]);
    const by = new Map(r.sessions.map((s) => [s.sessionId, s.outcome]));
    expect(by.get('s-completed')).toBe('done');
    expect(by.get('s-created')).toBe('pending');
    expect(by.get('s-scanned')).toBe('pending');
    expect(by.get('s-declined')).toBe('stopped');
    expect(by.get('s-expired')).toBe('stopped');
  });

  it('keeps the raw stage so the UI can name expired vs declined precisely', async () => {
    const r = await run([
      session({ id: 'e', stage: 'expired',  created_at: '2026-08-14T06:02:00.000Z' }),
      session({ id: 'd', stage: 'declined', created_at: '2026-08-14T06:01:00.000Z' }),
    ]);
    expect(r.sessions.map((s) => [s.stage, s.outcome])).toEqual([
      ['expired', 'stopped'], ['declined', 'stopped'],
    ]);
  });

  it('an UNKNOWN stage falls to pending, never to done', async () => {
    // The one failure that would actually hurt: a receptionist told a bill went
    // through when the product does not know that it did.
    const r = await run([session({ id: 'weird', stage: 'something_new' })]);
    expect(r.sessions[0].outcome).toBe('pending');
    expect(r.sessions[0].outcome).not.toBe('done');
  });

  it('counts each bucket across the whole day', async () => {
    const r = await run([
      session({ id: 'a', stage: 'completed', created_at: '2026-08-14T06:05:00.000Z' }),
      session({ id: 'b', stage: 'completed', created_at: '2026-08-14T06:04:00.000Z' }),
      session({ id: 'c', stage: 'scanned',   created_at: '2026-08-14T06:03:00.000Z' }),
      session({ id: 'd', stage: 'expired',   created_at: '2026-08-14T06:02:00.000Z' }),
    ]);
    expect([r.doneCount, r.pendingCount, r.stoppedCount]).toEqual([2, 1, 1]);
  });
});

// ─── Ordering, amounts, labels ─────────────────────────────────────────────

describe('what each row carries', () => {
  it('most recent first', async () => {
    const r = await run([
      session({ id: 'old',    created_at: '2026-08-14T05:00:00.000Z' }),
      session({ id: 'newest', created_at: '2026-08-14T06:30:00.000Z' }),
      session({ id: 'mid',    created_at: '2026-08-14T06:00:00.000Z' }),
    ]);
    expect(r.sessions.map((s) => s.sessionId)).toEqual(['newest', 'mid', 'old']);
  });

  it('the amount comes from the PLAN — checkout_sessions has no amount column', async () => {
    const r = await run([session({ id: 'a', plans: { total_amount: 2750.25, invoice_number: 'INV-9', patient: null } })]);
    expect(r.sessions[0].amount).toBe(2750.25);
  });

  it('a numeric-as-string amount is coerced, not printed raw', async () => {
    const r = await run([session({ id: 'a', plans: { total_amount: '1450.50', invoice_number: 'INV-9', patient: null } })]);
    expect(r.sessions[0].amount).toBe(1450.5);
  });

  it('a missing plan leaves the amount null rather than inventing a zero', async () => {
    const r = await run([session({ id: 'a', plans: null })]);
    expect(r.sessions[0].amount).toBeNull();
    expect(r.sessions[0].invoiceNumber).toBeNull();
  });

  it('handles PostgREST returning the embed as an array', async () => {
    const r = await run([session({
      id: 'a',
      plans: [{ total_amount: 100, invoice_number: 'INV-A', patient: [{ first_name: 'Nomsa', last_name: 'Dlamini' }] }],
    })]);
    expect(r.sessions[0].amount).toBe(100);
    expect(r.sessions[0].label).toBe('Nomsa D.');
  });
});

// ─── The patient label rule ────────────────────────────────────────────────

describe('the patient label follows the payoutPatientLabel rule', () => {
  it('prints a first name and a surname INITIAL — never the full surname', async () => {
    const r = await run([session({ id: 'a', plans: { total_amount: 100, invoice_number: 'INV-A', patient: { first_name: 'Thabo', last_name: 'Mokoena' } } })]);
    expect(r.sessions[0].label).toBe('Thabo M.');
    // The thing a shared till screen must never show to the next person in the
    // queue.
    expect(JSON.stringify(r)).not.toContain('Mokoena');
  });

  it('falls back to the INVOICE NUMBER when no patient is attached yet', async () => {
    // plans.patient_id is NULL until the phone-side checkout resolves who is
    // paying, so an in-progress or abandoned session has no name to show — ever.
    const r = await run([session({ id: 'a', stage: 'created', plans: { total_amount: 100, invoice_number: 'INV-77', patient: null } })]);
    expect(r.sessions[0].label).toBe('INV-77');
    expect(r.sessions[0].labelIsInvoice).toBe(true);
  });

  it('flags when the label IS the invoice, so the UI does not print it twice', async () => {
    const r = await run([
      session({ id: 'named',   created_at: '2026-08-14T06:02:00.000Z' }),
      session({ id: 'unnamed', created_at: '2026-08-14T06:01:00.000Z', plans: { total_amount: 1, invoice_number: 'INV-X', patient: null } }),
    ]);
    const by = new Map(r.sessions.map((s) => [s.sessionId, s]));
    expect(by.get('named')!.labelIsInvoice).toBe(false);
    expect(by.get('unnamed')!.labelIsInvoice).toBe(true);
  });

  it('a dash when there is neither a patient nor an invoice number', async () => {
    const r = await run([session({ id: 'a', plans: { total_amount: 100, invoice_number: null, patient: null } })]);
    expect(r.sessions[0].label).toBe('—');
    expect(r.sessions[0].labelIsInvoice).toBe(false);
  });

  it('never reads the encrypted SA ID, whatever the row carries', async () => {
    const r = await run([session({ id: 'a', sa_id_number: 'v1:iv:tag:CIPHERTEXT' })]);
    expect(JSON.stringify(r)).not.toContain('CIPHERTEXT');
    expect(JSON.stringify(r)).not.toContain('sa_id');
  });
});

// ─── The cap ───────────────────────────────────────────────────────────────

describe('the runaway cap is stated, never silent', () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) =>
    session({ id: `s${i}`, created_at: `2026-08-14T0${(i % 9)}:0${i % 10}:00.000Z` }));

  it('caps at TILL_ACTIVITY_LIMIT and says so', async () => {
    const r = await run(many(TILL_ACTIVITY_LIMIT + 5));
    expect(r.sessions).toHaveLength(TILL_ACTIVITY_LIMIT);
    expect(r.truncated).toBe(true);
  });

  it('does not claim truncation on a day that fits', async () => {
    const r = await run(many(3));
    expect(r.sessions).toHaveLength(3);
    expect(r.truncated).toBe(false);
  });

  it('passes the limit to the query rather than slicing after the fact', async () => {
    const rec: Recorder = { calls: [] };
    await resolveTodaysTillActivity(makeClient([], rec), PRACTICE, NOW, 7);
    expect(rec.calls[0].limit).toBe(7);
  });
});

// ─── Empty day ─────────────────────────────────────────────────────────────

describe('a quiet day', () => {
  it('returns empty counts and an empty list, claiming nothing', async () => {
    const r = await run([]);
    expect(r.sessions).toEqual([]);
    expect([r.doneCount, r.pendingCount, r.stoppedCount]).toEqual([0, 0, 0]);
    expect(r.truncated).toBe(false);
  });
});

// ─── Source pins ───────────────────────────────────────────────────────────

describe('source pins — shared helpers only, no auth decision, no formatting', () => {
  const SRC  = readFileSync(resolve(process.cwd(), 'lib/practice/tillActivity.ts'), 'utf8');
  const code = stripComments(SRC);

  it('gets "today" from the shared SAST helpers and does no date maths', () => {
    expect(code).toMatch(/from '@\/lib\/payments\/payoutWindow'/);
    expect(code).toMatch(/sastDateString\(now\)/);
    expect(code).toMatch(/sastMidnight\(sastDate\)/);
    // The whole class of bug payoutWindow exists to prevent.
    expect(code).not.toMatch(/getDay\(|getMonth\(|getDate\(|setDate\(|toLocaleDateString/);
    expect(code).not.toMatch(/24 \* 60 \* 60|86400/);
    // ONE `new Date(` — the default-argument clock. Counted so another cannot
    // hide behind it.
    expect((code.match(/new Date\(/g) ?? []).length).toBe(1);
    expect(code).toMatch(/now:\s+Date = new Date\(\)/);
  });

  it('formats no money — it returns a number and lets the component format it', () => {
    expect(code).not.toMatch(/toFixed|toLocaleString|formatRand|`R\$\{/);
  });

  it('reuses payoutPatientLabel rather than writing a second name rule', () => {
    expect(code).toMatch(/import \{ payoutPatientLabel \}/);
    expect(code).toMatch(/payoutPatientLabel\(/);
    // No local initial-taking of its own.
    expect(code).not.toMatch(/charAt\(0\)|last_name\?\./);
  });

  it('makes NO authority decision — practiceId is a parameter it trusts', () => {
    expect(code).not.toMatch(/requireUnlockedDevice|hashTillSecret|till_devices/);
    expect(code).not.toMatch(/auth\.getUser|practice_members|practice_group_members/);
  });

  it('never selects the encrypted SA ID or the cell number', () => {
    expect(code).not.toMatch(/sa_id_number/);
    expect(code).not.toMatch(/cell_e164/);
  });

  it('applies practice_id before the day filter, in one place', () => {
    const scope = code.indexOf(".eq('practice_id', practiceId)");
    const day   = code.indexOf(".gte('created_at'");
    expect(scope).toBeGreaterThan(0);
    expect(day).toBeGreaterThan(scope);
    expect((code.match(/\.eq\('practice_id'/g) ?? []).length).toBe(1);
  });

  it('writes nothing — the strip is a read', () => {
    expect(code).not.toMatch(/\.insert\(|\.update\(|\.upsert\(|\.delete\(|\.rpc\(/);
  });
});
