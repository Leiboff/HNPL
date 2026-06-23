import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── Settlement-row exclusion regression suite (post-0058) ──────────────
//
// 0058 introduced `payments.kind` ('instalment' | 'settlement'). A
// settlement row represents a single Paystack charge for the SUMMED
// total of N instalments — its amount is the sum of the instalments it
// covers. Including it anywhere instalments are counted/summed/listed
// would double-count or render as a phantom "Instalment 0".
//
// These tests are source-text regressions. They don't exercise the
// runtime DB; they pin the query SHAPE so a future edit that drops the
// kind filter shows up in CI rather than as a silent doubled total in
// production. The matching unit tests (planProgress.test.ts) cover the
// in-memory side.

const ROOT = resolve(process.cwd());
function read(p: string): string {
  return readFileSync(resolve(ROOT, p), 'utf8');
}

const DASHBOARD       = read('app/patient/page.tsx');
const ORDERS_PAGE     = read('app/patient/orders/page.tsx');
const WEBHOOK         = read('app/api/webhooks/paystack/route.ts');
const CRON            = read('app/api/cron/collect-instalments/route.ts');
const ADMIN_DASH      = read('app/admin/page.tsx');
const ADMIN_LAYOUT    = read('app/admin/layout.tsx');
const ADMIN_CUSTOMERS = read('app/admin/customers/page.tsx');
const ADMIN_COLL      = read('app/admin/collections/page.tsx');

describe('Patient dashboard hero query — excludes settlement rows', () => {
  it("payments query in app/patient/page.tsx carries .eq('kind', 'instalment')", () => {
    // The payments select for the dashboard hero (excludes the
    // newer kind='settlement' rows so a mid-flight settle doesn't
    // appear as a phantom 'Instalment 0 of 3'). The dashboard has
    // exactly one .from('payments') so we span generously up to
    // its terminal .order('due_date'.
    const dashboardQuery = DASHBOARD.match(
      /from\('payments'\)[\s\S]*?\.order\('due_date'/,
    )?.[0] ?? '';
    expect(dashboardQuery).toMatch(/\.eq\('kind',\s*'instalment'\)/);
  });
});

describe('Orders page per-plan payments — filters settlement rows out post-fetch', () => {
  it("the embed selects `kind` so the filter has the column to read", () => {
    expect(ORDERS_PAGE).toMatch(/payments\([^)]*\bkind\b/);
  });

  it("the post-fetch mapping filters payments by kind !== 'settlement'", () => {
    expect(ORDERS_PAGE).toMatch(/\.filter\(\(pmt\)\s*=>\s*pmt\.kind\s*!==\s*'settlement'\)/);
  });
});

describe('Webhook plan-complete check on the normal recurring-instalment path', () => {
  it("filters kind='instalment' so a failed settlement row doesn't block plan completion", () => {
    // The plan-complete check that runs on a normal instalment 2/3
    // charge.success — distinct from the one inside
    // handleSettlementChargeSuccess (which is for the settlement row
    // itself).
    const normalCheck = WEBHOOK.match(
      /from\('payments'\)\s*\.select\('id'\)\s*\.eq\('plan_id',\s*plan\.id\)[\s\S]{0,300}\.neq\('status',\s*'collected'\)/,
    )?.[0] ?? '';
    expect(normalCheck).toMatch(/\.eq\('kind',\s*'instalment'\)/);
  });
});

describe('Cron pulls — explicit kind=instalment on both source queries', () => {
  // Both pulls have the exact form
  //
  //   .eq('kind', 'instalment')
  //   .eq('status', 'scheduled' | 'failed')
  //
  // back-to-back on two source lines. \r?\n handles CRLF on Windows.
  it('scheduled pull carries .eq(kind, instalment) immediately before .eq(status, scheduled)', () => {
    expect(CRON).toMatch(
      /\.eq\('kind',\s*'instalment'\)\s*\r?\n\s*\.eq\('status',\s*'scheduled'\)/,
    );
  });

  it('failed pull carries .eq(kind, instalment) immediately before .eq(status, failed)', () => {
    expect(CRON).toMatch(
      /\.eq\('kind',\s*'instalment'\)\s*\r?\n\s*\.eq\('status',\s*'failed'\)/,
    );
  });
});

describe('Admin SUMMARY aggregations — filter kind, detail views left alone', () => {
  it("admin dashboard's dueToday/overdue/collected-this-month/at-risk queries all carry kind=instalment", () => {
    // Each of the four aggregations on the admin dashboard should
    // exclude settlement rows so totals aren't doubled (settlement
    // amount = sum of covered instalment amounts).
    expect(ADMIN_DASH).toMatch(/\.eq\('kind',\s*'instalment'\)\.eq\('status',\s*'scheduled'\)\.eq\('due_date'/);
    expect(ADMIN_DASH).toMatch(/\.eq\('kind',\s*'instalment'\)\.eq\('status',\s*'scheduled'\)\.lt\('due_date'/);
    expect(ADMIN_DASH).toMatch(/\.eq\('kind',\s*'instalment'\)\.eq\('status',\s*'collected'\)\.gte\('collected_at'/);
    expect(ADMIN_DASH).toMatch(/\.eq\('kind',\s*'instalment'\)\s*\n\s*\.in\('status',\s*\['failed',\s*'retried',\s*'written_off'\]\)/);
  });

  it("admin sidebar overdue-badge count filters kind=instalment", () => {
    expect(ADMIN_LAYOUT).toMatch(/\.eq\('kind',\s*'instalment'\)[\s\S]{0,80}\.eq\('status',\s*'scheduled'\)\.lt\('due_date'/);
  });

  it("admin customers aggregation (per-customer outstanding / reliability) filters kind=instalment", () => {
    expect(ADMIN_CUSTOMERS).toMatch(/from\('payments'\)[\s\S]{0,400}\.eq\('kind',\s*'instalment'\)[\s\S]{0,80}\.in\('patient_id'/);
  });

  it("admin collections chip-count query filters kind=instalment", () => {
    // The chip counts at the top of the collections page are a
    // summary; the detail table below stays unfiltered so admins
    // can see settlement rows for audit.
    expect(ADMIN_COLL).toMatch(/from\('payments'\)\s*\.select\('id, status, due_date'\)\s*\.eq\('kind',\s*'instalment'\)/);
  });
});
