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
  // /brand/branch/[practiceId] used to be a third entry point with its
  // own branch-scoped CTA. It is now a redirect into /practice, so the
  // brand-admin arrives at the dashboard's own CreateBillButton with
  // ?practiceId= already set — one entry point instead of two, and the
  // branch-scoping assertions below moved onto the pivot itself.
  it.each([
    'app/practice/page.tsx',
    'app/practice/BillsBlock.tsx',
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

describe('a brand-admin opening a branch still gets a BRANCH-SCOPED bill CTA', () => {
  // A brand-admin with N≥2 branches must land on a bill scoped to the
  // branch they were viewing — CreateBillButton forwards practiceId=X
  // onto /practice/bills/new which reads searchParams.practiceId and
  // then createBill (bills/new/actions.ts) writes plans.practice_id=X.
  // The payout, patient-facing practice name, and refs all resolve
  // through plans.practice_id, so scoping the CTA to the branch id is
  // sufficient to attribute the bill correctly.
  //
  // /brand/branch/[practiceId] used to carry that CTA itself. It now
  // redirects into the practice dashboard CARRYING the branch id, and the
  // dashboard's own CreateBillButton is already scoped to the practice it
  // resolved — so the guarantee is preserved through the pivot rather
  // than by a second copy of the button. What must hold: the pivot
  // forwards the id, and the dashboard scopes its CTA to it.

  const PIVOT     = readSrc('app/brand/branch/[practiceId]/page.tsx');
  const DASHBOARD = readSrc('app/practice/page.tsx');

  it('the pivot forwards the branch id onto the dashboard', () => {
    expect(PIVOT).toMatch(/redirect\(`\/practice\?practiceId=\$\{encodeURIComponent\(practiceId\)\}`\)/);
  });

  it('the dashboard scopes its CTA to the resolved practice', () => {
    expect(DASHBOARD).toMatch(/<CreateBillButton\s+gate=\{gate\}\s+variant="primary"\s+practiceId=\{practiceId\}\s*\/>/);
  });

  it('the banking hint + #banking anchor live WITH the banking form, now on /practice/settings', () => {
    // Followed the form: banking is a SECTION of Settings since the nav
    // restructure. /practice/details remains as a redirect that names no
    // fragment of its own, so the dashboard CTA's #banking still lands on
    // the anchor asserted here.
    const SETTINGS = readSrc('app/practice/settings/page.tsx');
    expect(SETTINGS).toMatch(/gate\.reason === 'no_banking'/);
    expect(SETTINGS).toMatch(/branch-banking-hint/);
    expect(SETTINGS).toMatch(/#banking/);
    expect(SETTINGS).toMatch(/id="banking"/);
    // And the legacy route still resolves, without swallowing the fragment.
    const DETAILS = readSrc('app/practice/details/page.tsx');
    expect(DETAILS).toMatch(/redirect\(`\/practice\/settings\$\{suffix\}`\)/);
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
