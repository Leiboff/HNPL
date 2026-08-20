import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import AccountSettings from './AccountSettings';

// ─── AccountSettings — ONE pattern, four groups, six navigable rows ──────
//
// Replaces the accordion-era test suite. Direct product decision
// (2026-08-20): tapping a settings row now opens a full screen with the
// details, rather than expanding a panel in place — the accordion, its
// open/closed state, and its `?section=` deep-link resolution are gone.
// Salary date and salary amount are no longer their own row: they moved
// into Personal details (see app/patient/account/personal/page.tsx), so
// SECTIONS below has six rows where the accordion-era list had seven.
//
// The single most valuable thing to pin is still the uniformity: every row
// is a plain link to its own route, none is a button/disclosure, and none
// is styled differently from the others.

const ROWS = [
  ['Personal details',      '/patient/account/personal'],
  ['Payment cards',         '/patient/account/pay'],
  ['Passkeys',              '/patient/account/passkeys'],
  ['Password & recovery',   '/patient/account/password'],
  ['Notifications',         '/patient/account/notifications'],
  ['Sign out',              '/patient/account/signout'],
] as const;

const GROUPS = ['Your details', 'How you pay', 'Sign-in & security', 'This device'] as const;

describe('every row is a plain link to its own screen', () => {
  it('renders exactly six rows, each a link to its expected route', () => {
    render(<AccountSettings />);
    for (const [title, href] of ROWS) {
      const link = screen.getByText(title).closest('a');
      expect(link, title).toBeTruthy();
      expect(link!.getAttribute('href'), title).toBe(href);
    }
  });

  it('renders no eighth surface — link count matches ROWS exactly', () => {
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

describe('four groups carry the hierarchy', () => {
  it('renders all four group headers', () => {
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
  it('Sign out and Password & recovery are ordinary rows, not permanently-visible actions', () => {
    // They used to be a flat red button / an inner sub-heading respectively.
    // Now, like every other row, they are one tap away via their own screen
    // rather than sitting inline on the index.
    render(<AccountSettings />);
    for (const title of ['Sign out', 'Password & recovery']) {
      const link = screen.getByText(title).closest('a');
      expect(link, title).toBeTruthy();
      // A row, not an inline destructive control (e.g. no red button text
      // like "Sign out of this device" rendered directly on the index).
      expect(link!.textContent?.trim()).toBe(title);
    }
  });
});
