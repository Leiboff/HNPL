import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stripComments } from '@/lib/testing/stripComments';

// ─── Authority-before-data survives parallelisation ──────────────────────
//
// The routes touched by this work folded their independent tail reads into a
// single Promise.all. The hazard that creates is specific and severe: a wave
// that swallowed an authorisation step would begin reading practice or brand
// data BEFORE the caller's right to see it was established. Nothing about the
// rendered output would change for an authorised user, so a review reading the
// diff for "does this still look right" would not catch it.
//
// So the ORDER is asserted structurally, per route: every authorisation await
// must appear before the wave, and the wave must contain none of them.
//
// What this does NOT replace: lib/brand/brandViewer.test.ts drives a fake
// client and asserts the first table read is practice_group_members. That is
// the stronger test and it still passes unchanged. This file covers the pages,
// where there is no equivalent fake to drive because each page composes
// several helpers.

const ROOT = resolve(process.cwd());
const read = (p: string) => stripComments(readFileSync(resolve(ROOT, p), 'utf8'));

/** Each route: the authorisation calls that must precede any data wave. */
const ROUTES: Array<{ file: string; authority: string[] }> = [
  {
    file: 'app/practice/page.tsx',
    authority: ['requireConfirmedUser(', "from('profiles')", 'resolvePracticeViewer('],
  },
  {
    file: 'app/practice/bills/page.tsx',
    authority: ['requireConfirmedUser(', "from('profiles')", 'resolvePracticeViewer('],
  },
  {
    file: 'app/practice/payouts/page.tsx',
    authority: ['requireConfirmedUser(', "from('profiles')", 'resolvePracticeViewer('],
  },
  {
    file: 'app/brand/page.tsx',
    authority: ['auth.getUser()', 'resolveBrandGroupIds(supabase, user.id)'],
  },
  {
    file: 'app/brand/revenue/page.tsx',
    authority: ['auth.getUser()', 'resolveBrandGroupIds(supabase, user.id)'],
  },
];

const PRACTICE_ROUTES = [
  'app/practice/page.tsx',
  'app/practice/bills/page.tsx',
  'app/practice/payouts/page.tsx',
];

const BRAND_ROUTES = [
  'app/brand/page.tsx',
  'app/brand/revenue/page.tsx',
];

describe('every parallelised route still resolves authority first', () => {
  it.each(ROUTES.map((r) => [r.file, r] as const))(
    '%s: all authorisation precedes the first Promise.all',
    (_name, route) => {
      const code = read(route.file);
      const waveAt = code.indexOf('await Promise.all([');
      expect(waveAt, 'the route has a wave to check').toBeGreaterThan(0);

      for (const call of route.authority) {
        const at = code.indexOf(call);
        expect(at, `${call} is present`).toBeGreaterThan(0);
        expect(at, `${call} resolves BEFORE the wave`).toBeLessThan(waveAt);
      }
    },
  );

  it.each(ROUTES.map((r) => [r.file, r] as const))(
    '%s: the wave itself contains no authorisation call',
    (_name, route) => {
      const code = read(route.file);
      const start = code.indexOf('await Promise.all([');
      // Bound the wave at its closing bracket so later code is not scanned.
      const end = code.indexOf(']);', start);
      expect(end).toBeGreaterThan(start);
      const wave = code.slice(start, end);

      for (const call of route.authority) {
        expect(wave, `${call} must not be inside the wave`).not.toContain(call);
      }
    },
  );

  it.each(ROUTES.map((r) => [r.file, r] as const))(
    '%s: the authorisation calls stay in order relative to each other',
    (_name, route) => {
      // requireConfirmedUser then role gate then scope resolution is a genuine
      // dependency chain, not a style choice: each step needs the previous
      // one's result. Reordering them would break the gate even with no
      // parallelisation involved at all.
      const code = read(route.file);
      const positions = route.authority.map((c) => code.indexOf(c));
      const sorted = [...positions].sort((a, b) => a - b);
      expect(positions).toEqual(sorted);
    },
  );
});

describe('the refusal paths are still reachable and still refuse', () => {
  it.each(PRACTICE_ROUTES)('%s still bounces setup and denies a non-member', (file) => {
    const code = read(file);
    // resolvePracticeViewer returns setup, denied, or a scope. Both refusal
    // branches must still be acted on, and both must sit before the wave —
    // otherwise an unauthorised caller's data read is already in flight by the
    // time the refusal is decided.
    const waveAt = code.indexOf('await Promise.all([');
    const setupAt = code.indexOf("viewer.kind === 'setup'");
    const deniedAt = code.indexOf("viewer.kind === 'denied'");
    expect(setupAt).toBeGreaterThan(0);
    expect(deniedAt).toBeGreaterThan(0);
    expect(setupAt).toBeLessThan(waveAt);
    expect(deniedAt).toBeLessThan(waveAt);
    expect(code).toMatch(/notFound\(\)/);
  });

  it.each(PRACTICE_ROUTES)('%s still redirects a wrong-role caller before the wave', (file) => {
    const code = read(file);
    const waveAt = code.indexOf('await Promise.all([');
    const roleGate = code.indexOf("profile?.role !== 'practice_admin'");
    expect(roleGate).toBeGreaterThan(0);
    expect(roleGate).toBeLessThan(waveAt);
  });

  it.each(BRAND_ROUTES)('%s still bounces an unauthenticated caller before the wave', (file) => {
    const code = read(file);
    const waveAt = code.indexOf('await Promise.all([');
    const gate = code.indexOf("redirect('/login')");
    expect(gate).toBeGreaterThan(0);
    expect(gate).toBeLessThan(waveAt);
  });

  it('brand reads are still scoped by the callers OWN group ids', () => {
    // The adversarial case for a wave: a read that started before the scope
    // was known would have to be unscoped. Both brand waves must still filter
    // on the resolved groupIds, so an unauthorised viewer cannot be served
    // rows merely because the read began earlier.
    for (const file of BRAND_ROUTES) {
      expect(read(file), file).toMatch(/\.in\('id', groupIds\)/);
      expect(read(file), file).toMatch(/\.in\('group_id', groupIds\)/);
    }
  });
});

describe('the practice pages still delegate scope resolution', () => {
  it.each(PRACTICE_ROUTES)('%s adds no practice_members query of its own', (file) => {
    // Pre-existing invariant (brand-management.test.ts pins it for the
    // dashboard). Restated across all three parallelised practice routes,
    // because a wave is precisely where someone would be tempted to inline a
    // membership read "while we are fetching anyway".
    expect(read(file)).not.toMatch(/from\('practice_members'\)/);
  });
});
