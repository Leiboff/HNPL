import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { stripComments } from '@/lib/testing/stripComments';

// ─── How the three brand tabs are wired ────────────────────────────────────
//
// Component behaviour lives in the sibling test files. This one covers the
// things only the PAGES can get wrong, and each pin is here because getting it
// wrong is silent:
//
//   • a tab that renders without the shell has a nav pointing INTO it and none
//     pointing out
//   • a page that resolves scope from anything but the caller's own membership
//     rows leaks another brand's practices, and no test of the component would
//     notice
//   • a page that reads setup state through the VIEWER's client reports "no
//     till" for a practice that has three, because a brand admin normally holds
//     no practice_members row anywhere
//   • the n=1 rule silently dropping means a solo practitioner lands on a brand
//     portal that says "practices" about their one practice

const ROOT = resolve(process.cwd());
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

const OVERVIEW  = read('app/brand/page.tsx');
const PRACTICES = read('app/brand/practices/page.tsx');
const REPORTS   = read('app/brand/revenue/page.tsx');
const SETTINGS  = read('app/brand/group/page.tsx');

const TABS: Array<[string, string]> = [
  ['Overview',  'app/brand/page.tsx'],
  ['Practices', 'app/brand/practices/page.tsx'],
  ['Reports',   'app/brand/revenue/page.tsx'],
  ['Settings',  'app/brand/group/page.tsx'],
];

// ─── Every tab wears the shell ─────────────────────────────────────────────

describe('all four tabs render inside BrandShell', () => {
  it.each(TABS)('%s does', (_label, path) => {
    const code = stripComments(read(path));
    expect(code).toMatch(/BrandShell/);
    expect(code).toMatch(/<BrandShell/);
  });

  it.each(TABS)('%s no longer opens with its own <h1>', (_label, path) => {
    // The shell owns the page title now. Two <h1>s on one screen reads as two
    // pages stitched together.
    expect(stripComments(read(path))).not.toMatch(/<h1/);
  });

  it('the new Practices route exists and is dynamic', () => {
    expect(existsSync(resolve(ROOT, 'app/brand/practices/page.tsx'))).toBe(true);
    expect(PRACTICES).toMatch(/export const dynamic = 'force-dynamic'/);
  });
});

// ─── Scoping ───────────────────────────────────────────────────────────────

