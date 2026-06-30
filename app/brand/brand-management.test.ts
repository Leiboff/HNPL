import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── Source-text regressions — brand-admin management surface ──────────
//
// These pins are the security boundary for the brand-admin actions
// in app/brand/actions.ts. The service-role updates bypass RLS AND
// the 0054 column-lock trigger, so the actions' UPDATE payload IS
// the entire defence against locked-column writes. If a future edit
// adds `status` / `fee_percent` / etc. to one of those payloads, the
// matching assertion fails immediately.
//
// Plus: cross-group authz — every per-branch action MUST resolve the
// practice's group_id first and verify brand_admin membership of
// THAT group, NOT just any group the caller admins.

const ROOT = resolve(process.cwd());
function read(p: string): string { return readFileSync(resolve(ROOT, p), 'utf8'); }

const ACTIONS = read('app/brand/actions.ts');

// The full column-lock list from 0054 — these columns MUST NEVER
// appear in a brand-admin .update({...}) payload. owner_id /
// group_id / created_at / email aren't 0054-locked but are
// administrative columns the brand-admin must not be able to flip
// from this surface.
const LOCKED_COLUMNS = [
  'status',
  'approved_at',
  'approved_by',
  'fee_percent',
  'owner_id',
  'group_id',
  'created_at',
  'email',
];

// Extract every .update({...}) payload in the file so we can prove
// the locked columns appear NOWHERE in any of them.
function extractUpdatePayloads(src: string): string[] {
  const payloads: string[] = [];
  // Match `.update({` and balance braces to find the end of the
  // object literal. Lazy match of the outer braces is fine because
  // we expect a small handful of these.
  const re = /\.update\(\s*\{([\s\S]*?)\}\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    payloads.push(m[1]);
  }
  return payloads;
}

describe('Brand-admin actions — locked columns absent from every .update payload', () => {
  const payloads = extractUpdatePayloads(ACTIONS);

  it('there are at least three update payloads (group + branch details + banking)', () => {
    // Sanity check: if the file regresses to zero updates we want a
    // clear failure here before the per-column matrix below.
    expect(payloads.length).toBeGreaterThanOrEqual(3);
  });

  // For each locked column × each payload, assert absence. Matrix
  // failure messages tell exactly which payload introduced the leak.
  for (let i = 0; i < 5; i += 1) {
    // Pre-declare 5 slots so it.each below has stable test names
    // regardless of how many payloads the file currently contains.
    // Skip the rest if the file has fewer.
    describe(`payload #${i}`, () => {
      it.each(LOCKED_COLUMNS)('does NOT write locked column: %s', (col) => {
        if (i >= payloads.length) return;
        expect(payloads[i]).not.toMatch(new RegExp(`\\b${col}\\s*:`));
      });
    });
  }
});

describe('Brand-admin actions — every per-branch action resolves group via service-role + checks brand_admin', () => {
  it('guardBrandAdminOfPractice is defined and reads practices.group_id', () => {
    expect(ACTIONS).toMatch(/async function guardBrandAdminOfPractice/);
    // The guard must read group_id from practices and check
    // practice_group_members for the caller. Pin the literal SQL
    // verbs so a future edit doesn't drop the group-id check.
    expect(ACTIONS).toMatch(/\.from\('practices'\)[\s\S]*?\.select\('group_id'\)/);
    expect(ACTIONS).toMatch(/\.from\('practice_group_members'\)/);
    expect(ACTIONS).toMatch(/\.eq\('active', true\)/);
  });

  it('updateBranchDetails calls guardBrandAdminOfPractice BEFORE the update', () => {
    const fnStart = ACTIONS.indexOf('export async function updateBranchDetails');
    expect(fnStart).toBeGreaterThan(0);
    const fnBody = ACTIONS.slice(fnStart);
    const guardIdx  = fnBody.indexOf('guardBrandAdminOfPractice(');
    const updateIdx = fnBody.indexOf('.update(');
    expect(guardIdx).toBeGreaterThan(0);
    expect(updateIdx).toBeGreaterThan(guardIdx);
  });

  it('updateBranchBanking calls guardBrandAdminOfPractice BEFORE the update', () => {
    const fnStart = ACTIONS.indexOf('export async function updateBranchBanking');
    expect(fnStart).toBeGreaterThan(0);
    const fnBody = ACTIONS.slice(fnStart);
    const guardIdx  = fnBody.indexOf('guardBrandAdminOfPractice(');
    const updateIdx = fnBody.indexOf('.update(');
    expect(guardIdx).toBeGreaterThan(0);
    expect(updateIdx).toBeGreaterThan(guardIdx);
  });

  it('updateOwnGroup calls guardBrandAdmin BEFORE the update', () => {
    const fnStart = ACTIONS.indexOf('export async function updateOwnGroup');
    expect(fnStart).toBeGreaterThan(0);
    const fnBody = ACTIONS.slice(fnStart);
    const guardIdx  = fnBody.indexOf('guardBrandAdmin(');
    const updateIdx = fnBody.indexOf('.update(');
    expect(guardIdx).toBeGreaterThan(0);
    expect(updateIdx).toBeGreaterThan(guardIdx);
  });
});

