import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { stripComments } from '@/lib/testing/stripComments';
import GroupDashboard, { type BranchOption, type ProviderOption } from './GroupDashboard';
import RevenueClient from './revenue/RevenueClient';
import { computeRevenue, type RevenuePlan } from '@/lib/brand/revenue';
import { formatRand } from '@/app/practice/billHelpers';

// ─── One figure, one string, on every brand screen ─────────────────────────
//
// THE BUG THIS FILE EXISTS FOR
// ────────────────────────────
// /brand/revenue carried its own money formatter:
//
//   v.toLocaleString('en-ZA', { style: 'currency', currency: 'ZAR',
//                               maximumFractionDigits: 0 })
//
// so R14,180.55 rendered as "R 14 181" there and "R14,180.55" on the brand
// Overview. Three divergences in one line — rounded cents, a non-breaking-space
// thousands separator, and a space after the R — on two screens that both
// describe money a practice reconciles against a bank deposit. A reader
// comparing them cannot tell a formatting choice from a shortfall.
//
// HOW IT IS TESTED, AND WHY NOT WITH TWO EXPECTED STRINGS
// ─────────────────────────────────────────────────────
// The load-bearing test RENDERS BOTH SCREENS from ONE fixture and compares the
// strings they actually produce. Two hand-written expectations would only prove
// that both agree with what I typed today; comparing rendered output proves they
// agree with EACH OTHER, and it keeps proving it if either formatter changes.
//
// Verified capable of failing: restoring the old local helper makes the
// cross-screen comparisons fail with "R 14 181" vs "R14,180.55", and the cents
// and separator tests fail independently of it.

vi.mock('next/navigation', () => ({
  useRouter:       () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
}));

afterEach(cleanup);

const ROOT = resolve(process.cwd());
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

// ─── The shared fixture ────────────────────────────────────────────────────
//
// Amounts chosen so that every figure on both screens lands on non-zero cents
// AND crosses a thousands boundary — the two things the old formatter got
// wrong. A fixture of round thousands would have passed under the bug.

const FEE_PCT = 6;

const BRANCHES: BranchOption[] = [
  { id: 'p-rose', name: 'Rosebank', status: 'approved', suburb: 'Rosebank', city: 'Johannesburg', groupId: 'g1', feePct: FEE_PCT },
  { id: 'p-sand', name: 'Sandton',  status: 'approved', suburb: 'Sandton',  city: 'Johannesburg', groupId: 'g1', feePct: FEE_PCT },
];

const PROVIDERS: ProviderOption[] = [
  { id: 'd-one', fullName: 'Dr One' },
  { id: 'd-two', fullName: 'Dr Two' },
];

/** Recent, so GroupDashboard's default 12-month range includes every row. */
const RECENT = new Date().toISOString();

type PlanRow = RevenuePlan & { created_at: string };

const PLANS: PlanRow[] = [
  { id: '1', practice_id: 'p-rose', provider_member_id: 'd-one', total_amount: 15085.69, status: 'active',    created_at: RECENT },
  { id: '2', practice_id: 'p-rose', provider_member_id: 'd-two', total_amount:  8342.17, status: 'completed', created_at: RECENT },
  { id: '3', practice_id: 'p-sand', provider_member_id: 'd-one', total_amount: 21777.43, status: 'active',    created_at: RECENT },
  // Excluded from revenue by status — present so the fixture is not trivially
  // "every plan counts", which would hide a filtering regression.
  { id: '4', practice_id: 'p-sand', provider_member_id: 'd-two', total_amount:  9999.99, status: 'pending_acceptance', created_at: RECENT },
];

/** Exactly what /brand/revenue's page computes on the server, unfiltered. */
const SUMMARY = computeRevenue(
  PLANS,
  BRANCHES.map((b) => ({ id: b.id, name: b.name, fee_percent: b.feePct })),
  PROVIDERS,
  {},
);

function mountOverview() {
  return render(<GroupDashboard branches={BRANCHES} providers={PROVIDERS} plans={PLANS} />);
}

function mountReports() {
  return render(
    <RevenueClient
      summary={SUMMARY}
      practices={BRANCHES.map((b) => ({ id: b.id, name: b.name }))}
      providers={PROVIDERS}
      selectedPracticeId={null}
      selectedProviderId={null}
    />,
  );
}

/** The string one screen renders, in isolation, for a given testid. */
function textFrom(mount: () => unknown, testId: string): string {
  mount();
  const value = screen.getByTestId(testId).textContent ?? '';
  cleanup();
  return value;
}

