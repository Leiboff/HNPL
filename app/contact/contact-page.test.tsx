import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, extname, sep } from 'node:path';
import ContactPage from './ContactPage';
import {
  ADDRESS_LINES,
  HOURS,
  LEGAL_ENTITY,
  PHONE_DISPLAY,
  PHONE_TEL,
  REGISTRATION_NUMBER,
  SUPPORT_EMAIL,
} from '@/lib/config/contact';

// ─── /contact — published contact details ───────────────────────────────
//
// This page exists for acquirer / merchant-onboarding compliance: a bank
// needs to see real, verifiable contact details published on the site. It
// is NOT a support experience, and these pins hold it to that:
//
//   • the route is PUBLIC (no auth gate) — the whole point is that an
//     onboarding reviewer with no account can read it,
//   • email and phone are TAPPABLE with the exact published values,
//   • the hours render as one line, exactly as given,
//   • the registered entity appears alongside the trading name,
//   • the phone number lives in exactly ONE source location, and
//   • no contact form / chat / ticketing / FAQ has crept in.
//
// ─── On naming the literals in this file ──────────────────────────────
//
// The value assertions below hard-type the published details rather than
// comparing a constant to itself. Asserting
// `PHONE_DISPLAY === PHONE_DISPLAY` would pass no matter what the number
// became, which is exactly the failure a compliance pin has to catch — a
// typo'd or silently-swapped number would ship green. So the literals are
// written out here ON PURPOSE, and CONFIG_MATCHES_PUBLISHED below ties
// them to the config so the two cannot drift apart.
//
// The consequence is that the digits appear in this test file as well as in
// lib/config/contact.ts, so the "exactly ONE source location" scan
// deliberately excludes test files. The property being protected is that
// PRODUCTION markup has a single home for the number — a test naming its
// expected value is what makes that home verifiable, not a second home.

// ── The published details, verbatim from the compliance brief ──────────
const PUBLISHED = {
  email:   'support@betternow.co.za',
  phone:   '084 232 4201',
  tel:     '+27842324201',
  address: 'Unit 35, 19 Cross Road, Glenhazel, Johannesburg, 2192',
  hours:   'Monday to Friday, 08:00–17:00',
  entity:  'BETTERNOW (PTY) LTD',
  regNo:   '2026/420968/07',
} as const;

const ROOT = resolve(process.cwd());
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

const PAGE   = read('app/contact/page.tsx');
const BODY   = read('app/contact/ContactPage.tsx');
const CONFIG = read('lib/config/contact.ts');
const FOOTER = read('app/_landing/SiteFooter.tsx');

describe('/contact — the config is the published detail', () => {
  it('CONFIG_MATCHES_PUBLISHED: every constant equals the brief exactly', () => {
    // This is the test that gives every other assertion its teeth: it is
    // the one place the config is compared to an independently-written
    // literal rather than to itself.
    expect(SUPPORT_EMAIL).toBe(PUBLISHED.email);
    expect(PHONE_DISPLAY).toBe(PUBLISHED.phone);
    expect(PHONE_TEL).toBe(PUBLISHED.tel);
    expect(HOURS).toBe(PUBLISHED.hours);
    expect(LEGAL_ENTITY).toBe(PUBLISHED.entity);
    expect(REGISTRATION_NUMBER).toBe(PUBLISHED.regNo);
    expect(ADDRESS_LINES.join(', ')).toBe(PUBLISHED.address);
  });

  it('the display and tel: forms describe the SAME digits', () => {
    // 084 232 4201 → +27 84 232 4201: drop the trunk 0, prefix +27.
    const localDigits = PHONE_DISPLAY.replace(/\D/g, '');
    expect(localDigits).toMatch(/^0\d{9}$/);
    expect(PHONE_TEL).toBe(`+27${localDigits.slice(1)}`);
  });

  it('the phone number is flagged TEMPORARY in the config', () => {
    // The number is a personal one standing in for a business line. The
    // comment is what tells the next reader the swap is expected — losing
    // it is how a placeholder quietly becomes permanent.
    expect(CONFIG).toMatch(/TEMPORARY/);
    expect(CONFIG).toMatch(/personal number/i);
  });
});

