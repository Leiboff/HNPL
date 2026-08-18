import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import AccountSettings, { resolveSection } from './AccountSettings';

// ─── AccountSettings — ONE pattern, four groups, seven sections ──────────
//
// The page this replaced ran three interaction patterns at once: four
// accordion sections, two flat cards (the record, and Log out with its own
// eyebrow), and a chevron nav-row (Get help). The single most valuable thing
// to pin is therefore the uniformity itself — not that a particular section
// exists, but that NO section is a foreign pattern.
//
// Driven through the real component rather than asserted against source, so
// "shares one pattern" is measured on what actually renders.

let sectionParam: string | null = null;
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(sectionParam ? `section=${sectionParam}` : ''),
}));

const SECTIONS = [
  'Personal details',
  'Salary date',
  'Payment cards',
  'Passkeys',
  'Password & recovery',
  'Notifications',
  'Sign out',
] as const;

const GROUPS = ['Your details', 'How you pay', 'Sign-in & security', 'This device'] as const;

function renderSettings() {
  return render(
    <AccountSettings
      personalDetails={<div>PERSONAL_BODY</div>}
      salaryDate={<div>SALARY_BODY</div>}
      paymentCards={<div>CARDS_BODY</div>}
      passkeys={<div>PASSKEYS_BODY</div>}
      password={<div>PASSWORD_BODY</div>}
      notifications={<div>NOTIFICATIONS_BODY</div>}
      signOut={<div>SIGNOUT_BODY</div>}
    />,
  );
}

const headerFor = (title: string) => screen.getByText(title).closest('button');

afterEach(() => { cleanup(); sectionParam = null; });

describe('ONE interaction pattern across every section', () => {
  it('every section is a disclosure button with a controlled panel', () => {
    // THE test for this rework. Each of the seven must be the same thing: a
    // button carrying aria-expanded and pointing at a panel via
    // aria-controls. A flat block or a nav-row would have neither.
    renderSettings();
    for (const title of SECTIONS) {
      const btn = headerFor(title);
      expect(btn, title).toBeTruthy();
      expect(btn!.getAttribute('aria-expanded'), title).toMatch(/^(true|false)$/);
      expect(btn!.getAttribute('aria-controls'), title).toBeTruthy();
    }
  });

  it('renders exactly seven section headers and no eighth surface', () => {
    renderSettings();
    const expanders = screen
      .getAllByRole('button')
      .filter((b) => b.getAttribute('aria-expanded') !== null);
    expect(expanders).toHaveLength(SECTIONS.length);
  });

  it('every section title appears exactly once', () => {
    // Duplication was the specific defect in the old Security section, which
    // had both a section header and an inner "Passkeys" sub-heading.
    renderSettings();
    for (const title of SECTIONS) {
      expect(screen.getAllByText(title), title).toHaveLength(1);
    }
  });

  it('no section renders a link styled as a navigation row', () => {
    // The retired third pattern. A chevron row masquerading as a section is
    // what made the old page read as three designs.
    const { container } = renderSettings();
    const rowLinks = Array.from(container.querySelectorAll('a')).filter((a) =>
      a.className.includes('justify-between'),
    );
    expect(rowLinks).toHaveLength(0);
  });

  it('every section toggles — none is permanently open', () => {
    renderSettings();
    for (const title of SECTIONS) {
      const btn = headerFor(title)!;
      const before = btn.getAttribute('aria-expanded');
      fireEvent.click(btn);
      expect(btn.getAttribute('aria-expanded'), title).not.toBe(before);
    }
  });
});

describe('four groups carry the hierarchy', () => {
  it('renders all four group headers', () => {
    renderSettings();
    for (const g of GROUPS) expect(screen.getAllByText(g), g).toHaveLength(1);
  });

  it('group headers are NOT interactive', () => {
    // Collapsible groups containing collapsible sections would be two
    // disclosure levels for one decision. The headers are labels.
    renderSettings();
    for (const g of GROUPS) {
      expect(screen.getByText(g).closest('button'), g).toBeNull();
    }
  });
});

