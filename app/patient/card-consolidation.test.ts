import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── Phase 3 — one card surface, add-card returns to origin ─────────────
//
// Card management must live in exactly ONE place. The standalone
// /patient/payment-methods route must redirect there, not render a
// duplicate. The add-card completion flow (success AND cancel) resolves
// its redirect through cardReturn so the user always lands back on the card
// surface — never a page they never opened.
//
// RE-POINTED (2026-08-20): that one place is now /patient/account/pay, its
// own screen under the accordion→screens conversion, rather than a section
// built inline on the account index (ACCOUNT below).

const ROOT = resolve(process.cwd());
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

const PM_PAGE    = read('app/patient/payment-methods/page.tsx');
const PM_ACTIONS = read('app/patient/payment-methods/actions.ts');
const ACCOUNT    = read('app/patient/account/page.tsx');
const PAY        = read('app/patient/account/pay/page.tsx');
const COMPLETE  = read('app/patient/payment-methods/complete/page.tsx');
const POLLING   = read('app/patient/payment-methods/complete/PollingConfirmation.tsx');
const PM_CLIENT = read('app/patient/payment-methods/PaymentMethods.tsx');

describe('single card surface', () => {
  it('the standalone route redirects to the canonical surface', () => {
    expect(PM_PAGE).toMatch(/from '@\/lib\/patient\/cardReturn'/);
    expect(PM_PAGE).toMatch(/redirect\(CARDS_SURFACE\)/);
  });

  it('the standalone route no longer renders its own card UI (no duplicate)', () => {
    expect(PM_PAGE).not.toContain('<PaymentMethods');
  });

  it('the Payment cards screen is the one surface that hosts the card manager — the index does not', () => {
    expect(PAY).toContain('<PaymentMethods');
    expect(ACCOUNT).not.toContain('<PaymentMethods');
  });
});

describe('money-path card actions live in a neutral module, not the redirect page', () => {
  it('the redirect page is inert — no server actions to delete by accident', () => {
    expect(PM_PAGE).not.toMatch(/export async function (previewDefaultChange|changeDefaultCard|removeCard)/);
    // Truly inert: just the redirect, no data fetch / client component.
    expect(PM_PAGE).not.toContain('createClient');
  });

  it('the actions module owns changeDefaultCard / removeCard', () => {
    // previewDefaultChange was retired with the make-default consequence
    // dialog: the default no longer repoints existing plans (RULE 1), so
    // there is nothing to preview.
    expect(PM_ACTIONS).toMatch(/export async function changeDefaultCard\(/);
    expect(PM_ACTIONS).toMatch(/export async function removeCard\(/);
  });

  it('the Payment cards screen imports the actions from the neutral module (not the page)', () => {
    expect(PAY).toMatch(/from '@\/app\/patient\/payment-methods\/actions'/);
    expect(PAY).not.toMatch(/from '\.\.\/payment-methods\/page'/);
  });
});

describe('add-card completion returns to origin', () => {
  it('the completion route resolves its redirect via cardReturn', () => {
    expect(COMPLETE).toMatch(/from '@\/lib\/patient\/cardReturn'/);
    expect(COMPLETE).toContain('cardCompletionRedirect');
  });

  it('cancel/expire short-circuits straight back (no failure screen)', () => {
    expect(COMPLETE).toMatch(/widgetStatus === 'cancelled' \|\| widgetStatus === 'expired'/);
  });

  it('no longer hard-codes the old payment-methods success redirect', () => {
    expect(COMPLETE).not.toContain("/patient/payment-methods?added=");
  });

  it('the polling fallback points back at the canonical surface', () => {
    expect(POLLING).toMatch(/from '@\/lib\/patient\/cardReturn'/);
    expect(POLLING).toContain('href={CARDS_SURFACE}');
  });

  it('the added-banner strip is path-relative, not hard-coded to one route', () => {
    // Must reflect back onto whatever surface it is mounted on (Account),
    // so the query-strip uses the live pathname.
    expect(PM_CLIENT).toContain('usePathname');
    expect(PM_CLIENT).toMatch(/router\.replace\(qs \? `\$\{pathname\}/);
  });
});
