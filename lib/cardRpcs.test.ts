import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import { callSetDefaultCardFlagRpc, callArchiveCardRpc } from './cardRpcs';

// ─── Seam: set_default_card_flag (RULE 1 — flag-only default) ────────────────

describe('callSetDefaultCardFlagRpc — the seam', () => {
  it('calls supabase.rpc("set_default_card_flag", { p_card_id })', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: { changed: true, old_last_four: '0409', new_last_four: '4081' },
      error: null,
    });
    const supabase = { rpc } as unknown as SupabaseClient;

    const r = await callSetDefaultCardFlagRpc(supabase, 'card_abc');
    expect(rpc).toHaveBeenCalledWith('set_default_card_flag', { p_card_id: 'card_abc' });
    expect(r).toEqual({ error: null, changed: true, oldLastFour: '0409', newLastFour: '4081' });
  });

  it('returns { error } when the RPC errors', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: 'card_not_found' } });
    const supabase = { rpc } as unknown as SupabaseClient;
    expect(await callSetDefaultCardFlagRpc(supabase, 'x')).toEqual({ error: 'card_not_found' });
  });
});

// ─── Seam: archive_card (RULE 2 — guarded soft-delete) ───────────────────────

describe('callArchiveCardRpc — the seam', () => {
  it('calls supabase.rpc("archive_card", { p_card_id }) and maps the result', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: { archived: true, promoted_default_id: 'card_c', promoted_last_four: '4081' },
      error: null,
    });
    const supabase = { rpc } as unknown as SupabaseClient;

    const r = await callArchiveCardRpc(supabase, 'card_abc');
    expect(rpc).toHaveBeenCalledWith('archive_card', { p_card_id: 'card_abc' });
    expect(r).toEqual({ error: null, archived: true, promotedDefaultId: 'card_c', promotedLastFour: '4081' });
  });

  it('translates the active-plan guard into a friendly, user-facing error', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: null,
      error: { message: 'ERROR: card_collecting_active_plan (SQLSTATE P0001)' },
    });
    const supabase = { rpc } as unknown as SupabaseClient;

    const r = await callArchiveCardRpc(supabase, 'card_abc');
    expect(r).toEqual({ error: 'Collecting an active plan — change the card on that plan first.' });
  });

  it('passes through any other error verbatim', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: 'card_not_found' } });
    const supabase = { rpc } as unknown as SupabaseClient;
    expect(await callArchiveCardRpc(supabase, 'x')).toEqual({ error: 'card_not_found' });
  });
});

// ─── Source regression: the actions wire the right seams ─────────────────────

describe('regression: card actions invoke the RULE-1 / RULE-2 seams', () => {
  const actions = readFileSync(
    resolve(process.cwd(), 'app/patient/payment-methods/actions.ts'),
    'utf8',
  ).replace(/\r\n/g, '\n');

  function functionBody(name: string): string {
    const start = actions.indexOf(`export async function ${name}(`);
    if (start < 0) throw new Error(`server action "${name}" not found`);
    const after = actions.indexOf('\n}\n', start);
    return actions.slice(start, after + 2);
  }

  it('changeDefaultCard uses the flag-only seam and NEVER the plan-repointing RPC', () => {
    const body = functionBody('changeDefaultCard');
    expect(/callSetDefaultCardFlagRpc\s*\(/.test(body) || /rpc\(\s*['"`]set_default_card_flag['"`]/.test(body)).toBe(true);
    // RULE 1: the old repointing function must not be used here.
    expect(body).not.toContain('change_default_card');
    expect(body).not.toContain('callChangeDefaultCardRpc');
  });

  it('removeCard archives via the guarded seam (never a hard delete)', () => {
    const body = functionBody('removeCard');
    expect(/callArchiveCardRpc\s*\(/.test(body) || /rpc\(\s*['"`]archive_card['"`]/.test(body)).toBe(true);
    expect(body).not.toMatch(/\.delete\(\)/);
  });

  it('the Account surface wires changeDefaultCard, removeCard and lockedCardIds into PaymentMethods', () => {
    const accountSrc = readFileSync(resolve(process.cwd(), 'app/patient/account/page.tsx'), 'utf8');
    expect(accountSrc).toMatch(/changeDefaultCard=\{changeDefaultCard\}/);
    expect(accountSrc).toMatch(/removeCard=\{removeCard\}/);
    expect(accountSrc).toMatch(/lockedCardIds=\{lockedCardIds\}/);

    const clientSrc = readFileSync(resolve(process.cwd(), 'app/patient/payment-methods/PaymentMethods.tsx'), 'utf8');
    expect(clientSrc).toMatch(/await\s+changeDefaultCard\(/);
    expect(clientSrc).toMatch(/await\s+removeCard\(/);
  });

  it('the make-default consequence dialog is gone (default no longer repoints)', () => {
    const clientSrc = readFileSync(resolve(process.cwd(), 'app/patient/payment-methods/PaymentMethods.tsx'), 'utf8');
    expect(clientSrc).not.toMatch(/kind:\s*['"`]make-default['"`]/);
    expect(clientSrc).not.toContain('will collect from');
    // Microcopy present.
    expect(clientSrc).toContain('Default for new plans');
  });
});
