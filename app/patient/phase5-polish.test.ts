import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── Phase 5 — polish guards ────────────────────────────────────────────

const ROOT = resolve(process.cwd());
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

const BOTTOM_NAV = read('app/patient/PatientBottomNav.tsx');
const LANDING    = read('app/patient/explore/Landing.tsx');
const HOME       = read('app/patient/page.tsx');
const ACCOUNT    = read('app/patient/account/page.tsx');
const ACCOUNT_ACC = read('app/patient/account/AccountAccordion.tsx');
const THUMB      = read('app/patient/payment-methods/PaymentMethods.tsx');
const DETAIL     = read('app/patient/orders/[planId]/page.tsx');
const POLLING    = read('app/patient/payment-methods/complete/PollingConfirmation.tsx');

describe('bottom-nav tap target', () => {
  it('each item is a single full-cell Link (icon + label both inside, flex-1)', () => {
    // flex-1 makes the Link fill the cell width; the h-[68px] nav + stretch
    // gives full height — so tapping the label (not just the icon) registers.
    expect(BOTTOM_NAV).toMatch(/<Link[\s\S]*?className="flex-1 flex flex-col/);
    expect(BOTTOM_NAV).toContain('h-[68px]');
  });
});

describe('specialty title wraps (no truncation)', () => {
  it('the category tile title is not truncated ("General Practice" must not clip)', () => {
    const line = LANDING.split('\n').find((l) => l.includes('{c.specialty}</p>')) ?? '';
    expect(line).not.toContain('truncate');
    expect(line).toMatch(/break-words|wrap|line-clamp/);
  });
});

describe('home next-payment CTA labels the two-step action', () => {
  it('reads "View & pay" (it opens the plan detail, where Pay lives)', () => {
    expect(HOME).toContain('View &amp; pay');
    expect(HOME).not.toContain('Pay it now');
  });
});

describe('salary-date deep-link', () => {
  // Post-consolidation: salary date lives nested inside Personal details on
  // the single Account page. The old "Payday" row (→ /patient/profile) is
  // gone; deep-linking is now the account settings accordion honouring
  // ?section (legacy ?section=salary resolves to Personal details).
  it('the account settings accordion honours the ?section deep-link', () => {
    expect(ACCOUNT_ACC).toContain("searchParams?.get('section')");
    expect(ACCOUNT_ACC).toContain("if (value === 'salary') return 'personal'");
  });
});

describe('card-brand chip is single-sourced', () => {
  it('the Account thumbnail and plan-detail chip both use cardBrandLabel', () => {
    expect(THUMB).toMatch(/from '@\/lib\/patient\/cardBrand'/);
    expect(THUMB).toContain('cardBrandLabel(brand)');
    expect(DETAIL).toContain('cardBrandLabel(chargeCard?.card_brand)');
    // The old case-sensitive/truncating renderings are gone.
    expect(THUMB).not.toContain("brand === 'Visa'");
    expect(DETAIL).not.toContain("toUpperCase().slice(0, 4)");
  });
});

describe('no stale Paystack copy on the Peach card flow', () => {
  it('the polling timeout no longer names Paystack', () => {
    expect(POLLING).not.toMatch(/paystack/i);
  });
});
