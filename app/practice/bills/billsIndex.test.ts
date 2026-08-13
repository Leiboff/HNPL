import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { stripComments } from '@/lib/testing/stripComments';

// ─── /practice/bills — the index route ────────────────────────────────────
//
// Source-level, because the page is an async server component. Its filtering
// UI is behaviour-tested in ./BillsBrowser.test.tsx.
//
// Three things matter here and none of them is visible from a render test:
//   1. it does NOT shadow /practice/bills/new, which already existed
//   2. it reuses the shared table rather than growing a second one
//   3. its authority and its plans query match the dashboard's exactly — a
//      second, slightly-different projection is how one surface ends up
//      missing a field the shared component reads

const ROOT = resolve(process.cwd());
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

// Shared helper — see lib/testing/stripComments.ts.
const codeOf = (src: string) => stripComments(src);

const PAGE     = codeOf(read('app/practice/bills/page.tsx'));
const BROWSER  = codeOf(read('app/practice/bills/BillsBrowser.tsx'));
const DASH     = codeOf(read('app/practice/page.tsx'));
const BLOCK    = codeOf(read('app/practice/BillsBlock.tsx'));

// ─── Route coexistence ────────────────────────────────────────────────────

describe('the index route does not collide with /practice/bills/new', () => {
  it('both page files exist, as siblings in the URL space', () => {
    // In the App Router a directory's own page.tsx serves the directory's
    // path and its children serve theirs — /practice/bills and
    // /practice/bills/new are not competitors.
    expect(existsSync(resolve(ROOT, 'app/practice/bills/page.tsx'))).toBe(true);
    expect(existsSync(resolve(ROOT, 'app/practice/bills/new/page.tsx'))).toBe(true);
  });

  it('the index does not intercept, rewrite, or catch-all the /new path', () => {
    // The ways an index route CAN swallow a sibling: a catch-all segment
    // beside it, or the page itself branching on the rest of the path.
    for (const p of [
      'app/practice/bills/[...slug]/page.tsx',
      'app/practice/bills/[[...slug]]/page.tsx',
      'app/practice/bills/[slug]/page.tsx',
    ]) {
      expect(existsSync(resolve(ROOT, p)), p).toBe(false);
    }
    expect(PAGE).not.toMatch(/redirect\('\/practice\/bills\/new'\)/);
  });

  it('the new-bill page still stands on its own', () => {
    const NEW = codeOf(read('app/practice/bills/new/page.tsx'));
    expect(NEW).toMatch(/requireConfirmedUser/);
    expect(NEW).toMatch(/<PracticeShell/);
    // Its trading-gate bounce is untouched.
    expect(NEW).toMatch(/redirect\(`\/practice\?reason=trading_gate/);
  });

  it('the nav matches /practice/bills EXACTLY, so Bills does not light up on /new', () => {
    // /practice/bills is a string prefix of /practice/bills/new, so a
    // startsWith test would highlight the Bills tab while the caller is on
    // the new-bill form — a different screen with its own heading.
    for (const p of ['app/practice/PracticeNav.tsx', 'app/practice/PracticeHeader.tsx']) {
      const src = codeOf(read(p));
      expect(src, p).toMatch(/path === '\/practice' \|\| path === '\/practice\/bills'/);
    }
  });
});

// ─── One table, not two ───────────────────────────────────────────────────

describe('reuses the extracted table', () => {
  it('the browser renders ../BillsTable', () => {
    expect(BROWSER).toMatch(/import BillsTable from '\.\.\/BillsTable'/);
    expect(BROWSER).toMatch(/<BillsTable/);
  });

  it('duplicates none of the table markup', () => {
    // The markup that would have been copied: the table element itself, the
    // column headers, and the per-row disclosure.
    expect(BROWSER).not.toMatch(/<table/);
    expect(BROWSER).not.toMatch(/<thead/);
    expect(BROWSER).not.toMatch(/<tbody/);
    expect(BROWSER).not.toMatch(/bill-toggle/);
    expect(BROWSER).not.toMatch(/StatusBadge|DetailFields/);
  });

  it('takes its status labels from the shared lifecycle helper', () => {
    // Not a local copy of the four words — the chip in each row comes from
    // the same helper, so the filter cannot name a state differently.
    expect(BROWSER).toMatch(/from '@\/lib\/bills\/lifecycle'/);
    expect(BROWSER).toMatch(/billLifecycleChip\(s\)\.label/);
    expect(BROWSER).toMatch(/deriveBillLifecycleStatus\(/);
  });

  it('searches the patient string the table actually displays', () => {
    // patientDisplay renders "Nomsa D." — searching anything else would find
    // nothing for a name the reader can plainly see.
    expect(BROWSER).toMatch(/patientDisplay/);
  });
});

// ─── Authority and data, matched to the dashboard ─────────────────────────

describe('authority is the dashboard’s, no narrower and no wider', () => {
  it('resolves the viewer through the shared resolver', () => {
    expect(PAGE).toMatch(/resolvePracticeViewer\(/);
    expect(PAGE).toMatch(/viewer\.kind === 'setup'/);
    expect(PAGE).toMatch(/viewer\.kind === 'denied'\) notFound\(\)/);
  });

  it('keeps the same auth + role gate as every other practice screen', () => {
    expect(PAGE).toMatch(/requireConfirmedUser\(\{ next: '\/practice\/bills' \}\)/);
    expect(PAGE).toMatch(/profile\?\.role !== 'practice_admin' && profile\?\.role !== 'practice_staff'/);
  });

  it('is NOT manager-gated — a member who can bill can find their bill', () => {
    expect(PAGE).not.toMatch(/canManagePractice\) notFound/);
    expect(PAGE).not.toMatch(/if \(!canManageTill\)/);
    expect(PAGE).not.toMatch(/canSeeAnySettingsSection/);
  });

  it('reads with service-role ONLY on the brand path, exactly as the dashboard does', () => {
    // RLS's is_practice_member only recognises practice_members, so a
    // brand-admin-only caller would otherwise read no plans and no names.
    expect(PAGE).toMatch(/const reader = viaBrandAdmin \? svc : supabase/);
    expect(DASH).toMatch(/const reader = viaBrandAdmin \? svc : supabase/);
  });

  it('runs the same plans projection as the dashboard, field for field', () => {
    // Both render the same PlanSummary through the same table. A drifting
    // projection is how one of them loses a field the component reads.
    const selectOf = (src: string) => {
      const i = src.indexOf(".from('plans')");
      expect(i).toBeGreaterThan(0);
      const chunk = src.slice(i, src.indexOf('.eq(', i));
      return chunk.replace(/\s+/g, ' ').trim();
    };
    expect(selectOf(PAGE)).toBe(selectOf(DASH));
  });

  it('keys specialty on the MEMBERSHIP id, as plans have carried since 0094', () => {
    expect(PAGE).toMatch(/provider_member_id/);
    expect(PAGE).toMatch(/specialtyMap\[m\.id\] = m\.specialty/);
  });
});

// ─── The create path stays gated ──────────────────────────────────────────

describe('creating a bill from here goes through the gated component', () => {
  it('uses CreateBillButton rather than a bare link', () => {
    // app/practice/create-bill-entries.test.ts bans a hardcoded
    // /practice/bills/new href outside the shared component.
    expect(PAGE).toMatch(/import CreateBillButton from '\.\.\/CreateBillButton'/);
    expect(PAGE).toMatch(/<CreateBillButton gate=\{gate\} variant="primary" practiceId=\{practiceId\}/);
    expect(PAGE).not.toMatch(/href="\/practice\/bills\/new"/);
  });

  it('consumes the trading gate read-only', () => {
    expect(PAGE).toMatch(/checkTradingGate\(svc, practiceId\)/);
    // No new reason strings, no local re-derivation of the gate's conditions.
    expect(PAGE).not.toMatch(/status !== 'approved'/);
    expect(PAGE).not.toMatch(/resolvePayoutBanking/);
  });
});

// ─── The inbound link from the dashboard ──────────────────────────────────

describe('the dashboard reaches it', () => {
  it('the recent-bills card carries a See all link to /practice/bills', () => {
    expect(BLOCK).toMatch(/data-testid="bills-see-all"/);
    expect(BLOCK).toMatch(/\/practice\/bills\?practiceId=/);
    expect(BLOCK).toMatch(/See all/);
  });

  it('the link carries the practice scope, falling back to the bare path', () => {
    // A brand-admin viewing one branch must stay on that branch.
    expect(BLOCK).toMatch(/practiceId \? `\/practice\/bills\?practiceId=\$\{encodeURIComponent\(practiceId\)\}` : '\/practice\/bills'/);
  });

  it('leaves the rest of the recent-bills card alone', () => {
    // Regression: the See all link is an addition, not a rearrangement.
    expect(BLOCK).toMatch(/Recent bills/);
    expect(BLOCK).toMatch(/<CreateBillButton gate=\{gate\} variant="subtle"/);
    expect(BLOCK).toMatch(/<CreateBillButton gate=\{gate\} variant="cta"/);
    expect(BLOCK).toMatch(/<BillsTable/);
    expect(BLOCK).toMatch(/handleExportCSV/);
    expect(BLOCK).toMatch(/handleExportPDF/);
  });
});