describe('Brand-admin actions — SA-range backstop on coord re-pick', () => {
  it('updateBranchDetails refuses coords outside SA', () => {
    const fnStart = ACTIONS.indexOf('export async function updateBranchDetails');
    const fnBody = ACTIONS.slice(fnStart);
    expect(fnBody).toMatch(/isWithinSouthAfrica/);
    // Out-of-range must REJECT (not silently null-out). A tampered
    // payload setting lat/lng outside SA can't drift a branch's
    // discovery pin.
    expect(fnBody).toMatch(/outside South Africa/i);
  });
});

describe('Brand revenue page — uses service-role + scopes to caller\'s own group(s)', () => {
  const PAGE = read('app/brand/revenue/page.tsx');

  it('reads practice_group_members for the caller before any data query', () => {
    const idxMember  = PAGE.indexOf("from('practice_group_members')");
    const idxPlans   = PAGE.indexOf("from('plans')");
    expect(idxMember).toBeGreaterThan(0);
    expect(idxPlans).toBeGreaterThan(idxMember);
  });

  it('filters practices + plans on the caller\'s OWN group_ids — never a URL-supplied list', () => {
    // The page must call .in('group_id', groupIds) where groupIds is
    // derived from the membership query above. A regression that
    // accepts an arbitrary group_id from searchParams would be
    // caught by this — searching for `searchParams.group` should
    // find NO match.
    expect(PAGE).toMatch(/\.in\('group_id', groupIds\)/);
    expect(PAGE).not.toMatch(/searchParams\.group\b/);
    expect(PAGE).not.toMatch(/params\.group\b/);
  });

  it('does NOT pull payment/instalment/collection data — no payments/payouts table queries', () => {
    expect(PAGE).not.toMatch(/from\(['"]payments['"]\)/);
    expect(PAGE).not.toMatch(/from\(['"]payouts['"]\)/);
  });

  it('the revenue plans query selects only the columns computeRevenue needs (no collection state)', () => {
    // Pull out the plans select string and assert it doesn't include
    // any obviously-collection-related fields.
    const m = PAGE.match(/\.from\('plans'\)\s*\.select\(\s*['"`]([^'"`]+)['"`]/);
    expect(m).not.toBeNull();
    const selected = (m?.[1] ?? '').toLowerCase();
    for (const forbidden of ['collected', 'remaining', 'instalment', 'mandate', 'paystack']) {
      expect(selected).not.toContain(forbidden);
    }
  });
});

describe('Brand revenue page — filter clamping (tampered URL → no filter)', () => {
  const PAGE = read('app/brand/revenue/page.tsx');

  it('clamps the searchParams filter against the caller\'s OWN practice/provider ids', () => {
    // The page builds Set objects from the caller's own ids and
    // clamps params.practice / params.provider against those Sets
    // before passing into computeRevenue. A tampered
    // ?practice=otherGroupBranch falls back to "no filter".
    expect(PAGE).toMatch(/validPracticeIds\.has\(/);
    expect(PAGE).toMatch(/validProviderIds\.has\(/);
  });
});

describe('Brand revenue page — no fee_percent leak in the data going to the client', () => {
  const CLIENT = read('app/brand/revenue/RevenueClient.tsx');

  // The brand-admin IS allowed to see commission (gross − net is
  // derivable; that's accepted in the brief). What we don't want is
  // the raw fee_percent surfaced as a prop the client component
  // could ship to a different audience by mistake.
  it('the client only renders gross/net/count/label fields — not fee_percent directly', () => {
    expect(CLIENT).not.toMatch(/fee_percent/);
    expect(CLIENT).not.toMatch(/feePercent/);
  });
});

describe('Brand revenue page — counted-statuses regression vs the old practice dashboard', () => {
  it('the new revenue helper\'s ACTIVE set is exactly {active, completed} — no pending_acceptance', () => {
    const REV = read('lib/brand/revenue.ts');
    // Extract the ACTIVE_FOR_REVENUE set literal. The header
    // comment documents the excluded statuses (so pending_acceptance
    // WILL appear in the file as prose); the actual Set literal
    // must contain only the counted statuses.
    const m = REV.match(/ACTIVE_FOR_REVENUE\s*=\s*new Set\(\s*\[([^\]]*)\]/);
    expect(m).not.toBeNull();
    const literal = (m?.[1] ?? '').toLowerCase();
    expect(literal).toMatch(/'active'/);
    expect(literal).toMatch(/'completed'/);
    expect(literal).not.toMatch(/'pending_acceptance'/);
    expect(literal).not.toMatch(/'pending_first_payment'/);
    expect(literal).not.toMatch(/'defaulted'/);
    expect(literal).not.toMatch(/'cancelled'/);
    expect(literal).not.toMatch(/'declined'/);
  });
});
