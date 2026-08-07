import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import AccountAccordion from './AccountAccordion';

// ─── AccountAccordion — one settings pattern, no duplicate sections ─────
//
// FOUR disclosure sections in ONE accordion system (Personal details, How
// you pay, Notifications, Security & sign-in) — no section is a foreign
// flat block. "How you pay" starts open so cards stay visible, but it's a
// real toggleable section like the others. Deep-link ?section=<key> opens
// that one; legacy ?section=salary resolves to Personal details (salary now
// lives nested inside it).

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
    expect(screen.getAllByText('How you pay')).toHaveLength(1);
    expect(screen.getAllByText('Notifications')).toHaveLength(1);
    expect(screen.getAllByText('Security & sign-in')).toHaveLength(1);
  });

  it('every settings section shares one affordance: a toggle button + panel', () => {
    // Consistency guarantee — four accordion header buttons, no foreign
    // flat block. Each header controls a disclosure panel (aria-expanded).
    sectionParam = null;
    renderAccordion();
    const headings = ['Personal details', 'How you pay', 'Notifications', 'Security & sign-in'];
    headings.forEach((h) => {
      const btn = screen.getByText(h).closest('button');
      expect(btn).toBeTruthy();
      expect(btn!.getAttribute('aria-expanded')).toBeTruthy();
    });
  });

  it('"How you pay" is a real section (own toggle) and starts open so cards stay visible', () => {
    sectionParam = null;
    renderAccordion();
    const payBtn = screen.getByText('How you pay').closest('button')!;
    expect(payBtn.getAttribute('aria-expanded')).toBe('true'); // open on load
    expect(screen.getByText('HOW_YOU_PAY_BODY')).toBeTruthy();
    // …but it's a real toggle, not a permanent flat block: tapping collapses it.
    fireEvent.click(payBtn);
    expect(payBtn.getAttribute('aria-expanded')).toBe('false');
  });

  it('the other settings sections start collapsed with no deep-link', () => {
    sectionParam = null;
    renderAccordion();
    ['Personal details', 'Notifications', 'Security & sign-in'].forEach((h) => {
      expect(screen.getByText(h).closest('button')!.getAttribute('aria-expanded')).toBe('false');
    });
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
