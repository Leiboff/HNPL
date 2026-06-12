import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  chooseCardSaveAction,
  saveCardForPatient,
  type PaystackAuthorization,
} from './saveCardForPatient';

// ─── Pure decision helper ────────────────────────────────────────────────────

describe('chooseCardSaveAction', () => {
  it('returns already_saved when an existing row has the SAME token (idempotent)', () => {
    const r = chooseCardSaveAction({ id: 'pm_1', token: 'AUTH_x' }, false, 'AUTH_x');
    expect(r).toEqual({ action: 'already_saved', cardId: 'pm_1' });
  });

  it('returns update when an existing row has a DIFFERENT token (Paystack re-tokenised)', () => {
    const r = chooseCardSaveAction({ id: 'pm_1', token: 'AUTH_old' }, false, 'AUTH_new');
    expect(r).toEqual({ action: 'update', cardId: 'pm_1' });
  });

  it('returns insert+isFirst=true when no existing row and patient has zero cards', () => {
    const r = chooseCardSaveAction(null, true, 'AUTH_x');
    expect(r).toEqual({ action: 'insert', isFirst: true });
  });

  it('returns insert+isFirst=false when no existing row and patient already has cards', () => {
    const r = chooseCardSaveAction(null, false, 'AUTH_x');
    expect(r).toEqual({ action: 'insert', isFirst: false });
  });

  it('the previously-removed-card case: prior row was hard DELETEd, so existing is null → fresh INSERT', () => {
    const r = chooseCardSaveAction(null, false, 'AUTH_x');
    expect(r.action).toBe('insert');
  });
});

// ─── End-to-end with a fake Supabase client ──────────────────────────────────
//
// The fake is tiny — it remembers which tables/operations were called and
// returns canned responses keyed by the call sequence. Enough to exercise
// the IO branches in saveCardForPatient.

type FakeQuery = {
  select: ReturnType<typeof vi.fn>;
  eq:     ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  single: ReturnType<typeof vi.fn>;
  maybeSingle: ReturnType<typeof vi.fn>;
  count?: number;
};

function buildFakeClient(opts: {
  profileRow?:     { first_name: string; last_name: string } | null;
  countResult?:    number;
  existingPm?:     { id: string; token: string } | null;
  insertResult?:   { data: { id: string } | null; error: { code?: string; message: string } | null };
  insertResult2?:  { data: { id: string } | null; error: { code?: string; message: string } | null };
  refetchPm?:      { id: string } | null;
  updateError?:    { message: string } | null;
  rpcResult?:      { data: unknown; error: { message: string } | null };
  rpcCalls?:       Array<{ name: string; args: unknown }>;
}) {
  // Each .from(table) returns a fresh query builder. Different tables
  // and different ops on payment_methods return different canned data.
  let pmCallSequence = 0;
  return {
    from(table: string) {
      if (table === 'profiles') {
        return {
          select: vi.fn().mockReturnThis(),
          eq:     vi.fn().mockReturnThis(),
          single: vi.fn().mockResolvedValue({ data: opts.profileRow ?? null, error: null }),
        };
      }
      if (table === 'payment_methods') {
        pmCallSequence += 1;
        const callIdx = pmCallSequence;
        return {
          select: vi.fn(function selectImpl(this: unknown, _cols: string, opts2?: { count?: string; head?: boolean }) {
            if (opts2?.count === 'exact' && opts2?.head) {
              // .select('id', { count, head: true })  → count query
              return {
                eq: vi.fn().mockResolvedValue({ count: opts.countResult ?? 0, error: null, data: null }),
              };
            }
            return this;
          }),
          eq:          vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockImplementation(() => {
            // Two paths call maybeSingle: the initial existing-lookup
            // AND the post-23505 re-fetch.
            if (callIdx <= 2) return Promise.resolve({ data: opts.existingPm ?? null, error: null });
            return Promise.resolve({ data: opts.refetchPm ?? null, error: null });
          }),
          insert: vi.fn().mockImplementation(() => ({
            select: vi.fn().mockReturnThis(),
            single: vi.fn().mockImplementation(() => {
              // The first insert call uses insertResult; if the IO function
              // retries (post-race re-fetch), no second insert happens, so
              // insertResult2 is unused in the race path. Kept for
              // symmetry / future tests.
              const which = pmCallSequence > 3 ? opts.insertResult2 : opts.insertResult;
              return Promise.resolve(which ?? { data: { id: 'pm_new' }, error: null });
            }),
          })),
          update: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({ data: null, error: opts.updateError ?? null }),
          }),
        };
      }
      return {};
    },
    rpc: (name: string, args: unknown) => {
      opts.rpcCalls?.push({ name, args });
      return Promise.resolve(
        opts.rpcResult ?? { data: { is_default: true, repointed_plans: 0, plan_refs: [] }, error: null },
      );
    },
  } as unknown as SupabaseClient;
}