describe('destructive and rare actions sit behind a deliberate expand', () => {
  // NOTE on how "collapsed" is asserted here. AccordionSection collapses with
  // CSS (grid-rows 0fr) rather than by conditional render, so the body stays in
  // the DOM and `queryByText(...)` finds it either way — an earlier version of
  // these tests asserted absence and failed for that reason. The real
  // guarantee is the pair the component sets: aria-expanded on the header and
  // aria-hidden on the panel. That is what assistive tech reads, and it is what
  // is checked below.
  const panelFor = (title: string) => {
    const btn = headerFor(title)!;
    return document.getElementById(btn.getAttribute('aria-controls')!)!;
  };

  it('Sign out is collapsed on arrival', () => {
    // It used to be a permanently-visible red button in its own card, where a
    // mis-tap could reach it.
    renderSettings();
    expect(headerFor('Sign out')!.getAttribute('aria-expanded')).toBe('false');
    expect(panelFor('Sign out').getAttribute('aria-hidden')).toBe('true');
  });

  it('Password & recovery is collapsed on arrival', () => {
    renderSettings();
    expect(headerFor('Password & recovery')!.getAttribute('aria-expanded')).toBe('false');
    expect(panelFor('Password & recovery').getAttribute('aria-hidden')).toBe('true');
  });

  it('but both are reachable in one tap — disclosed, not hidden', () => {
    // "Behind an expand" must not become "buried". One deliberate tap each,
    // and the panel becomes visible to assistive tech.
    renderSettings();
    fireEvent.click(headerFor('Sign out')!);
    expect(headerFor('Sign out')!.getAttribute('aria-expanded')).toBe('true');
    expect(panelFor('Sign out').getAttribute('aria-hidden')).toBe('false');
    expect(screen.getByText('SIGNOUT_BODY')).toBeTruthy();

    fireEvent.click(headerFor('Password & recovery')!);
    expect(panelFor('Password & recovery').getAttribute('aria-hidden')).toBe('false');
    expect(screen.getByText('PASSWORD_BODY')).toBeTruthy();
  });
});

describe('default open state and deep links', () => {
  it('Payment cards is the only section open on arrival', () => {
    renderSettings();
    expect(headerFor('Payment cards')!.getAttribute('aria-expanded')).toBe('true');
    for (const title of SECTIONS.filter((t) => t !== 'Payment cards')) {
      expect(headerFor(title)!.getAttribute('aria-expanded'), title).toBe('false');
    }
  });

  it('?section=salary opens the SALARY section, not Personal details', () => {
    // The legacy alias retiring because its target now exists. The confirm
    // screen's "set your salary date" CTA depends on this landing correctly.
    sectionParam = 'salary';
    renderSettings();
    expect(headerFor('Salary date')!.getAttribute('aria-expanded')).toBe('true');
    expect(headerFor('Personal details')!.getAttribute('aria-expanded')).toBe('false');
  });

  it('?section=personal still opens Personal details, where phone lives', () => {
    // The verify-phone CTA's target — it did not move.
    sectionParam = 'personal';
    renderSettings();
    expect(headerFor('Personal details')!.getAttribute('aria-expanded')).toBe('true');
  });

  it('every section key is deep-linkable', () => {
    for (const [key, title] of [
      ['personal', 'Personal details'],
      ['salary', 'Salary date'],
      ['pay', 'Payment cards'],
      ['passkeys', 'Passkeys'],
      ['password', 'Password & recovery'],
      ['notifications', 'Notifications'],
      ['signout', 'Sign out'],
    ] as const) {
      cleanup();
      sectionParam = key;
      renderSettings();
      expect(headerFor(title)!.getAttribute('aria-expanded'), key).toBe('true');
    }
  });

  it('an unknown or absent ?section is ignored rather than throwing', () => {
    expect(resolveSection(null)).toBeNull();
    expect(resolveSection('')).toBeNull();
    expect(resolveSection('nonsense')).toBeNull();
    expect(resolveSection('salary')).toBe('salary');
  });
});
