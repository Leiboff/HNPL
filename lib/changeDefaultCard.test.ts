import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import { callChangeDefaultCardRpc } from './changeDefaultCard';

// ─── Seam test: helper itself invokes the RPC correctly ──────────────────────

describe('callChangeDefaultCardRpc — the seam', () => {
  it('calls supabase.rpc("change_default_card", { p_card_id }) with the cardId', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: {
        changed:         true,
        repointed_plans: 2,
        plan_refs:       [{ id: 'p1', invoice_number: 'BN-2026-000001' }],
        old_last_four:   '0409',
        new_last_four:   '4081',
      },
      error: null,
    });
    const supabase = { rpc } as unknown as SupabaseClient;

    await callChangeDefaultCardRpc(supabase, 'card_abc');

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('change_default_card', { p_card_id: 'card_abc' });
  });

  it('translates RPC result into the server-action response shape (camelCase)', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: {
        changed:         true,
        repointed_plans: 3,
        plan_refs:       [],
        old_last_four:   '0409',
        new_last_four:   '4081',
      },
      error: null,
    });
    const supabase = { rpc } as unknown as SupabaseClient;

    const r = await callChangeDefaultCardRpc(supabase, 'card_abc');
    expect(r).toEqual({
      error:          null,
      changed:        true,
      repointedPlans: 3,
      oldLastFour:    '0409',
      newLastFour:    '4081',
    });
  });

  it('returns { error } when the RPC errors', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data:  null,
      error: { message: 'card_not_found' },
    });
    const supabase = { rpc } as unknown as SupabaseClient;

    const r = await callChangeDefaultCardRpc(supabase, 'card_abc');
    expect(r).toEqual({ error: 'card_not_found' });
  });
});

// ─── Source-level regression: page.tsx still wires the seam ──────────────────
//
// A future edit could plausibly refactor away the RPC call (e.g. inline a
// flag-flip "for now, repoint later") and the unit tests above would all
// still pass — they only exercise the extracted helper. These source-text
// assertions fail loudly if Make-default OR default-card removal stops
// invoking the seam.

describe('regression: payment-methods server actions invoke the change_default_card seam', () => {
  // The shared card actions live in a neutral module (payment-methods/
  // actions.ts) — NOT the payment-methods page, which is now an inert
  // redirect. Pinning this path keeps the RPC-seam assertions on the real
  // money-path module.
  // Normalise CRLF→LF so the closing-brace extractor below (which keys on
  // "\n}\n") is line-ending agnostic — git rewrites these files to CRLF on
  // commit, which would otherwise break the match.
  const pageSrc = readFileSync(
    resolve(process.cwd(), 'app/patient/payment-methods/actions.ts'),
    'utf8',
  ).replace(/\r\n/g, '\n');

  // Tight extractor: grab from `export async function NAME` up to the
  // first line that is exactly `}` at column 0 (the function's closing
  // brace, since the body is multi-line and ends with that pattern).
  function functionBody(name: string): string {
    const start = pageSrc.indexOf(`export async function ${name}(`);
    if (start < 0) throw new Error(`server action "${name}" not found in actions.ts`);
    // Find the closing brace at column 0 after `start`.
    const after = pageSrc.indexOf('\n}\n', start);
    if (after < 0) throw new Error(`could not find closing brace of "${name}"`);
    return pageSrc.slice(start, after + 2);
  }

  it('changeDefaultCard server action invokes the change_default_card RPC (directly or via callChangeDefaultCardRpc)', () => {
    const body = functionBody('changeDefaultCard');
    const usesHelper = /callChangeDefaultCardRpc\s*\(/.test(body);
    const usesRpc    = /rpc\(\s*['"`]change_default_card['"`]/.test(body);
    expect(usesHelper || usesRpc).toBe(true);
  });

  it('removeCard server action invokes the change_default_card RPC when removing the default card', () => {
    const body = functionBody('removeCard');
    const usesHelper = /callChangeDefaultCardRpc\s*\(/.test(body);
    const usesRpc    = /rpc\(\s*['"`]change_default_card['"`]/.test(body);
    expect(usesHelper || usesRpc).toBe(true);
  });

  it('the Account surface wires previewDefaultChange and changeDefaultCard as props into PaymentMethods', () => {
    // v4 consolidation: the standalone /patient/payment-methods route now
    // redirects to Account, which is the single surface that renders the
    // card manager and wires these server actions (imported from
    // payment-methods/page.tsx, where the actions still live).
    const accountSrc = readFileSync(
      resolve(process.cwd(), 'app/patient/account/page.tsx'),
      'utf8',
    );
    expect(accountSrc).toMatch(/previewDefaultChange=\{previewDefaultChange\}/);
    expect(accountSrc).toMatch(/changeDefaultCard=\{changeDefaultCard\}/);

    const clientSrc = readFileSync(
      resolve(process.cwd(), 'app/patient/payment-methods/PaymentMethods.tsx'),
      'utf8',
    );
    // The client must actually invoke both props, not just accept them.
    expect(clientSrc).toMatch(/await\s+previewDefaultChange\(/);
    expect(clientSrc).toMatch(/await\s+changeDefaultCard\(/);
  });

  it('PaymentMethods.tsx still renders the consequence dialog for kind: "make-default"', () => {
    const clientSrc = readFileSync(
      resolve(process.cwd(), 'app/patient/payment-methods/PaymentMethods.tsx'),
      'utf8',
    );
    expect(clientSrc).toMatch(/kind:\s*['"`]make-default['"`]/);
    // The dialog body mentions "will collect from" — quick sanity that the
    // copy didn't get accidentally removed.
    expect(clientSrc).toMatch(/will collect from/);
  });
});
