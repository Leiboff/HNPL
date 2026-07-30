import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';

// ─── Create-bill entry points all flow through the gated component ──────────
//
// The trading gate (lib/practice/tradingGate.ts) is supposed to govern
// every "Create a bill" trigger. Earlier we shipped a bug where one of
// the two visible buttons was correctly disabled but the OTHER (in
// BillsBlock empty-state) was a bare <a href> — clicking it bounced
// silently off the /practice/bills/new page guard. To stop that ever
// recurring, we ban hardcoded /practice/bills/new hrefs outside the
// shared CreateBillButton + the destination page itself.
//
// If a future entry point legitimately needs to deep-link to
// /practice/bills/new (e.g. a server-side redirect that already vetted
// the gate), add it to ALLOWED below.

const ROOT = resolve(process.cwd());

function rel(p: string): string {
  return relative(ROOT, p).split(/[\\/]/).join('/');
}

function readSrc(p: string): string {
  return readFileSync(resolve(ROOT, p), 'utf8');
}

function collectSourceFiles(dir: string, acc: string[] = []): string[] {
  const IGNORE = new Set(['node_modules', '.next', 'dist', 'build', 'coverage', '.git', 'public']);
  for (const entry of readdirSync(dir)) {
    if (IGNORE.has(entry)) continue;
    const full = join(dir, entry);
    const st   = statSync(full);
    if (st.isDirectory()) collectSourceFiles(full, acc);
    else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) acc.push(full);
  }
  return acc;
}

// Files allowed to mention the literal /practice/bills/new path.
const ALLOWED = new Set([
  // The destination page itself (page.tsx, actions.ts).
  'app/practice/bills/new/page.tsx',
  'app/practice/bills/new/actions.ts',
  'app/practice/bills/new/BillForm.tsx',
  // The shared component every entry point routes through.
  'app/practice/CreateBillButton.tsx',
  // The shareUrl is built from NEXT_PUBLIC_APP_URL — different surface.
]);

const ALL_SRC = collectSourceFiles(ROOT)
  .filter((p) => !p.includes('.next'))
  .filter((p) => !rel(p).startsWith('node_modules'));

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('regression: /practice/bills/new only reached through CreateBillButton', () => {
  // Match quoted forms only ("..." or '...') so we catch real link/string
  // literals and ignore prose mentions in comments. JSX attributes use
  // double-quotes; redirect()/router.push() take single- or double-quoted
  // string args — both are checked.
  const QUOTED_PATH = /["']\/practice\/bills\/new["']/;

  it('no source file outside ALLOWED uses a quoted "/practice/bills/new" literal', () => {
    const offenders = ALL_SRC
      .filter((p) => !ALLOWED.has(rel(p)))
      .filter((p) => QUOTED_PATH.test(readFileSync(p, 'utf8')));
    expect(offenders.map(rel)).toEqual([]);
  });
});

describe('CreateBillButton is the gate-aware single source of truth', () => {
  it('exports a default component that takes a TradingGateResult', () => {
    const src = readSrc('app/practice/CreateBillButton.tsx');
    expect(src).toMatch(/TradingGateResult/);
    expect(src).toMatch(/export default function CreateBillButton/);
  });

  it('renders an <a> when gate.ok and a disabled <button> otherwise', () => {
    const src = readSrc('app/practice/CreateBillButton.tsx');
    expect(src).toMatch(/gate\.ok/);
    expect(src).toMatch(/aria-disabled/);
    expect(src).toMatch(/disabled/);
    expect(src).toMatch(/title=\{gate\.message\}/);
  });
});

describe('every dashboard entry point uses CreateBillButton', () => {
  it.each([
    'app/practice/page.tsx',
    'app/practice/BillsBlock.tsx',
    'app/brand/branch/[practiceId]/page.tsx',
  ])('%s imports CreateBillButton and does not render a bare /practice/bills/new <a>', (path) => {
    const src = readSrc(path);
    expect(src).toMatch(/CreateBillButton/);
    expect(src).not.toMatch(/href="\/practice\/bills\/new"/);
  });

  it('BillsBlock renders the empty-state CTA via the shared component (regression: the second-button bug)', () => {
    const src = readSrc('app/practice/BillsBlock.tsx');
    // The "No bills yet" branch must use CreateBillButton, not a bare <a>.
    const emptyStateIdx = src.indexOf('No bills yet');
    expect(emptyStateIdx).toBeGreaterThan(0);
    const emptyStateChunk = src.slice(emptyStateIdx, emptyStateIdx + 800);
    expect(emptyStateChunk).toMatch(/CreateBillButton/);
  });
});

describe('/brand/branch/[practiceId] CTA is scoped to THE BRANCH', () => {
  // A brand-admin with N≥2 branches must land on a bill scoped to the
  // branch they were viewing — CreateBillButton forwards practiceId=X
  // onto /practice/bills/new which reads searchParams.practiceId and
  // then createBill (bills/new/actions.ts) writes plans.practice_id=X.
  // The payout, patient-facing practice name, and refs all resolve
  // through plans.practice_id, so scoping the CTA to the branch id is
  // sufficient to attribute the bill correctly.

  const SRC = readSrc('app/brand/branch/[practiceId]/page.tsx');

  it('imports the shared trading-gate check and computes gate for this page', () => {
    expect(SRC).toMatch(/import \{[^}]*checkTradingGate[^}]*\} from '@\/lib\/practice\/tradingGate'/);
    expect(SRC).toMatch(/checkTradingGate\(s, practiceId\)/);
  });

  it('renders CreateBillButton with variant="primary" and forwards practiceId to scope the bill to THIS branch', () => {
    expect(SRC).toMatch(/<CreateBillButton\s+gate=\{gate\}\s+variant="primary"\s+practiceId=\{practiceId\}\s*\/>/);
  });

  it('renders the co-located banking hint when the gate fails on banking (fix is on this same page)', () => {
    expect(SRC).toMatch(/gate\.reason === 'no_banking'/);
    expect(SRC).toMatch(/branch-banking-hint/);
    expect(SRC).toMatch(/#banking/);
    // BranchBankingForm is wrapped in the anchor target on the same page.
    expect(SRC).toMatch(/id="banking"/);
  });
});

describe('/practice/bills/new redirects with an explanation when gated', () => {
  it('redirects to /practice?reason=trading_gate (not a bare /practice)', () => {
    const src = readSrc('app/practice/bills/new/page.tsx');
    // The redirect target on the gated branch carries the reason param so
    // the dashboard can render its bounce-back banner. May also carry
    // &practiceId=… to preserve the scope selection when the caller has
    // multiple branches; the important guarantee is that reason=trading_gate
    // is present in the target URL.
    expect(src).toMatch(/redirect\(`\/practice\?reason=trading_gate/);
  });

  it('dashboard renders the bounce-back banner when reason=trading_gate AND gate is closed', () => {
    const src = readSrc('app/practice/page.tsx');
    expect(src).toMatch(/searchParams/);
    expect(src).toMatch(/reason.*trading_gate/);
    expect(src).toMatch(/trading-gate-bounce-banner/);
  });
});
