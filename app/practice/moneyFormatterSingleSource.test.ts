import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { stripComments } from '@/lib/testing/stripComments';
import { formatRand } from './billHelpers';

// ─── One money formatter for the practice and brand surfaces ────────────────
//
// WHY THIS PIN EXISTS
// ───────────────────
// billHelpers exports formatRand, and five other files under app/practice/** and
// app/brand/** had carried their own line-for-line copy of it:
//
//   app/brand/GroupDashboard.tsx
//   app/brand/branch/[practiceId]/BranchPerformance.tsx
//   app/practice/pos/CounterSessionForm.tsx
//   app/practice/bills/new/BillWaitingPanel.tsx
//   app/practice/bills/new/BillForm.tsx
//
// None was a live bug — every one produced byte-identical output. The reason to
// remove them is what happened on the sixth: /brand/revenue's copy was written
// with Intl instead, with maximumFractionDigits: 0, and rendered R14,180.55 as
// "R 14 181" while the brand Overview showed the true figure for the same money.
// Nothing caught it, because a local copy is invisible to every test that reads
// the shared helper.
//
// A duplicate is a divergence that has not happened yet. So the rule is now
// structural: on these two surfaces, money is formatted in exactly one place.
//
// SCOPE, AND WHAT IS DELIBERATELY OUT OF IT
// ─────────────────────────────────────────
// app/practice/** and app/brand/** only. Other trees (app/patient, app/checkout,
// app/admin, app/provider) each carry their own copies too, and consolidating
// them is a bigger change than a cleanup: app/patient/_format.ts and
// app/admin/_lib/format.ts are already-established per-surface exports, and
// several of the checkout/patient copies take CENTS rather than rands, so they
// are not drop-in swaps. Left alone deliberately, and reported.
//
// TWO EXEMPTIONS, both named rather than pattern-matched:
//   • billHelpers.ts — the one true source.
//   • BrandMonthlyChart.tsx — its shortAmt() abbreviates y-axis ticks on purpose
//     (R1.2M / R14k), documented at length in that file as the one money-ish
//     string on a brand surface allowed not to be exact. A gridline is a scale
//     marker; nobody reconciles one.

const ROOT = resolve(process.cwd());
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

const SOURCE_OF_TRUTH = 'app/practice/billHelpers.ts';
const ROUNDS_ON_PURPOSE = 'app/brand/BrandMonthlyChart.tsx';

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const FILES = [
  ...walk(resolve(ROOT, 'app/practice')),
  ...walk(resolve(ROOT, 'app/brand')),
].map((f) => f.slice(ROOT.length + 1).replace(/\\/g, '/'));

describe('no local money formatter remains under app/practice/** or app/brand/**', () => {
  it('found the trees (the walk is not vacuously empty)', () => {
    expect(FILES.length).toBeGreaterThan(40);
    expect(FILES).toContain(SOURCE_OF_TRUTH);
    expect(FILES).toContain(ROUNDS_ON_PURPOSE);
  });

  it('exactly ONE file declares a rand formatter, and it is billHelpers', () => {
    const declaring = FILES.filter((rel) => {
      if (rel === ROUNDS_ON_PURPOSE) return false;
      return /function (formatRand|formatRandCents|rand)\b/.test(stripComments(read(rel)));
    });
    expect(declaring).toEqual([SOURCE_OF_TRUTH]);
  });

  it('nobody rebuilds the thousands-separator regex — the tell-tale of a copy', () => {
    // The distinctive half of the implementation. A copy that renamed its
    // function would still carry this.
    const copies = FILES.filter((rel) =>
      rel !== SOURCE_OF_TRUTH && /replace\(\/\\B\(\?=\(\\d\{3\}\)/.test(stripComments(read(rel))),
    );
    expect(copies).toEqual([]);
  });

  it('no Intl currency formatting anywhere on these surfaces', () => {
    // The shape the /brand/revenue divergence actually took. Its output depends
    // on the ICU build the code is running against, which is not a property a
    // reconcilable figure may have.
    const intl = FILES.filter((rel) =>
      /style: 'currency'|maximumFractionDigits|toLocaleString\([^)]*currency/.test(stripComments(read(rel))),
    );
    expect(intl).toEqual([]);
  });

  it('the five files that used to carry a copy now import the shared one', () => {
    const DEDUPED = [
      'app/brand/GroupDashboard.tsx',
      'app/brand/branch/[practiceId]/BranchPerformance.tsx',
      'app/practice/pos/CounterSessionForm.tsx',
      'app/practice/bills/new/BillWaitingPanel.tsx',
      'app/practice/bills/new/BillForm.tsx',
    ];
    for (const rel of DEDUPED) {
      const code = stripComments(read(rel));
      expect(code, rel).toMatch(/import \{ formatRand \} from '(\.\.\/)*(\.\.\/)*billHelpers'|import \{ formatRand \} from '@\/app\/practice\/billHelpers'/);
      expect(code, rel).not.toMatch(/function formatRand/);
      // And they still USE it — an unused import would mean the figure vanished.
      expect(code, rel).toMatch(/formatRand\(/);
    }
  });
});

describe('the one exemption still rounds, and still says why', () => {
  it('BrandMonthlyChart abbreviates axis ticks on purpose', () => {
    const code = stripComments(read(ROUNDS_ON_PURPOSE));
    expect(code).toMatch(/function shortAmt/);
    expect(code).toMatch(/toFixed\(1\)\}M/);
    expect(code).toMatch(/toFixed\(0\)\}k/);
    // The comment is load-bearing: without it the next person cleaning up money
    // formatting cannot tell this from the bug they are fixing.
    const src = read(ROUNDS_ON_PURPOSE);
    expect(src.slice(0, src.indexOf('function shortAmt'))).toMatch(/DELIBERATELY ABBREVIATED/);
  });

  it('and it is NOT a general money formatter — it never formats a reconcilable figure', () => {
    const code = stripComments(read(ROUNDS_ON_PURPOSE));
    expect(code).not.toMatch(/function formatRand/);
  });
});

describe('the shared formatter behaves as every de-duplicated caller expected', () => {
  // The five copies were line-for-line identical (only the parameter name
  // differed), so the swap should be output-identical. This states the contract
  // they were all relying on, so a change to billHelpers cannot silently alter
  // five surfaces at once.
  it.each([
    [0,          'R0.00'],
    [1,          'R1.00'],
    [1450.5,     'R1,450.50'],
    [899.99,     'R899.99'],
    [1000,       'R1,000.00'],
    [1234567.89, 'R1,234,567.89'],
    [50000,      'R50,000.00'],
  ])('formatRand(%d) === %s', (input, expected) => {
    expect(formatRand(input as number)).toBe(expected);
  });

  it('always renders exactly two decimal places', () => {
    for (const v of [0, 5, 5.1, 5.125, 99999.999]) {
      expect(formatRand(v)).toMatch(/\.\d{2}$/);
    }
  });

  it('groups thousands with a comma, never a space', () => {
    expect(formatRand(1234.5)).toContain(',');
    expect(formatRand(1234.5)).not.toMatch(/[   ]/);
  });
});