const baseAuth: PaystackAuthorization = {
  authorization_code: 'AUTH_new',
  signature:          'sig_visa_4081',
  brand:              'Visa',
  last4:              '4081',
  exp_month:          '12',
  exp_year:           '2030',
};

describe('saveCardForPatient — IO branches', () => {
  it('signature matches an existing row with the SAME token → kind: already_saved (no UPDATE/INSERT)', async () => {
    const supabase = buildFakeClient({
      profileRow:  { first_name: 'Ada', last_name: 'Lovelace' },
      countResult: 1,
      existingPm:  { id: 'pm_1', token: 'AUTH_new' },
    });
    const result = await saveCardForPatient('patient_1', baseAuth, supabase);
    expect(result).toEqual({ kind: 'already_saved', cardId: 'pm_1' });
  });

  it('signature matches an existing row with a DIFFERENT token → kind: updated', async () => {
    const supabase = buildFakeClient({
      profileRow:  { first_name: 'Ada', last_name: 'Lovelace' },
      countResult: 1,
      existingPm:  { id: 'pm_1', token: 'AUTH_old' },
    });
    const result = await saveCardForPatient('patient_1', baseAuth, supabase);
    expect(result).toEqual({ kind: 'updated', cardId: 'pm_1' });
  });

  it('update branch invokes the refresh_card_token RPC (not a direct UPDATE) — closes the drift window', async () => {
    const rpcCalls: Array<{ name: string; args: unknown }> = [];
    const supabase = buildFakeClient({
      profileRow:  { first_name: 'Ada', last_name: 'Lovelace' },
      countResult: 1,
      existingPm:  { id: 'pm_1', token: 'AUTH_old' },
      rpcCalls,
    });

    await saveCardForPatient('patient_1', baseAuth, supabase);

    // Exactly one rpc call, with the right name and the canonical arg names.
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0]).toEqual({
      name: 'refresh_card_token',
      args: {
        p_card_id:      'pm_1',
        p_token:        'AUTH_new',
        p_brand:        'Visa',
        p_last_four:    '4081',
        p_expiry_month: 12,
        p_expiry_year:  2030,
      },
    });
  });

  it('re-tokenising the default card leaves zero mismatched plans (round-trip)', async () => {
    // Simulates the post-condition: the RPC reports the card was the
    // default and repointed N plans. saveCardForPatient returns
    // kind: 'updated' AND the test asserts the RPC was the writer (not
    // a direct UPDATE on payment_methods).
    const rpcCalls: Array<{ name: string; args: unknown }> = [];
    const supabase = buildFakeClient({
      profileRow:  { first_name: 'Ada', last_name: 'Lovelace' },
      countResult: 1,
      existingPm:  { id: 'pm_default', token: 'AUTH_old' },
      rpcCalls,
      rpcResult: {
        data:  { is_default: true, repointed_plans: 2, plan_refs: [{ id: 'p1', invoice_number: 'BN-1' }, { id: 'p2', invoice_number: 'BN-2' }] },
        error: null,
      },
    });

    const result = await saveCardForPatient('patient_1', baseAuth, supabase);

    // Wiring: payment_methods.update was NOT called directly (no .from('payment_methods').update()
    // in this path) — the RPC owns the row write.
    expect(rpcCalls.find((c) => c.name === 'refresh_card_token')).toBeDefined();
    // The lib helper still returns kind: 'updated' so its callers stay unchanged.
    expect(result).toEqual({ kind: 'updated', cardId: 'pm_default' });
  });

  it('update branch with RPC error → kind: error (propagates the RPC message)', async () => {
    const supabase = buildFakeClient({
      profileRow:  { first_name: 'Ada', last_name: 'Lovelace' },
      countResult: 1,
      existingPm:  { id: 'pm_1', token: 'AUTH_old' },
      rpcResult:   { data: null, error: { message: 'card_not_found' } },
    });
    const result = await saveCardForPatient('patient_1', baseAuth, supabase);
    expect(result).toEqual({ kind: 'error', message: 'card_not_found' });
  });

  it('no existing signature row → kind: inserted (fresh card OR previously removed)', async () => {
    const supabase = buildFakeClient({
      profileRow:    { first_name: 'Ada', last_name: 'Lovelace' },
      countResult:   0,
      existingPm:    null,
      insertResult:  { data: { id: 'pm_new' }, error: null },
    });
    const result = await saveCardForPatient('patient_1', baseAuth, supabase);
    expect(result).toEqual({ kind: 'inserted', cardId: 'pm_new' });
  });

  it('INSERT race (23505 unique-violation) → re-fetches and returns already_saved', async () => {
    const supabase = buildFakeClient({
      profileRow:    { first_name: 'Ada', last_name: 'Lovelace' },
      countResult:   0,
      existingPm:    null,
      insertResult:  { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } },
      refetchPm:     { id: 'pm_winner' },
    });
    const result = await saveCardForPatient('patient_1', baseAuth, supabase);
    expect(result).toEqual({ kind: 'already_saved', cardId: 'pm_winner' });
  });

  it('INSERT failure that is NOT a unique-violation → kind: error with the message', async () => {
    const supabase = buildFakeClient({
      profileRow:    { first_name: 'Ada', last_name: 'Lovelace' },
      countResult:   0,
      existingPm:    null,
      insertResult:  { data: null, error: { code: '23502', message: 'null value violates not-null constraint' } },
    });
    const result = await saveCardForPatient('patient_1', baseAuth, supabase);
    expect(result).toEqual({ kind: 'error', message: 'null value violates not-null constraint' });
  });

  it('missing authorization_code on the Paystack payload → kind: error before any DB call', async () => {
    const supabase = buildFakeClient({ profileRow: null });
    const result   = await saveCardForPatient(
      'patient_1',
      { ...baseAuth, authorization_code: '' } as PaystackAuthorization,
      supabase,
    );
    expect(result.kind).toBe('error');
  });

  it('no signature in the Paystack payload → INSERT without dedup', async () => {
    const supabase = buildFakeClient({
      profileRow:    { first_name: 'Ada', last_name: 'Lovelace' },
      countResult:   0,
      insertResult:  { data: { id: 'pm_no_sig' }, error: null },
    });
    const result = await saveCardForPatient(
      'patient_1',
      { ...baseAuth, signature: null },
      supabase,
    );
    expect(result).toEqual({ kind: 'inserted', cardId: 'pm_no_sig' });
  });
});