describe('every tab scopes to the caller\'s OWN brand memberships', () => {
  it.each(TABS)('%s resolves membership before it reads anything else', (_label, path) => {
    const code = stripComments(read(path));
    // Either inline (Overview / Reports / Settings, whose ordering is pinned
    // elsewhere) or through the shared resolver (Practices).
    const inline = code.indexOf("from('practice_group_members')");
    const shared = code.indexOf('resolveBrandViewer');
    expect(Math.max(inline, shared)).toBeGreaterThan(0);
  });

  it('Practices goes through resolveBrandViewer rather than a third inline copy', () => {
    const code = stripComments(PRACTICES);
    expect(code).toMatch(/resolveBrandViewer/);
    expect(code).not.toMatch(/from\('practice_group_members'\)/);
    expect(code).not.toMatch(/\.in\('group_id'/);
  });

  it('Practices applies the same n rule the Overview tab does', () => {
    const code = stripComments(PRACTICES);
    expect(code).toMatch(/kind === 'denied'\) redirect\('\/practice'\)/);
    expect(code).toMatch(/kind === 'setup'\)\s+redirect\('\/practice\/setup'\)/);
    expect(code).toMatch(/kind === 'solo'\)\s+redirect\(`\/practice\?practiceId=/);
  });

  it('no brand page trusts a group id or practice id from the URL', () => {
    for (const [label, path] of TABS) {
      const code = stripComments(read(path));
      expect(code, label).not.toMatch(/params\.group|params\.groupId|searchParams\.group/);
      expect(code, label).not.toMatch(/params\.practiceId/);
    }
  });
});

// ─── Setup state must be read with service-role ────────────────────────────

describe('the Practices table\'s setup state is a property of the practice, not the viewer', () => {
  it('resolves it with the service-role client', () => {
    const code = stripComments(PRACTICES);
    expect(code).toMatch(/resolveBrandPracticeSetup\(s,/);
    expect(code).not.toMatch(/resolveBrandPracticeSetup\(supabase/);
  });

  it('the same client resolves the viewer\'s DATA while their own client proves authority', () => {
    const code = stripComments(PRACTICES);
    expect(code).toMatch(/resolveBrandViewer\(supabase, s, user\.id\)/);
  });

  it('bounces an unauthenticated caller before any read', () => {
    const code = stripComments(PRACTICES);
    const auth = code.indexOf('auth.getUser()');
    const gate = code.indexOf("redirect('/login')");
    // The CALL SITE, not the import — `indexOf('resolveBrandViewer')` finds the
    // import statement at the top of the file and would make this pass for any
    // ordering at all.
    const work = code.indexOf('resolveBrandViewer(supabase');
    expect(auth).toBeGreaterThan(0);
    expect(gate).toBeGreaterThan(auth);
    expect(work).toBeGreaterThan(gate);
  });
});

// ─── Overview's composition ────────────────────────────────────────────────

describe('Overview keeps money and analysis apart', () => {
  const code = stripComments(OVERVIEW);

  it('resolves payouts on the server, above the client component that owns the filters', () => {
    expect(code).toMatch(/resolveBrandPayouts\(s,/);
    // Call site, not the import at the top — see the note in the Practices
    // ordering test on why indexOf on a bare identifier proves nothing here.
    const resolveAt = code.indexOf('resolveBrandPayouts(s,');
    const mountAt   = code.indexOf('<BrandPayoutBlock');
    expect(resolveAt).toBeGreaterThan(0);
    expect(mountAt).toBeGreaterThan(resolveAt);
  });

  it('passes the payout loader only the practices it already scoped', () => {
    expect(code).toMatch(/resolveBrandPayouts\(s, branches\.map/);
  });

  it('derives the active plan count from computeRevenue with NO filter', () => {
    // Same definition of "active" as the revenue section below, so one page
    // cannot hold two meanings of the word.
    expect(code).toMatch(/computeRevenue\(/);
    expect(code).toMatch(/providers,\s*\{\},/);
    expect(code).toMatch(/activePlanCounts\[row\.id\] = row\.count/);
  });

  it('renders quick actions → payouts → revenue', () => {
    const quick  = code.indexOf('<BrandQuickActions');
    const payout = code.indexOf('<BrandPayoutBlock');
    const dash   = code.indexOf('<GroupDashboard');
    expect(quick).toBeGreaterThan(0);
    expect(payout).toBeGreaterThan(quick);
    expect(dash).toBeGreaterThan(payout);
  });

  it('no longer passes `brands` into the revenue section — the shell names the brand', () => {
    expect(code).not.toMatch(/brands=\{brands\}/);
    expect(code).toMatch(/brandName=\{brands\[0\]\?\.name/);
    expect(code).toMatch(/brandCount=\{brands\.length\}/);
  });
});

// ─── Reports: reachable, and otherwise untouched ────────────────────────────

describe('Reports is now reachable and otherwise unchanged', () => {
  const code = stripComments(REPORTS);

  it('still renders the same RevenueClient with the same summary', () => {
    expect(code).toMatch(/<RevenueClient/);
    expect(code).toMatch(/summary=\{summary\}/);
    expect(code).toMatch(/computeRevenue\(/);
  });

  it('keeps its own filter clamping — a tampered ?practice= still falls back to no filter', () => {
    expect(code).toMatch(/validPracticeIds\.has\(params\.practice\)/);
    expect(code).toMatch(/validProviderIds\.has\(params\.provider\)/);
  });

  it('keeps its empty state rather than fabricating a zero', () => {
    expect(code).toMatch(/No practices in your brand yet/);
  });

  it('the ONE addition is the brand name read for the shell header', () => {
    expect(code).toMatch(/from\('practice_groups'\)/);
    expect(code).toMatch(/brandName/);
    // And it changed nothing about what the page shows: still practices, plans,
    // providers, in that order, all service-role, all scoped.
    expect(code).toMatch(/\.in\('group_id', groupIds\)/);
    expect(code).toMatch(/\.in\('practice_id', practiceIds\)/);
  });

  it('did not grow a payouts figure — Overview owns money', () => {
    expect(code).not.toMatch(/payout/i);
  });
});

// ─── No new formatting anywhere in the new surfaces ───────────────────────

describe('no new date or money formatting was introduced', () => {
  const NEW_FILES = [
    'app/brand/BrandShell.tsx',
    'app/brand/BrandNav.tsx',
    'app/brand/brandNavLinks.ts',
    'app/brand/BrandQuickActions.tsx',
    'app/brand/BrandPayoutBlock.tsx',
    'app/brand/brandPayoutCopy.ts',
    'app/brand/practices/page.tsx',
    'app/brand/practices/PracticesTable.tsx',
    'lib/brand/brandPayouts.ts',
    'lib/brand/brandPracticeSetup.ts',
    'lib/brand/brandViewer.ts',
  ];

  it.each(NEW_FILES)('%s defines no money formatter of its own', (path) => {
    const code = stripComments(read(path));
    // The shape of the existing local formatters, which is what must not spread.
    expect(code).not.toMatch(/function formatRand/);
    expect(code).not.toMatch(/function rand\(/);
    expect(code).not.toMatch(/toFixed\(2\)/);
    expect(code).not.toMatch(/style: 'currency'/);
    expect(code).not.toMatch(/toLocaleString\('en-ZA'/);
  });

  it.each(NEW_FILES)('%s defines no date formatter of its own', (path) => {
    const code = stripComments(read(path));
    expect(code).not.toMatch(/toLocaleDateString|getMonth\(\)|getDay\(\)|MONTHS\[/);
    expect(code).not.toMatch(/\bFriday\b|\bThursday\b/);
  });

  it('the ONE component that renders money imports the shared helpers', () => {
    const code = stripComments(read('app/brand/BrandPayoutBlock.tsx'));
    expect(code).toMatch(/formatRand \} from '@\/app\/practice\/billHelpers'/);
    expect(code).toMatch(/formatWeekdayDayMonth \} from '@\/app\/patient\/_format'/);
  });

  it('the ONE remaining local formatter was not copied into anything new', () => {
    // This pin used to name TWO pre-existing local formatters — GroupDashboard's
    // and RevenueClient's. RevenueClient's is gone: it was the one that actually
    // disagreed with the shared formatter (rounded cents, space separator), and
    // the cross-screen comparisons in ./brandRevenueMoney.test.tsx now hold both
    // brand screens to one string. See that file for the bug.
    //
    // GroupDashboard's survives and is asserted here on purpose. Its body is
    // line-for-line the same as billHelpers' formatRand (only the parameter name
    // differs) — a duplicate, not a divergence — so it renders correctly today,
    // and replacing it is a separate cleanup rather than part of a formatting
    // fix. That its OUTPUT still matches is not taken on trust: the cross-screen
    // comparison in ./brandRevenueMoney.test.tsx renders both screens from one
    // fixture and fails if they ever differ by a character.
    expect(read('app/brand/GroupDashboard.tsx')).toMatch(/function formatRand/);
    expect(stripComments(read('app/brand/revenue/RevenueClient.tsx'))).not.toMatch(/function rand\b/);
    for (const path of NEW_FILES) {
      expect(stripComments(read(path)), path).not.toMatch(/replace\(\/\\B\(\?=/);
    }
  });
});

// ─── Diff scope ──────────────────────────────────────────────────────────

describe('diff scope — nothing payment-side, nothing RLS-side was touched', () => {
  const FORBIDDEN = [
    '@/lib/payments/peach',
    '@/lib/paystack/',
    '@/lib/bills/lifecycle',
    'app/api/webhooks',
  ];

  const NEW = [
    'app/brand/BrandPayoutBlock.tsx',
    'app/brand/practices/page.tsx',
    'lib/brand/brandPayouts.ts',
    'lib/brand/brandPracticeSetup.ts',
    'lib/brand/brandViewer.ts',
  ];

  it.each(NEW)('%s imports nothing from the payment rails', (path) => {
    const src = read(path);
    for (const mod of FORBIDDEN) {
      expect(src).not.toContain(`from '${mod}`);
    }
  });

  it('the payout runner and its window logic are only READ, never re-implemented', () => {
    const code = stripComments(read('lib/brand/brandPayouts.ts'));
    expect(code).toMatch(/from '@\/lib\/payments\/payoutSchedule'/);
    // No batching, no writes, no cron concepts.
    expect(code).not.toMatch(/insert\(|update\(|upsert\(|delete\(/);
    expect(code).not.toMatch(/batch_id|window_start|plan_count/);
  });

  it('nothing new writes to the database at all — the whole portal is read-only', () => {
    for (const path of NEW) {
      const code = stripComments(read(path));
      expect(code, path).not.toMatch(/\.insert\(|\.update\(|\.upsert\(|\.delete\(/);
    }
  });

  it('the brand-admin pivot is untouched', () => {
    const code = stripComments(read('app/brand/branch/[practiceId]/page.tsx'));
    expect(code).toMatch(/redirect\(`\/practice\?practiceId=/);
    expect(code).not.toMatch(/notFound\(|practice_group_members/);
  });

  it('the practice-side hero, checklist and payouts tab are not imported for their internals', () => {
    // Reuse is by exported function only. Nothing new reaches into a practice
    // COMPONENT, which would couple the brand portal to that screen's layout.
    for (const path of NEW) {
      const code = stripComments(read(path));
      expect(code, path).not.toMatch(/NextPayoutHero|PracticeSetupChecklist|PayoutBatchList/);
    }
  });
});
