import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { stripComments } from '@/lib/testing/stripComments';

// ─── /practice/payouts — the route, and the chart that moved here ───────────
//
// Source-level, because the page is an async server component. Its rendering is
// behaviour-tested in ./PayoutBatchList.test.tsx and its data in
// lib/practice/payoutHistory.test.ts. What only source can prove:
//
//   1. the authority is the dashboard's — no manager gate re-introducing the
//      asymmetry migration 0092 deliberately removed
//   2. the page is READ-ONLY: no server action, nothing that could ever look
//      like a practice marking its own money paid
//   3. the revenue chart is mounted HERE and nowhere else — the move is a move,
//      not a copy
//   4. nothing in this feature reaches into the runner, the cron or the batching

const ROOT = resolve(process.cwd());
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const codeOf = (p: string) => stripComments(read(p));

const PAGE   = codeOf('app/practice/payouts/page.tsx');
const LIST   = codeOf('app/practice/payouts/PayoutBatchList.tsx');
const COPY   = codeOf('app/practice/payoutCopy.ts');
const DASH   = codeOf('app/practice/page.tsx');
const CLIENT = codeOf('app/practice/PracticeDashboardClient.tsx');

// ─── The route exists and is a sibling of nothing ─────────────────────────

describe('the route', () => {
  it('has a page, and no catch-all beside it', () => {
    expect(existsSync(resolve(ROOT, 'app/practice/payouts/page.tsx'))).toBe(true);
    for (const p of [
      'app/practice/payouts/[...slug]/page.tsx',
      'app/practice/payouts/[[...slug]]/page.tsx',
    ]) {
      expect(existsSync(resolve(ROOT, p)), p).toBe(false);
    }
  });

  it('is dynamic — settlement state changes outside this app', () => {
    // An admin marks a batch paid in /admin/payouts; a cached page would keep
    // telling the practice their money is still waiting.
    expect(PAGE).toMatch(/export const dynamic = 'force-dynamic'/);
  });
});

// ─── Authority: the dashboard's, no narrower and no wider ─────────────────

describe('authority', () => {
  it('resolves the viewer through the shared resolver', () => {
    expect(PAGE).toMatch(/resolvePracticeViewer\(/);
    expect(PAGE).toMatch(/viewer\.kind === 'setup'/);
    expect(PAGE).toMatch(/viewer\.kind === 'denied'\) notFound\(\)/);
  });

  it('keeps the same auth + role gate as every other practice screen', () => {
    expect(PAGE).toMatch(/requireConfirmedUser\(\{ next: '\/practice\/payouts' \}\)/);
    expect(PAGE).toMatch(/profile\?\.role !== 'practice_admin' && profile\?\.role !== 'practice_staff'/);
  });

  it('adds NO manager gate — 0092 widened payouts to every member on purpose', () => {
    // Before 0092, payouts was manager-only while payout_batches was not, so an
    // ordinary member saw a batch total above an empty plan list. Gating this
    // page would re-create that asymmetry in application code.
    expect(PAGE).not.toMatch(/canManagePractice\)\s*notFound/);
    expect(PAGE).not.toMatch(/if \(!canManageTill\)/);
    expect(PAGE).not.toMatch(/guardManager|guardTillManager|guardBrandAdminOfPractice/);
    expect(PAGE).not.toMatch(/canSeeAnySettingsSection/);
  });

  it('reads with service-role ONLY on the brand path, exactly as the dashboard does', () => {
    // profiles was never widened for brand-admins, so the embedded patient
    // label would come back empty on their own client.
    expect(PAGE).toMatch(/const reader = viaBrandAdmin \? svc : supabase/);
    expect(DASH).toMatch(/const reader = viaBrandAdmin \? svc : supabase/);
  });

  it('scopes every read to the resolved practice', () => {
    expect(PAGE).toMatch(/resolvePayoutHistory\(reader, practiceId\)/);
    expect(PAGE).toMatch(/\.eq\('practice_id', practiceId\)/);
  });
});

// ─── Read-only ────────────────────────────────────────────────────────────

