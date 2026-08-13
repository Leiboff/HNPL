import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── /practice/* route auth — regression guard for the device-auth split ──
//
// Build D deliberately drops requireConfirmedUser() for EXACTLY TWO
// routes (the till kiosk itself and its anon-reachable registration
// screen) — every other /practice/* page, including the manager-only
// device-administration screen, keeps the normal per-user login model
// completely unchanged. This test pins that boundary at the source level
// so a future refactor can't silently widen (or narrow) it.

const ROOT = resolve(process.cwd());
function readSrc(p: string): string { return readFileSync(resolve(ROOT, p), 'utf8'); }

// Every /practice/* page.tsx that must still require normal login. The two
// legacy settings routes (/practice/details, /practice/pos/devices) are on
// this list even though they are now thin redirects into /practice/settings:
// a redirect is not a reason to widen the anon-reachable set, and an
// anonymous visitor following a bookmarked settings URL should still meet
// the login page.
const GATED_PAGES = [
  'app/practice/page.tsx',
  'app/practice/bills/page.tsx',
  'app/practice/bills/new/page.tsx',
  'app/practice/members/page.tsx',
  'app/practice/settings/page.tsx',
  'app/practice/setup/page.tsx',
  'app/practice/details/page.tsx',
  'app/practice/pos/devices/page.tsx',
];

// The two routes that are DELIBERATELY device-gated / anon-reachable,
// not user-gated — the entire point of Build D.
const DEVICE_GATED_PAGES = [
  'app/practice/pos/page.tsx',
  'app/practice/pos/register/page.tsx',
];

describe('practice routes — every OTHER /practice/* page still requires normal login', () => {
  it.each(GATED_PAGES)('%s imports and calls requireConfirmedUser', (path) => {
    const src = readSrc(path);
    expect(src).toMatch(/from\s+['"]@\/lib\/auth\/requireConfirmedUser['"]/);
    expect(src).toMatch(/requireConfirmedUser\s*\(/);
  });
});

describe('practice/pos — the ONLY /practice/* routes that deliberately drop requireConfirmedUser', () => {
  it.each(DEVICE_GATED_PAGES)('%s does NOT import requireConfirmedUser', (path) => {
    const src = readSrc(path);
    expect(src).not.toMatch(/from\s+['"]@\/lib\/auth\/requireConfirmedUser['"]/);
  });

  it('app/practice/pos/page.tsx fetches no practice-scoped data server-side (device auth resolves client-side)', () => {
    const src = readSrc('app/practice/pos/page.tsx');
    expect(src).not.toMatch(/supabase\.from\(/);
    expect(src).not.toMatch(/createClient\(/);
  });
});

describe('practice layout — auth gating is NOT centralised at the layout (each page owns its own gate)', () => {
  it('app/practice/layout.tsx does not itself call requireConfirmedUser', () => {
    const src = readSrc('app/practice/layout.tsx');
    expect(src).not.toMatch(/requireConfirmedUser\s*\(/);
  });
});
