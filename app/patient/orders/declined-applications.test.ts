import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── Phase 2 — declined bills are not "finished" ────────────────────────
//
// A declined bill never became a plan and was never charged. It must sit
// in its own "Declined" section (no green success tick, no "Receipt"), and
// tapping it must open the minimal DeclinedPlanDetail — never the
// active-plan template (schedule / ladder / live card / settle / receipt).
// These pins fail if a regression folds declined back into the finished
// list or routes it through the plan-management screen.

const ROOT = resolve(process.cwd());
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

const ORDERS_PAGE = read('app/patient/orders/page.tsx');
const ORDERS_VIEW = read('app/patient/orders/OrdersView.tsx');
const DETAIL_PAGE = read('app/patient/orders/[planId]/page.tsx');
const DECLINED    = read('app/patient/orders/DeclinedPlanDetail.tsx');

describe('Plans page — declined is its own bucket', () => {
  it('buckets via the shared planBucket helper', () => {
    expect(ORDERS_PAGE).toMatch(/from '@\/lib\/patient\/planBucket'/);
    expect(ORDERS_PAGE).toMatch(/planBucket\(p\.status\) === 'declined'/);
    expect(ORDERS_PAGE).toMatch(/planBucket\(p\.status\) === 'finished'/);
  });

  it('passes finished and declined to the view as separate lists', () => {
    expect(ORDERS_PAGE).toMatch(/finishedPlans=\{finishedPlans\}/);
    expect(ORDERS_PAGE).toMatch(/declinedPlans=\{declinedPlans\}/);
  });
});

describe('OrdersView — Declined section', () => {
  it('renders a dedicated "Declined" section', () => {
    expect(ORDERS_VIEW).toMatch(/label="Declined"/);
    expect(ORDERS_VIEW).toContain('DeclinedRow');
  });

  it('the declined row has no "Receipt" link (nothing was charged)', () => {
    // Split the file at DeclinedRow's definition; the "Receipt" affordance
    // lives only in FinishedRow, which must come before it.
    const declinedRowIdx = ORDERS_VIEW.indexOf('function DeclinedRow');
    const declinedRowBody = ORDERS_VIEW.slice(declinedRowIdx, ORDERS_VIEW.indexOf('type Props', declinedRowIdx));
    expect(declinedRowBody).not.toContain('Receipt');
    // ...and the declined row shows the neutral "declined" caption.
    expect(declinedRowBody).toContain('declined');
  });
});

describe('Plan detail — declined routes to the minimal view', () => {
  it('branches on isDeclinedPlan and renders DeclinedPlanDetail', () => {
    expect(DETAIL_PAGE).toMatch(/from '@\/lib\/patient\/planBucket'/);
    expect(DETAIL_PAGE).toMatch(/isDeclinedPlan\(/);
    expect(DETAIL_PAGE).toContain('<DeclinedPlanDetail');
  });

  it('DeclinedPlanDetail carries no schedule / settle / payment-method / receipt chrome', () => {
    expect(DECLINED).not.toContain('PlanSettleAffordance');
    expect(DECLINED).not.toContain('PaymentMethods');
    expect(DECLINED).not.toContain('InstalmentLadder');
    expect(DECLINED).not.toContain('Schedule');
    expect(DECLINED).not.toContain('Receipt');
    // It is honest about no charge.
    expect(DECLINED).toContain('no money was taken');
  });
});
