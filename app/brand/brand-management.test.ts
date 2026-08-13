import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stripComments } from '@/lib/testing/stripComments';

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

  it('resolves the caller\'s own brand memberships before any data query', () => {
    // RELOCATED: the inline four-line read became the shared
    // resolveBrandGroupIds (lib/brand/brandViewer). Same invariant, same page,
    // same ordering — authority first, data second — and still on the caller's
    // own client rather than service-role.
    const idxMember  = PAGE.indexOf('resolveBrandGroupIds(supabase, user.id)');
    const idxPlans   = PAGE.indexOf("from('plans')");
    expect(idxMember).toBeGreaterThan(0);
    expect(idxPlans).toBeGreaterThan(idxMember);
    expect(PAGE).not.toMatch(/resolveBrandGroupIds\(s,/);
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

// ─── SA banking validation on updateBranchBanking (Part A, 2026-07-21) ─
//
// A banking write must either be a full clear (all null → central-
// billed fallback) OR a complete, SA-shape-valid tuple. Half-filled
// banking is worse than none — settlements queue up against a row
// that will always fail at the acquirer.

describe('updateBranchBanking — SA banking shape validation', () => {
  const FN_START = ACTIONS.indexOf('export async function updateBranchBanking');
  const FN_BODY  = ACTIONS.slice(FN_START, FN_START + 3500);

  it('branches on anySet — a full clear is permitted (drops banking)', () => {
    // The guard reads `anySet` and skips per-field validation when
    // every incoming field is empty — so a caller can null out the
    // whole banking tuple without tripping a validation error.
    expect(FN_BODY).toMatch(/const\s+anySet\s*=/);
  });

  it('rejects an account number that is non-numeric or the wrong length', () => {
    // SA acquirer expectation: digits only, 6–13 chars. Regex must
    // pin both aspects — a spaces-and-dashes account number would
    // silently break Peach recurring settlement.
    expect(FN_BODY).toMatch(/\/\^\\d\{6,13\}\$\//);
  });

  it('rejects a branch code that is not exactly 6 digits (SA universal code)', () => {
    // 6-digit universal codes only. Old 5-digit legacy codes and any
    // free-text entry are rejected.
    expect(FN_BODY).toMatch(/\/\^\\d\{6\}\$\//);
  });

  it('requires all four core fields when any is set (holder / bank / account / branch code)', () => {
    // Each required-field guard is a distinct `if (!<field>) return`;
    // pin the four so a future edit that drops one immediately fails.
    expect(FN_BODY).toMatch(/if \(!bankName\)/);
    expect(FN_BODY).toMatch(/if \(!accountHolder\)/);
    expect(FN_BODY).toMatch(/if \(!bankAccountNumber\)/);
    expect(FN_BODY).toMatch(/if \(!branchCode\)/);
    expect(FN_BODY).toMatch(/if \(!accountType\)/);
  });
});

// ─── Practice-side sidebar nav — Part A UI (2026-07-21) ────────────────
//
// The /practice sidebar shows a "Practice details" link, conditional on
// isBrandAdmin — a non-brand-admin practice_admin would land on the
// destination's notFound() guard, and hiding a dead route is friendlier
// than surfacing it. Also — the trading gate's "no_banking" CTA used to
// point to /practice/setup (a dead redirect for existing practices).
//
// UPDATED: both used to point into /brand/branch/{practiceId}, which was
// doing double duty as a multi-branch performance view AND the de-facto
// settings page. That route now pivots into the practice dashboard and
// the settings live at /practice/details, inside the shell. The gate is
// unchanged — brand-admin of the practice's group is exactly the
// authority updateBranchDetails/updateBranchBanking enforce.

describe('Practice-side sidebar and no-banking CTA — Part A UI', () => {
  const NAV        = read('app/practice/PracticeNav.tsx');
  const SHELL      = read('app/practice/PracticeShell.tsx');
  const DASHBOARD  = read('app/practice/page.tsx');

  it('PracticeShell forwards practiceId + isBrandAdmin down to the nav', () => {
    expect(SHELL).toMatch(/practiceId\?:\s*string/);
    expect(SHELL).toMatch(/isBrandAdmin\?:\s*boolean/);
    expect(SHELL).toMatch(/<PracticeNav\s+practiceId=/);
  });

  it('brand-admin authority still gates the practice-details editing surface', () => {
    // The nav restructure folded "Practice details" and "Till devices" into a
    // single Settings tab, so there is no longer a top-level entry keyed on
    // `isBrandAdmin && practiceId`. What that condition PROTECTED is
    // unchanged and is what this now asserts: the details/banking content is
    // reachable only through brand-admin authority.
    //
    // The condition lives in the shared source both nav surfaces consume
    // (practiceManagerLinks → settings/settingsSections), so it cannot be
    // re-implemented per surface — which is what let "Till devices" reach
    // desktop and not mobile in the first place.
    const SECTIONS = read('app/practice/settings/settingsSections.ts');
    expect(SECTIONS).toMatch(/key: 'details'[\s\S]{0,120}visible: \(a\) => a\.isBrandAdmin/);
    expect(SECTIONS).toMatch(/key: 'banking'[\s\S]{0,120}visible: \(a\) => a\.isBrandAdmin/);

    const MANAGER_LINKS = read('app/practice/practiceManagerLinks.ts');
    expect(MANAGER_LINKS).toMatch(/canSeeAnySettingsSection\(\{ isBrandAdmin, canManageTill \}\)/);
    expect(MANAGER_LINKS).toMatch(/\/practice\/settings\$\{scopeOf\(practiceId\)\}/);
    expect(NAV).toMatch(/getPracticeNavLinks/);

    // And the page itself still refuses a non-brand-admin the two sections,
    // rather than rendering them read-only.
    const SETTINGS = read('app/practice/settings/page.tsx');
    expect(SETTINGS).toMatch(/canSeeSettingsSection\('details',\s*authority\)/);
    expect(SETTINGS).toMatch(/canSeeSettingsSection\('banking',\s*authority\)/);
  });

  it('Dashboard resolves isBrandAdmin from practice_group_members membership', () => {
    // Load-bearing gate for the sidebar link — must actually READ
    // practice_group_members, not assume from role.
    expect(DASHBOARD).toMatch(/practice_group_members/);
    expect(DASHBOARD).toMatch(/isBrandAdmin/);
  });

  it('Dashboard trading-gate no-banking CTA points at the banking anchor on /practice/details (not /practice/setup)', () => {
    // /practice/setup is the initial-signup flow and redirects
    // established users away. The banking edit now lives on
    // /practice/details — and the CTA deep-links to its #banking anchor,
    // which the page renders around BranchBankingForm.
    const noBankingBlockIdx = DASHBOARD.indexOf("gate.reason === 'no_banking'");
    expect(noBankingBlockIdx).toBeGreaterThan(0);
    const ctaBlock = DASHBOARD.slice(noBankingBlockIdx, noBankingBlockIdx + 900);
    expect(ctaBlock).toMatch(/\/practice\/details\?practiceId=\$\{practiceId\}#banking/);
    expect(ctaBlock).not.toMatch(/href="\/practice\/setup"/);
    expect(ctaBlock).not.toMatch(/\/brand\/branch\//);

    // The banking form is a SECTION of /practice/settings since the nav
    // restructure, and /practice/details is the redirect that keeps this
    // CTA's #banking fragment working — it names no fragment of its own, so
    // the browser re-applies the caller's onto the Settings page's anchor.
    const SETTINGS = read('app/practice/settings/page.tsx');
    expect(SETTINGS).toMatch(/id="banking"/);
    expect(SETTINGS).toMatch(/<BranchBankingForm/);

    const DETAILS = read('app/practice/details/page.tsx');
    expect(DETAILS).toMatch(/redirect\(`\/practice\/settings\$\{suffix\}`\)/);
  });
});

// ─── Multi-membership group→practice bill flow — Part B (2026-07-21) ──
//
// Pin the specific regressions the fix addresses: the ?practiceId=
// scope selector is threaded through page → form → server action,
// and NONE of the practice-side pages call .single() on
// practice_members any more (that was the root cause).

describe('createBill + practice pages honour ?practiceId= scope (Part B)', () => {
  const NEW_BILL_PAGE = read('app/practice/bills/new/page.tsx');
  const NEW_BILL_ACT  = read('app/practice/bills/new/actions.ts');
  const NEW_BILL_FORM = read('app/practice/bills/new/BillForm.tsx');
  const PRAC_PAGE     = read('app/practice/page.tsx');
  const PRAC_VIEWER   = read('app/practice/practiceViewer.ts');
  const MEMBERS_PAGE  = read('app/practice/members/page.tsx');

  it('createBill accepts an optional practiceId in its input', () => {
    expect(NEW_BILL_ACT).toMatch(/practiceId\?:\s*string/);
  });

  it('createBill verifies scoped membership when practiceId is supplied', () => {
    // Server-side re-check: the caller must have an active
    // membership on the resolved practice. A brand-admin cannot
    // bill a practice outside their own brand — they have no
    // practice_members row there.
    expect(NEW_BILL_ACT).toMatch(/data\.practiceId/);
    expect(NEW_BILL_ACT).toMatch(/You are not an active member of that practice\./);
  });

  it('createBill falls back to the caller\'s oldest membership when practiceId is absent', () => {
    // Solo-caller path — mirrors /practice dashboard's fallback so
    // the two surfaces converge on the same practice for the same
    // URL. Must NOT use .single() (multi-membership 406).
    expect(NEW_BILL_ACT).toMatch(/\.order\('created_at'/);
    expect(NEW_BILL_ACT).toMatch(/\.limit\(1\)/);
  });

  it('/practice/bills/new page reads ?practiceId= from searchParams', () => {
    expect(NEW_BILL_PAGE).toMatch(/searchParams/);
    expect(NEW_BILL_PAGE).toMatch(/params\.practiceId/);
    // And must NOT .single() on practice_members either. Strip line
    // and block comments before scanning so the historical fix
    // comments (which document what USED to be `.single()`) don't
    // trip the regex.
    const bodyStart = NEW_BILL_PAGE.indexOf('practice_members');
    expect(bodyStart).toBeGreaterThan(0);
    // preserveUrls, matching what the hand-rolled `(^|[^:])` guard here did:
    // a `//` after a colon is a URL, not a comment.
    const bodyChunk = stripComments(
      NEW_BILL_PAGE.slice(bodyStart, bodyStart + 800),
      { preserveUrls: true },
    );
    expect(bodyChunk).not.toMatch(/\.single\(/);
  });

  it('BillForm accepts + threads practiceId to createBill', () => {
    expect(NEW_BILL_FORM).toMatch(/practiceId:\s*string/);
    // Positive pin: the practiceId prop is present at the call site.
    expect(NEW_BILL_FORM).toMatch(/practiceId,\s*[\s\S]*?\}\)/);
  });

  it('the practice membership lookups do NOT .single() on practice_members', () => {
    // Both pages migrated to .order().limit(1) with the ?practiceId=
    // acting-context. Their .single() era was the multi-membership 406.
    // Strip comments before checking so a comment referencing the
    // historical `.single()` fix isn't mistaken for actual code.
    //
    // /practice/page.tsx's own lookup now lives in ./practiceViewer — the page
    // delegates membership resolution to it, and 0094 removed the page's last
    // remaining direct practice_members query (the specialty map, which now
    // rides on the plans embed). So the invariant is asserted where the query
    // actually is, plus the delegation itself, so it cannot be dodged by
    // re-adding an inline lookup to the page.
    expect(PRAC_PAGE).toMatch(/resolvePracticeViewer/);
    expect(PRAC_PAGE).not.toMatch(/from\('practice_members'\)/);

    for (const src of [PRAC_VIEWER, MEMBERS_PAGE]) {
      const chainIdx = src.indexOf("from('practice_members')");
      expect(chainIdx).toBeGreaterThan(0);
      const chunk = stripComments(
        src.slice(chainIdx, chainIdx + 800),
        { preserveUrls: true },
      );
      expect(chunk).not.toMatch(/\.single\(\)/);
    }
  });
});
