import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import AccountAccordion from './AccountAccordion';

// ─── AccountAccordion — one settings pattern, no duplicate sections ─────
//
// Three disclosure sections (Personal details, Notifications, Security &
// sign-in) with the cards block inline between the first and the rest.
// Deep-link ?section=<key> opens that one; legacy ?section=salary resolves
// to Personal details (salary now lives nested inside it).

let sectionParam: string | null = null;
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(sectionParam ? `section=${sectionParam}` : ''),
}));

function renderAccordion() {
  return render(
    <AccountAccordion
      personalDetails={<div>PERSONAL_BODY</div>}
      howYouPay={<div>HOW_YOU_PAY_BODY</div>}
      notifications={<div>NOTIFICATIONS_BODY</div>}
      security={<div>SECURITY_BODY</div>}
    />,
  );
}

describe('AccountAccordion', () => {
  it('renders each settings heading exactly once', () => {
    sectionParam = null;
    renderAccordion();
    expect(screen.getAllByText('Personal details')).toHaveLength(1);
    expect(screen.getAllByText('Notifications')).toHaveLength(1);
    expect(screen.getAllByText('Security & sign-in')).toHaveLength(1);
  });

  it('renders the cards block inline (always visible, not gated by a toggle)', () => {
    sectionParam = null;
    renderAccordion();
    expect(screen.getByText('HOW_YOU_PAY_BODY')).toBeTruthy();
  });

  it('sections start collapsed with no deep-link', () => {
    sectionParam = null;
    renderAccordion();
    const buttons = screen.getAllByRole('button');
    buttons.forEach((b) => expect(b.getAttribute('aria-expanded')).toBe('false'));
  });

  it('tapping a heading expands only that section', () => {
    sectionParam = null;
    renderAccordion();
    fireEvent.click(screen.getByText('Notifications'));
    const notifBtn = screen.getByText('Notifications').closest('button')!;
    const secBtn   = screen.getByText('Security & sign-in').closest('button')!;
    expect(notifBtn.getAttribute('aria-expanded')).toBe('true');
    expect(secBtn.getAttribute('aria-expanded')).toBe('false');
  });

  it('?section=security opens Security & sign-in on load', () => {
    sectionParam = 'security';
    renderAccordion();
    expect(screen.getByText('Security & sign-in').closest('button')!.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Personal details').closest('button')!.getAttribute('aria-expanded')).toBe('false');
  });

  it('legacy ?section=salary opens Personal details (salary nested there now)', () => {
    sectionParam = 'salary';
    renderAccordion();
    expect(screen.getByText('Personal details').closest('button')!.getAttribute('aria-expanded')).toBe('true');
  });
});