describe('/contact — the phone number has exactly ONE source location', () => {
  // Every realistic way the number could be re-typed elsewhere. Matching
  // formatted variants rather than stripping all punctuation from each
  // file avoids false positives from unrelated digits becoming adjacent.
  const VARIANTS = [
    '084 232 4201',
    '0842324201',
    '084-232-4201',
    '084.232.4201',
    '+27842324201',
    '+27 84 232 4201',
    '+27 (84) 232 4201',
    '27842324201',
  ];

  function sourceFiles(dir: string): string[] {
    const out: string[] = [];
    const walk = (d: string) => {
      for (const entry of readdirSync(resolve(ROOT, d))) {
        if (entry === 'node_modules' || entry.startsWith('.')) continue;
        const rel = join(d, entry);
        const abs = resolve(ROOT, rel);
        if (statSync(abs).isDirectory()) { walk(rel); continue; }
        if (!['.ts', '.tsx', '.css', '.js', '.jsx', '.json', '.md'].includes(extname(entry))) continue;
        // Test files are allowed to name the expected value — see the
        // header note. Excluding them is what makes the pin meaningful
        // rather than self-defeating.
        if (/\.test\.(ts|tsx)$/.test(entry)) continue;
        out.push(rel);
      }
    };
    walk(dir);
    return out;
  }

  it('appears in lib/config/contact.ts and NOWHERE else in app/ lib/ components/', () => {
    const files = [
      ...sourceFiles('app'),
      ...sourceFiles('lib'),
      ...sourceFiles('components'),
    ];

    const hits = files.filter((f) => {
      const text = read(f);
      return VARIANTS.some((v) => text.includes(v));
    });

    expect(hits).toEqual([['lib', 'config', 'contact.ts'].join(sep)]);
  });

  it('the page markup renders the number from the config, never typed inline', () => {
    for (const v of VARIANTS) expect(BODY).not.toContain(v);
    expect(BODY).toMatch(/PHONE_DISPLAY/);
    expect(BODY).toMatch(/PHONE_TEL/);
    expect(BODY).toMatch(/from '@\/lib\/config\/contact'/);
  });

  it('the number is not propagated into page metadata', () => {
    // metadata is crawlable and cacheable; a temporary personal number
    // should not end up in a search result or a link preview.
    for (const v of VARIANTS) expect(PAGE).not.toContain(v);
  });
});

