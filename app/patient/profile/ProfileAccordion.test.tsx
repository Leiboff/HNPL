import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import ProfileAccordion from './ProfileAccordion';

// ─── Phase 5 — Payday deep-link auto-expands the Salary date section ────
//
// Normal load: everything collapsed. Arriving with ?section=salary (the
// Account "Payday" row) opens the Salary date section so the patient lands
// on what they tapped. Open state is exposed via aria-expanded.

let params = new URLSearchParams();
vi.mock('next/navigation', () => ({ useSearchParams: () => params }));

beforeEach(() => { params = new URLSearchParams(); });

function renderAccordion() {
  render(
    <ProfileAccordion
      personalDetails={<div>personal-body</div>}
      salaryDay={<div>salary-body</div>}
      notifications={<div>notifications-body</div>}
      passkeys={<div>passkeys-body</div>}
    />,
  );
}

const expanded = (name: RegExp) =>
  screen.getByRole('button', { name }).getAttribute('aria-expanded');

describe('ProfileAccordion deep-link', () => {
  it('opens only the Salary date section for ?section=salary', () => {
    params = new URLSearchParams('section=salary');
    renderAccordion();
    expect(expanded(/Salary date/)).toBe('true');
    expect(expanded(/Personal details/)).toBe('false');
    expect(expanded(/Notifications/)).toBe('false');
  });

  it('opens the Personal details section for ?section=personal', () => {
    params = new URLSearchParams('section=personal');
    renderAccordion();
    expect(expanded(/Personal details/)).toBe('true');
    expect(expanded(/Salary date/)).toBe('false');
  });

  it('leaves everything collapsed on a normal load (no param)', () => {
    renderAccordion();
    expect(expanded(/Personal details/)).toBe('false');
    expect(expanded(/Salary date/)).toBe('false');
    expect(expanded(/Notifications/)).toBe('false');
  });

  it('ignores an unknown section value', () => {
    params = new URLSearchParams('section=bogus');
    renderAccordion();
    expect(expanded(/Salary date/)).toBe('false');
  });
});
