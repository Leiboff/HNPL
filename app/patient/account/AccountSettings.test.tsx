import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import AccountSettings from './AccountSettings';

// ─── AccountSettings — ONE pattern, three grouped cards, eight rows ──────
//
// Replaces the accordion-era test suite. Direct product decision
// (2026-08-20): tapping a settings row now opens a full screen with the
// details, rather than expanding a panel in place — the accordion, its
// open/closed state, and its `?section=` deep-link resolution are gone.
// Salary date and salary amount are no longer their own row: they moved
// into Personal details (see app/patient/account/personal/page.tsx).
//
// Sign out is no longer a row either (same date, separate decision):
// ProfileLogoutSection renders directly at the bottom instead of behind
// its own /patient/account/signout screen — one red button didn't need a
// whole navigable screen in front of it.
//
// REGROUPED 2026-08-21: five bare-text groups became three rounded CARDS
// (GroupCard) — "How you pay" and "This device" each had exactly one row,
// so both folded into General rather than staying as single-row groups.
// Renamed to match: "Your details" → "General", "Sign-in & security" →
// "Security", "Help & legal" → "Support". "Notifications" is relabelled
// "Preferences" — same route, same screen, title only. None of this
// changes the underlying invariant this file exists to pin: every row is
// STILL a link to its own route (in-app or not), none is a
// button/disclosure, and none is styled differently from the others —
// only now they sit inside a shared card per group instead of each
// carrying its own border/shadow.

const ROWS = [
  ['Personal details',      '/patient/account/personal'],
  ['Payment cards',         '/patient/account/pay'],
  ['Preferences',           '/patient/account/notifications'],
  ['Passkeys',              '/patient/account/passkeys'],
  ['Password & recovery',   '/patient/account/password'],
  ['Contact us',            '/patient/account/contact'],
  ['Terms & conditions',    '/legal/terms'],
  ['Privacy policy',        '/legal/privacy'],
] as const;

const GROUPS = ['General', 'Security', 'Support'] as const;

describe('every row is a plain link to its own screen', () => {
  it('renders exactly eight rows, each a link to its expected route', () => {
    render(<AccountSettings />);
    for (const [title, href] of ROWS) {
      const link = screen.getByText(title).closest('a');
      expect(link, title).toBeTruthy();
      expect(link!.getAttribute('href'), title).toBe(href);
    }
  });

  it('renders no extra surface — link count matches ROWS exactly', () => {
    render(<AccountSettings />);
    expect(screen.getAllByRole('link')).toHaveLength(ROWS.length);
  });

  it('no row carries accordion semantics (aria-expanded / aria-controls)', () => {
    // The retired pattern. A row that still behaves like a disclosure button
    // would mean the conversion is incomplete.
    render(<AccountSettings />);
    for (const [title] of ROWS) {
      const link = screen.getByText(title).closest('a')!;
      expect(link.getAttribute('aria-expanded'), title).toBeNull();
      expect(link.hasAttribute('aria-controls'), title).toBe(false);
    }
  });

  it('every row title appears exactly once', () => {
    render(<AccountSettings />);
    for (const [title] of ROWS) {
      expect(screen.getAllByText(title), title).toHaveLength(1);
    }
  });
});

describe('three grouped cards carry the hierarchy', () => {
  it('renders all three group headers', () => {
    render(<AccountSettings />);
    for (const g of GROUPS) expect(screen.getAllByText(g), g).toHaveLength(1);
  });

  it('group headers are NOT interactive', () => {
    // Collapsible groups containing navigable rows would be two different
    // interaction models stacked on one decision. The headers are labels.
    render(<AccountSettings />);
    for (const g of GROUPS) {
      const el = screen.getByText(g);
      expect(el.closest('a'), g).toBeNull();
      expect(el.closest('button'), g).toBeNull();
    }
  });
});

describe('destructive and rare actions still sit behind a deliberate tap', () => {
  it('Password & recovery is an ordinary row, not a permanently-visible action', () => {
    // Used to be an inner sub-heading. Now, like every other row, it is one
    // tap away via its own screen rather than sitting inline on the index.
    render(<AccountSettings />);
    const link = screen.getByText('Password & recovery').closest('a');
    expect(link).toBeTruthy();
    expect(link!.textContent?.trim()).toBe('Password & recovery');
  });

  it('Sign out renders directly as a button, not a row behind its own screen', () => {
    // The one row that got REMOVED rather than kept: a whole
    // /patient/account/signout screen for one red button was ceremony, not
    // real friction, so ProfileLogoutSection now renders inline instead.
    render(<AccountSettings />);
    expect(screen.getByText('Sign out').closest('a')).toBeNull();
    const button = screen.getByTestId('profile-logout-button');
    expect(button.tagName).toBe('BUTTON');
    expect(button.textContent).toContain('Sign out');
  });
});