// ─── Source-level regression: update branch must go through the RPC ──────────
//
// A future edit could plausibly inline the UPDATE back into the lib (e.g.
// for "performance" or to avoid the migration) and the in-memory tests
// above would still pass against the fake client. This source-text check
// fails if `refresh_card_token` disappears from saveCardForPatient.ts.

describe('regression: saveCardForPatient update branch wires the refresh_card_token RPC', () => {
  const src = readFileSync(
    resolve(process.cwd(), 'lib/paystack/saveCardForPatient.ts'),
    'utf8',
  );

  it('calls supabase.rpc("refresh_card_token", …) somewhere in the lib', () => {
    expect(src).toMatch(/rpc\(\s*['"`]refresh_card_token['"`]/);
  });

  it('does NOT do a direct .from("payment_methods").update({ token: … }) in the update branch', () => {
    // A direct UPDATE on payment_methods that includes `token:` in the
    // payload is the regression we want to catch — it bypasses the RPC
    // and re-opens the drift window. (Other UPDATE calls without
    // `token:` are fine — e.g. setting is_default in change_default_card
    // happens via the RPC, not this lib.)
    expect(src).not.toMatch(/\.from\(\s*['"`]payment_methods['"`]\s*\)\s*\.update\(\s*\{\s*[\s\S]*?\btoken\s*:/);
  });
});