describe('the page cannot move money', () => {
  it('declares no server action and submits no form', () => {
    // A practice must never be able to mark its own payout paid — 0090 grants
    // no practice-side INSERT/UPDATE policy on payout_batches at all, and this
    // page asks for nothing that would test it.
    expect(PAGE).not.toMatch(/'use server'/);
    expect(PAGE).not.toMatch(/<form/);
    expect(LIST).not.toMatch(/<form/);
    expect(LIST).not.toMatch(/'use server'/);
  });

  it('writes nothing — no insert, update, upsert or delete anywhere in the feature', () => {
    for (const [name, src] of [['page', PAGE], ['list', LIST], ['copy', COPY]] as const) {
      for (const verb of [/\.insert\(/, /\.update\(/, /\.upsert\(/, /\.delete\(/, /\.rpc\(/]) {
        expect(src, `${name} must not ${verb}`).not.toMatch(verb);
      }
    }
  });

  it('does not import the runner, the cron, or the batching logic', () => {
    // Reporting on batches must not become a second place that makes them.
    for (const forbidden of [
      'runPayoutBatches', 'lib/payments/runPayoutBatches',
      'api/cron', 'payoutWindowForRun', 'payoutWindowEndingOn',
      'activateFirstInstalment', 'admin/payouts',
    ]) {
      expect(PAGE, forbidden).not.toContain(forbidden);
      expect(LIST, forbidden).not.toContain(forbidden);
    }
  });

  it('offers no mark-paid affordance of any kind', () => {
    expect(LIST).not.toMatch(/[Mm]ark paid|markPaid|mark_paid/);
    expect(PAGE).not.toMatch(/[Mm]ark paid|markPaid|mark_paid/);
  });
});

// ─── The chart MOVED — it is not in two places ────────────────────────────

describe('the 12-month revenue chart', () => {
  it('is mounted on the payouts page', () => {
    expect(PAGE).toMatch(/import MonthlyRevenueChart from '\.\.\/MonthlyRevenueChart'/);
    expect(PAGE).toMatch(/<MonthlyRevenueChart/);
  });

  it('is GONE from the dashboard — both the mount and the import', () => {
    // The demotion is the point: a year-scale trend is not what the screen a
    // practice opens every morning is for. A copy left behind would mean two
    // surfaces to keep in step and a dashboard that never got shorter.
    expect(CLIENT).not.toMatch(/MonthlyRevenueChart/);
    expect(DASH).not.toMatch(/MonthlyRevenueChart/);
  });

  it('is mounted in EXACTLY ONE place across the practice portal', () => {
    // Asserted by walking the tree rather than by naming files: a third mount
    // added later would be caught wherever it landed.
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = resolve(dir, e.name);
        if (e.isDirectory()) { walk(full); continue; }
        if (!/\.tsx$/.test(e.name)) continue;
        if (e.name.includes('.test.')) continue;
        if (e.name === 'MonthlyRevenueChart.tsx') continue;   // the definition
        if (stripComments(readFileSync(full, 'utf8')).includes('<MonthlyRevenueChart')) {
          hits.push(full.replace(ROOT, '').replace(/\\/g, '/'));
        }
      }
    };
    walk(resolve(ROOT, 'app'));
    expect(hits).toEqual(['/app/practice/payouts/page.tsx']);
  });

  it('is fed a NARROW projection, not a copy of the dashboard\'s plans select', () => {
    // The chart reads five fields. Copying the dashboard's select would pull
    // patient names, provider embeds, payouts and invitations across for a
    // chart that renders none of them — and make that projection a third thing
    // to keep in step (billsIndex.test.ts already pins two of them identical).
    expect(PAGE).toMatch(/\.select\('id, provider_member_id, total_amount, status, created_at'\)/);
    expect(PAGE).not.toMatch(/plans_patient_id_fkey/);
    expect(PAGE).not.toMatch(/invitations:patient_invitations/);
  });

  it('keeps its net presentation and its shared aggregation', () => {
    // Unchanged by the move — app/practice/monthly-revenue-chart.test.ts owns
    // the rest of this component's contract.
    const CHART = codeOf('app/practice/MonthlyRevenueChart.tsx');
    expect(CHART).toMatch(/mode="net"/);
    expect(CHART).toMatch(/buildMonthlySeries/);
  });
});

// ─── Practice-facing language ─────────────────────────────────────────────

describe('the words', () => {
  it('say "BetterNow fee" and never MDR, anywhere in the feature', () => {
    for (const [name, src] of [['page', PAGE], ['list', LIST], ['copy', COPY]] as const) {
      expect(src, `${name} must not say MDR`).not.toMatch(/\bMDR\b/);
    }
    expect(LIST).toContain('BetterNow fee');
  });

  it('take the status vocabulary from the SHARED module, which the hero also uses', () => {
    // Two surfaces describing the same three certainties in two vocabularies is
    // how a practice ends up unsure whether they mean the same state.
    expect(LIST).toMatch(/from '\.\.\/payoutCopy'/);
    const HERO = codeOf('app/practice/NextPayoutHero.tsx');
    expect(HERO).toMatch(/from '\.\/payoutCopy'/);
    expect(HERO).toMatch(/PAYOUT_ESTIMATE_BADGE/);
    expect(HERO).toMatch(/PAYOUT_BUILDING_LABEL/);
    expect(HERO).toMatch(/payoutEstimateNote/);
  });

  it('keep the copy module free of formatting, so it cannot drift into date logic', () => {
    expect(COPY).not.toMatch(/new Date\b/);
    expect(COPY).not.toMatch(/toFixed/);
    expect(COPY).not.toMatch(/formatRand|formatWeekdayDayMonth/);
  });
});

// ─── The nav entry landed with the route ──────────────────────────────────

describe('the nav', () => {
  it('carries Payouts through the shared source, not a hand-written list', () => {
    const LINKS = codeOf('app/practice/practiceManagerLinks.ts');
    expect(LINKS).toMatch(/label: 'Payouts'/);
    expect(LINKS).toMatch(/\/practice\/payouts\$\{scopeSuffix\}/);
    // Neither surface splices it in itself.
    for (const p of ['app/practice/PracticeNav.tsx', 'app/practice/PracticeHeader.tsx']) {
      expect(codeOf(p), p).not.toMatch(/'Payouts'/);
    }
  });

  it('leaves the exact-match active rule alone — /practice/payouts has no children', () => {
    // /practice and /practice/bills need exact matching because they are
    // prefixes of other routes. /practice/payouts is not, so it correctly falls
    // through to startsWith and nothing about that rule changed.
    for (const p of ['app/practice/PracticeNav.tsx', 'app/practice/PracticeHeader.tsx']) {
      expect(codeOf(p), p).toMatch(/path === '\/practice' \|\| path === '\/practice\/bills'/);
    }
  });
});