describe('/contact route wiring', () => {
  it('page.tsx exports metadata and renders the ContactPage component', () => {
    expect(PAGE).toMatch(/export const metadata/);
    expect(PAGE).toMatch(/<ContactPage\s*\/>/);
  });

  it('is publicly reachable — no auth gate, no redirect, no data fetch', () => {
    // The compliance value of this page is that a reviewer with no account
    // can read it. An auth client or a redirect would defeat it entirely.
    expect(PAGE).not.toMatch(/getUser|redirect\(|createClient/);
    expect(BODY).not.toMatch(/getUser|redirect\(|createClient/);
    expect(BODY).not.toMatch(/requireConfirmedUser|getRequestUser/);
  });

  it('uses the marketing chrome, not the authenticated app shell', () => {
    expect(BODY).toMatch(/SiteHeader/);
    expect(BODY).toMatch(/SiteFooter/);
    expect(BODY).toMatch(/landing\.css/);
    expect(BODY).toMatch(/lp-root/);
    // Not the patient/practice shell.
    expect(BODY).not.toMatch(/PatientScreen|PracticeScreen/);
  });

  it('is a server component — no client directive, no hooks', () => {
    expect(BODY).not.toMatch(/^'use client'/m);
    expect(BODY).not.toMatch(/useState|useEffect/);
  });
});

describe('/contact renders unauthenticated', () => {
  // No auth mocking of any kind is set up in this file. That absence IS
  // the test: the component renders with no session, no Supabase client
  // and no request context available.
  it('renders the page with a Contact heading and no session', () => {
    render(<ContactPage />);
    expect(screen.getByRole('heading', { level: 1, name: /contact us/i })).toBeTruthy();
  });

  it('email is tappable with the exact published address', () => {
    render(<ContactPage />);
    const link = screen.getByRole('link', { name: PUBLISHED.email });
    expect(link.getAttribute('href')).toBe(`mailto:${PUBLISHED.email}`);
  });

  it('phone is tappable with the exact published number', () => {
    render(<ContactPage />);
    const link = screen.getByRole('link', { name: PUBLISHED.phone });
    expect(link.getAttribute('href')).toBe(`tel:${PUBLISHED.tel}`);
    expect(link.textContent?.trim()).toBe(PUBLISHED.phone);
  });

  it('hours render as ONE line, exactly as given', () => {
    const { container } = render(<ContactPage />);
    const text = container.textContent ?? '';
    expect(text).toContain(PUBLISHED.hours);
    // Exactly one set of hours — not split per channel.
    const occurrences = text.split(PUBLISHED.hours).length - 1;
    expect(occurrences).toBe(1);
  });

  it('states only when we are OPEN — no closed days, no absence copy', () => {
    const { container } = render(<ContactPage />);
    const text = (container.textContent ?? '').toLowerCase();
    for (const banned of [
      'closed', 'weekend', 'saturday', 'sunday', 'public holiday',
      'after hours', 'outside these hours', 'unavailable',
    ]) {
      expect(text).not.toContain(banned);
    }
  });

  it('renders the physical address, line by line', () => {
    const { container } = render(<ContactPage />);
    const text = container.textContent ?? '';
    for (const line of ADDRESS_LINES) expect(text).toContain(line);
    // In a semantic <address> element.
    expect(container.querySelector('address')).toBeTruthy();
  });

  it('renders the registered entity alongside the trading name', () => {
    const { container } = render(<ContactPage />);
    const text = container.textContent ?? '';
    expect(text).toContain(PUBLISHED.entity);
    expect(text).toContain(PUBLISHED.regNo);
    expect(text.toLowerCase()).toContain('betternow');
  });
});

describe('/contact is NOT a support experience', () => {
  it('has no contact form, no inputs, no chat widget in the markup', () => {
    for (const banned of [
      '<form', '<input', '<textarea', '<select',
      'onSubmit', 'useForm', 'action=',
    ]) {
      expect(BODY).not.toContain(banned);
    }
  });

  it('renders no form controls at all', () => {
    const { container } = render(<ContactPage />);
    expect(container.querySelector('form')).toBeNull();
    expect(container.querySelector('input')).toBeNull();
    expect(container.querySelector('textarea')).toBeNull();
  });

  it('carries no FAQ, knowledge-base or ticketing copy', () => {
    const text = BODY.toLowerCase();
    for (const banned of [
      'faq', 'frequently asked', 'knowledge base', 'help centre',
      'help center', 'ticket', 'live chat', 'whatsapp',
    ]) {
      // The header comment explains WHY there is no FAQ; strip comments so
      // the explanation itself does not trip the pin.
      const stripped = text.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      expect(stripped).not.toContain(banned);
    }
  });
});

describe('the landing footer links to /contact', () => {
  it('has a Contact us link beside the existing legal links', () => {
    expect(FOOTER).toMatch(/<Link href="\/contact">Contact us<\/Link>/);
  });

  it('sits in the same column as Terms and Privacy', () => {
    const legalCol = FOOTER.slice(FOOTER.indexOf('<h5>Legal</h5>'));
    const col = legalCol.slice(0, legalCol.indexOf('</div>'));
    expect(col).toMatch(/\/contact/);
    expect(col).toMatch(/\/legal\/terms/);
    expect(col).toMatch(/\/legal\/privacy/);
  });
});

describe('in-app support affordances', () => {
  const ACCOUNT  = read('app/patient/account/page.tsx');
  const DECLINED = read('app/patient/orders/DeclinedPlanDetail.tsx');

  it('the account "Get help" footer link reaches /contact', () => {
    // The general-purpose help entry point. A page carrying every channel
    // beats a bare mailto:, which dead-ends for anyone without a
    // configured mail client.
    const idx = ACCOUNT.indexOf('data-testid="account-get-help"');
    expect(idx).toBeGreaterThan(-1);
    const anchor = ACCOUNT.slice(ACCOUNT.lastIndexOf('<a', idx), idx);
    expect(anchor).toMatch(/href="\/contact"/);
    expect(anchor).not.toMatch(/mailto:/);
  });

  it('the CONTEXT-SPECIFIC support links deliberately stay mailto:', () => {
    // Pinned as a decision, not an oversight. The declined-bill link
    // pre-fills a subject line, and the locked-fields link reads as an
    // inline sentence; routing either through a page would add a hop and
    // lose the pre-filled context.
    expect(DECLINED).toMatch(/mailto:support@betternow\.co\.za\?subject=Declined bill/);
    expect(ACCOUNT).toMatch(/mailto:support@betternow\.co\.za[^?]*"[\s\S]{0,400}Contact support/);
  });
});