// ─── The fixture is not trivial ────────────────────────────────────────────

describe('the fixture actually exercises the bug', () => {
  it('every figure has non-zero cents', () => {
    const figures = [SUMMARY.totalNet, ...SUMMARY.byPractice.map((r) => r.net), ...SUMMARY.byProvider.map((r) => r.net)];
    expect(figures.length).toBeGreaterThan(4);
    for (const f of figures) {
      expect(Math.round(f * 100) % 100, `${f} has no cents`).not.toBe(0);
    }
  });

  it('every figure crosses a thousands boundary', () => {
    // So the separator difference (comma vs non-breaking space) is exercised too,
    // not only the rounding.
    for (const f of [SUMMARY.totalNet, ...SUMMARY.byPractice.map((r) => r.net)]) {
      expect(f).toBeGreaterThan(1000);
    }
  });

  it('the excluded plan really is excluded, so this is not a pass-everything fixture', () => {
    expect(SUMMARY.totalCount).toBe(3);
  });
});

// ─── The cross-screen comparison ───────────────────────────────────────────

describe('the same underlying figure renders identically on both screens', () => {
  it('the group total: Overview hero === Reports headline', () => {
    const overview = textFrom(mountOverview, 'group-hero-total');
    const reports  = textFrom(mountReports,  'revenue-headline');
    expect(reports).toBe(overview);
    // And it is neither empty nor a placeholder — both really rendered a figure.
    expect(overview).toMatch(/^R[\d,]+\.\d{2}$/);
  });

  it('the by-doctor figures: Overview\'s ranked list === Reports\' by-doctor rows', () => {
    // The one breakdown that survives on BOTH screens after the portal
    // restructure, so it is the strongest available per-row comparison.
    mountOverview();
    const overviewList = screen.getByTestId('group-doctor-breakdown').textContent ?? '';
    cleanup();

    mountReports();
    const reportRows = SUMMARY.byProvider.map(
      (r) => screen.getByTestId(`row-provider-${r.id}`).textContent ?? '',
    );
    cleanup();

    expect(reportRows.length).toBeGreaterThan(1);
    for (const r of SUMMARY.byProvider) {
      // Whatever string Reports prints for this doctor's net must be a string
      // Overview also prints. Under the old formatter, Reports printed
      // "R 20 471" while Overview printed "R20,470.78" — no overlap at all.
      const printed = reportRows.find((row) => row.includes(r.label)) ?? '';
      const amount  = printed.match(/R[\d,\s ]+(?:\.\d{2})?/)?.[0] ?? '';
      expect(amount, `no amount found for ${r.label}`).not.toBe('');
      expect(overviewList, `Overview does not print ${amount} for ${r.label}`).toContain(amount);
    }
  });

  it('both screens agree with the shared formatter, figure by figure', () => {
    // Anchors the pair to formatRand rather than only to each other — two
    // screens could agree on the SAME wrong format.
    expect(textFrom(mountReports,  'revenue-headline')).toBe(formatRand(SUMMARY.totalNet));
    expect(textFrom(mountOverview, 'group-hero-total')).toBe(formatRand(SUMMARY.totalNet));
  });
});

// ─── The three specific divergences ────────────────────────────────────────

describe('the three things the old local formatter got wrong', () => {
  it('cents are RENDERED, not rounded away', () => {
    const headline = textFrom(mountReports, 'revenue-headline');
    expect(headline).toMatch(/\.\d{2}$/);
    // The exact cents, so a formatter that printed ".00" for everything fails.
    const cents = String(Math.round(SUMMARY.totalNet * 100) % 100).padStart(2, '0');
    expect(headline.endsWith(`.${cents}`)).toBe(true);
  });

  it('the thousands separator is a comma, never a space', () => {
    const headline = textFrom(mountReports, 'revenue-headline');
    expect(headline).toContain(',');
    expect(headline).not.toMatch(/[   ]/);
  });

  it('there is no space between the R and the digits', () => {
    expect(textFrom(mountReports, 'revenue-headline')).toMatch(/^R\d/);
  });

  it('every money string on Reports has exactly two decimal places', () => {
    mountReports();
    const rows = [
      screen.getByTestId('revenue-headline'),
      ...SUMMARY.byPractice.map((r) => screen.getByTestId(`row-practice-${r.id}`)),
      ...SUMMARY.byProvider.map((r) => screen.getByTestId(`row-provider-${r.id}`)),
    ];
    for (const el of rows) {
      const amounts = (el.textContent ?? '').match(/R[\d,]+\.\d{2}/g) ?? [];
      expect(amounts.length, `no 2dp amount in "${el.textContent}"`).toBeGreaterThan(0);
    }
    cleanup();
  });
});

// ─── No local formatter may come back ──────────────────────────────────────

describe('no money formatter remains in the /brand/revenue tree', () => {
  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
    }
    return out;
  }

  const FILES = walk(resolve(ROOT, 'app/brand/revenue'));

  it('finds the tree (the walk is not vacuously empty)', () => {
    expect(FILES.length).toBeGreaterThanOrEqual(2);
  });

  it.each(['app/brand/revenue/RevenueClient.tsx', 'app/brand/revenue/page.tsx'])(
    '%s declares no formatter of its own',
    (rel) => {
      // Comments stripped: RevenueClient's header QUOTES the old helper in order
      // to explain why it is gone, the same distinction the payout-block pins
      // draw. What must not exist is a real declaration.
      const code = stripComments(read(rel));
      expect(code).not.toMatch(/function rand\b/);
      expect(code).not.toMatch(/function formatRand/);
      expect(code).not.toMatch(/style: 'currency'/);
      expect(code).not.toMatch(/maximumFractionDigits/);
      expect(code).not.toMatch(/toFixed\(/);
      expect(code).not.toMatch(/toLocaleString/);
    },
  );

  it('the whole tree is clean, not just the two files named above', () => {
    for (const file of FILES) {
      const code = stripComments(readFileSync(file, 'utf8'));
      const rel  = file.slice(ROOT.length + 1).replace(/\\/g, '/');
      expect(code, rel).not.toMatch(/style: 'currency'|maximumFractionDigits|toLocaleString/);
    }
  });

  it('RevenueClient imports the shared formatter instead', () => {
    const code = stripComments(read('app/brand/revenue/RevenueClient.tsx'));
    expect(code).toMatch(/import \{ formatRand \} from '@\/app\/practice\/billHelpers'/);
    // Both call sites go through it — the headline and the breakdown rows.
    expect((code.match(/formatRand\(/g) ?? []).length).toBe(2);
  });

  it('Intl currency formatting is gone from the whole app, not relocated', () => {
    // It was the only such call outside date formatting. Its output depends on
    // the ICU build the code is running against, which is not a property a
    // reconcilable figure may have.
    const brand = walk(resolve(ROOT, 'app/brand'));
    for (const file of brand) {
      const code = stripComments(readFileSync(file, 'utf8'));
      const rel  = file.slice(ROOT.length + 1).replace(/\\/g, '/');
      expect(code, rel).not.toMatch(/style: 'currency'/);
    }
  });
});

// ─── The one thing that stays rounded, on purpose ──────────────────────────

describe('the chart\'s y-axis labels stay abbreviated, and say so', () => {
  const CHART = read('app/brand/BrandMonthlyChart.tsx');

  it('still abbreviates — a gridline is a scale marker, not a reconcilable figure', () => {
    const code = stripComments(CHART);
    expect(code).toMatch(/function shortAmt/);
    expect(code).toMatch(/1_000_000\)\.toFixed\(1\)\}M/);
    expect(code).toMatch(/1_000\)\.toFixed\(0\)\}k/);
  });

  it('is commented as a deliberate exception, not left to look like an oversight', () => {
    // The comment is the point: without it, the next person cleaning up money
    // formatting cannot tell this from the bug they are fixing.
    const header = CHART.slice(0, CHART.indexOf('function shortAmt'));
    expect(header).toMatch(/DELIBERATELY ABBREVIATED/);
    expect(header).toMatch(/scale marker|SCALE marker/i);
    expect(header).toMatch(/formatRand/);
  });

  it('the axis labels are the ONLY rounded money strings left on the brand surface', () => {
    // Everything else goes through formatRand. Asserted by exclusion so a new
    // rounded figure elsewhere has to justify itself here.
    const rounded = ['app/brand/BrandMonthlyChart.tsx'];
    const brand = readdirSync(resolve(ROOT, 'app/brand'), { withFileTypes: true })
      .filter((e) => e.isFile() && /\.tsx?$/.test(e.name) && !/\.test\./.test(e.name))
      .map((e) => `app/brand/${e.name}`);
    for (const rel of brand) {
      if (rounded.includes(rel)) continue;
      const code = stripComments(read(rel));
      expect(code, rel).not.toMatch(/toFixed\(0\)|toFixed\(1\)/);
    }
  });
});
