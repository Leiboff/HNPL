import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { stripComments } from '@/lib/testing/stripComments';
import { resolve, join, extname, sep } from 'node:path';
import ContactPage from './ContactPage';
import {
  ADDRESS_LINES,
  HOURS,
  PHONE_DISPLAY,
  PHONE_TEL,
  SUPPORT_EMAIL,
} from '@/lib/config/contact';

// ─── /contact — two-column contact page ─────────────────────────────────
//
// The page publishes our contact details (acquirer / merchant-onboarding
// compliance) AND carries an enquiry form. These pins hold both halves:
//
//   • the route is PUBLIC — an onboarding reviewer with no account reads it,
//   • two columns: details left, form card right,
//   • email and phone are TAPPABLE with the exact published values,
//   • the hours render as one line, exactly as given,
//   • the phone number lives in exactly ONE source location,
//   • and the things that were REMOVED stay removed.
//
// The form's own behaviour is tested in ContactForm.test.tsx, and the send
// path in contactAction.test.ts. This file mocks the action so rendering the
// page never reaches a server-only module.
//
// ─── On naming the literals in this file ──────────────────────────────
//
// The value assertions hard-type the published details rather than comparing
// a constant to itself. `PHONE_DISPLAY === PHONE_DISPLAY` would pass whatever
// the number became, which is exactly the failure a compliance pin must
// catch. CONFIG_MATCHES_PUBLISHED ties these literals to the config so the
// two cannot drift, and the "exactly ONE source location" scan therefore
// excludes test files — the property protected is that PRODUCTION markup has
// a single home, and a test naming its expected value is what makes that home
// verifiable rather than a second home.

vi.mock('./contactAction', () => ({
  submitContactEnquiry: async () => ({ ok: true }),
}));

// ── The published details, verbatim from the brief ─────────────────────
const PUBLISHED = {
  email:   'support@betternow.co.za',
  phone:   '084 232 4201',
  tel:     '+27842324201',
  address: '19 Cross Road, Glenhazel, Johannesburg, 2192',
  hours:   'Monday to Friday, 08:00–17:00',
} as const;

const ROOT = resolve(process.cwd());
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

/** Comments stripped. Several assertions below check that a phrase is GONE
 *  from the page, and the page's own comments explain WHY it was removed —
 *  naming it there must not read as still shipping it. Only rendered content
 *  is in scope. Uses the repo's own single-pass stripper. */
const PAGE   = stripComments(read('app/contact/page.tsx'));
const BODY   = stripComments(read('app/contact/ContactPage.tsx'));
const BODY_RAW = read('app/contact/ContactPage.tsx');
const FORM   = read('app/contact/ContactForm.tsx');
const ACTION = read('app/contact/contactAction.ts');
const CONFIG = read('lib/config/contact.ts');
const CSS    = read('app/contact/contact.css');
const FOOTER = read('app/_landing/SiteFooter.tsx');

describe('/contact — the config is the published detail', () => {
  it('CONFIG_MATCHES_PUBLISHED: every constant equals the brief exactly', () => {
    expect(SUPPORT_EMAIL).toBe(PUBLISHED.email);
    expect(PHONE_DISPLAY).toBe(PUBLISHED.phone);
    expect(PHONE_TEL).toBe(PUBLISHED.tel);
    expect(HOURS).toBe(PUBLISHED.hours);
    expect(ADDRESS_LINES.join(', ')).toBe(PUBLISHED.address);
  });

  it('the address has NO unit number — it is "19 Cross Road"', () => {
    expect(ADDRESS_LINES[0]).toBe('19 Cross Road');
    expect(ADDRESS_LINES.join(', ')).not.toMatch(/unit/i);
  });

  it('the display and tel: forms describe the SAME digits', () => {
    const localDigits = PHONE_DISPLAY.replace(/\D/g, '');
    expect(localDigits).toMatch(/^0\d{9}$/);
    expect(PHONE_TEL).toBe(`+27${localDigits.slice(1)}`);
  });

  it('the phone number is still flagged TEMPORARY in the config', () => {
    expect(CONFIG).toMatch(/TEMPORARY/);
    expect(CONFIG).toMatch(/personal number/i);
  });
});

// ─── "Unit 35" is gone from the whole repo, not just the page ──────────

describe('no "Unit 35" survives anywhere in the repo', () => {
  function sourceFiles(dir: string): string[] {
    const out: string[] = [];
    const walk = (d: string) => {
      for (const entry of readdirSync(resolve(ROOT, d))) {
        if (entry === 'node_modules' || entry === 'ds-bundle' || entry.startsWith('.')) continue;
        const rel = join(d, entry);
        if (statSync(resolve(ROOT, rel)).isDirectory()) { walk(rel); continue; }
        if (!['.ts', '.tsx', '.css', '.js', '.jsx', '.json', '.md', '.sql'].includes(extname(entry))) continue;
        out.push(rel);
      }
    };
    walk(dir);
    return out;
  }

  /** This file, which has to name the banned string in order to ban it. */
  const SELF = join('app', 'contact', 'contact-page.test.tsx');

  it('appears in no source file under app/ lib/ components/ supabase/', () => {
    // Scanned INCLUDING other tests: unlike the phone number, no file has a
    // reason to name the old address, so the ban is otherwise absolute.
    const files = [
      ...sourceFiles('app'), ...sourceFiles('lib'),
      ...sourceFiles('components'), ...sourceFiles('supabase'),
    ].filter((f) => f !== SELF);
    const hits = files.filter((f) => /unit\s*35/i.test(read(f)));
    expect(hits).toEqual([]);
  });

  it('the self-exclusion still points at this file', () => {
    // If this file is renamed the exclusion goes stale and would silently
    // start flagging itself.
    expect(existsSync(resolve(ROOT, SELF))).toBe(true);
  });
});

// ─── The phone number still has exactly one home ──────────────────────

describe('/contact — the phone number has exactly ONE source location', () => {
  const VARIANTS = [
    '084 232 4201', '0842324201', '084-232-4201', '084.232.4201',
    '+27842324201', '+27 84 232 4201', '+27 (84) 232 4201', '27842324201',
  ];

  function sourceFiles(dir: string): string[] {
    const out: string[] = [];
    const walk = (d: string) => {
      for (const entry of readdirSync(resolve(ROOT, d))) {
        if (entry === 'node_modules' || entry === 'ds-bundle' || entry.startsWith('.')) continue;
        const rel = join(d, entry);
        if (statSync(resolve(ROOT, rel)).isDirectory()) { walk(rel); continue; }
        if (!['.ts', '.tsx', '.css', '.js', '.jsx', '.json', '.md'].includes(extname(entry))) continue;
        if (/\.test\.(ts|tsx)$/.test(entry)) continue;   // see header note
        out.push(rel);
      }
    };
    walk(dir);
    return out;
  }

  it('appears in lib/config/contact.ts and NOWHERE else', () => {
    const files = [...sourceFiles('app'), ...sourceFiles('lib'), ...sourceFiles('components')];
    const hits = files.filter((f) => {
      const text = read(f);
      return VARIANTS.some((v) => text.includes(v));
    });
    expect(hits).toEqual([['lib', 'config', 'contact.ts'].join(sep)]);
  });

  it('the page renders it from the config, never typed inline', () => {
    for (const v of VARIANTS) expect(BODY).not.toContain(v);
    expect(BODY).toMatch(/PHONE_DISPLAY/);
    expect(BODY).toMatch(/PHONE_TEL/);
  });

  it('the number is not propagated into page metadata', () => {
    for (const v of VARIANTS) expect(PAGE).not.toContain(v);
  });
});

// ─── Route wiring ─────────────────────────────────────────────────────

describe('/contact route wiring', () => {
  it('page.tsx exports metadata and renders the ContactPage component', () => {
    expect(PAGE).toMatch(/export const metadata/);
    expect(PAGE).toMatch(/<ContactPage\s*\/>/);
  });

  it('is publicly reachable — no auth gate, no redirect, no data fetch', () => {
    expect(PAGE).not.toMatch(/getUser|redirect\(|createClient/);
    expect(BODY).not.toMatch(/getUser|redirect\(|createClient/);
    expect(BODY).not.toMatch(/requireConfirmedUser|getRequestUser/);
    // The ACTION is public too — no auth check, by design.
    expect(ACTION).not.toMatch(/requireConfirmedUser|getRequestUser/);
  });

  it('uses the marketing chrome, not the authenticated app shell', () => {
    expect(BODY).toMatch(/SiteHeader/);
    expect(BODY).toMatch(/SiteFooter/);
    expect(BODY).toMatch(/landing\.css/);
    expect(BODY).toMatch(/lp-root/);
    expect(BODY).not.toMatch(/PatientScreen|PracticeScreen/);
  });

  it('the PAGE stays a server component — the form is the only client boundary', () => {
    expect(BODY_RAW).not.toMatch(/^'use client'/m);
    expect(BODY).not.toMatch(/useState|useEffect/);
    expect(FORM).toMatch(/^'use client'/m);
  });

  it('the footer still links here', () => {
    expect(FOOTER).toMatch(/<Link href="\/contact">Contact us<\/Link>/);
  });
});

// ─── Two columns ──────────────────────────────────────────────────────

describe('/contact is a TWO-COLUMN layout', () => {
  it('the markup has a details column and a form column inside one grid', () => {
    expect(BODY).toMatch(/lp-contact-grid/);
    expect(BODY).toMatch(/lp-contact-intro-col/);
    expect(BODY).toMatch(/lp-contact-form-col/);
  });

  it('the grid really is two columns, and collapses on a narrow viewport', () => {
    const grid = CSS.slice(CSS.indexOf('.lp-contact-grid'));
    expect(grid).toMatch(/grid-template-columns:\s*minmax\([^)]*\)\s+minmax\([^)]*\)/);
    // Stacks rather than squeezing on a phone.
    expect(CSS).toMatch(/@media \(max-width: 900px\)[\s\S]*?grid-template-columns:\s*1fr/);
  });

  it('renders both columns, details BEFORE the form in source order', () => {
    // Source order is what decides the stacked order on a phone, where the
    // tappable number should come before a form the visitor may not want.
    const details = BODY.indexOf('lp-contact-intro-col');
    const form    = BODY.indexOf('lp-contact-form-col');
    expect(details).toBeGreaterThan(-1);
    expect(form).toBeGreaterThan(details);
  });

  it('both halves are actually on the page when rendered', () => {
    const { container } = render(<ContactPage />);
    expect(container.querySelector('.lp-contact-intro-col')).toBeTruthy();
    expect(container.querySelector('.lp-contact-form-col')).toBeTruthy();
    expect(screen.getByTestId('contact-form')).toBeTruthy();
  });
});

// ─── Renders unauthenticated ──────────────────────────────────────────

describe('/contact renders unauthenticated', () => {
  // No auth mocking of any kind is set up for a session. That absence IS
  // the test: the page renders with no session and no request context.
  it('renders a Contact us heading', () => {
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
    expect(text.split(PUBLISHED.hours).length - 1).toBe(1);
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

  it('renders the address, line by line, with no unit number', () => {
    const { container } = render(<ContactPage />);
    const text = container.textContent ?? '';
    for (const line of ADDRESS_LINES) expect(text).toContain(line);
    expect(text).toContain('19 Cross Road');
    expect(text).not.toMatch(/unit\s*35/i);
    expect(container.querySelector('address')).toBeTruthy();
  });
});

// ─── What was deliberately REMOVED stays removed ──────────────────────

describe('/contact carries no entity or registration details', () => {
  // They live in the T&Cs (1.11) and the Privacy Policy (12.1), which is
  // where a reviewer or regulator looks. A second copy on a contact page is
  // non-standard, reads as boilerplate, and is another thing to keep in step
  // with the legal documents.
  it('the WHO WE ARE card is gone from the markup', () => {
    expect(BODY).not.toMatch(/Who we are/i);
    expect(BODY).not.toMatch(/contact-who/);
    expect(BODY).not.toMatch(/lp-contact-entity|lp-contact-tradename/);
  });

  it('imports neither LEGAL_ENTITY nor REGISTRATION_NUMBER', () => {
    // The constants still exist for the legal pages' benefit; this page must
    // not pull them in.
    const imports = BODY.slice(0, BODY.indexOf('export default'));
    expect(imports).not.toMatch(/LEGAL_ENTITY/);
    expect(imports).not.toMatch(/REGISTRATION_NUMBER/);
  });

  it('renders no registered name and no registration number', () => {
    const { container } = render(<ContactPage />);
    const text = container.textContent ?? '';
    expect(text).not.toMatch(/\(PTY\)\s*LTD/i);
    expect(text).not.toMatch(/registration number/i);
    // The registration-number shape itself: NNNN/NNNNNN/NN.
    expect(text).not.toMatch(/\d{4}\/\d{6}\/\d{2}/);
    expect(text).not.toMatch(/registered name/i);
  });

  it('the metadata does not carry them either', () => {
    expect(PAGE).not.toMatch(/LEGAL_ENTITY|REGISTRATION_NUMBER/);
    expect(PAGE).not.toMatch(/\(PTY\)\s*LTD/i);
  });
});

describe('/contact carries no filler copy', () => {
  it('the Terms / Privacy line is gone', () => {
    expect(BODY).not.toMatch(/Looking for our/i);
    const { container } = render(<ContactPage />);
    const text = container.textContent ?? '';
    // The FOOTER still links them — that is the right place, and it is on
    // this page already. What must be gone is the in-body repetition.
    expect(text).not.toMatch(/Looking for our/i);
  });

  it('the self-explaining intro is gone', () => {
    const { container } = render(<ContactPage />);
    const text = container.textContent ?? '';
    expect(text).not.toMatch(/in one place/i);
    expect(text).not.toMatch(/the same team answers/i);
    expect(text).not.toMatch(/reach us any way below/i);
  });

  it('one short warm line stands in its place', () => {
    render(<ContactPage />);
    const lede = document.querySelector('.lp-contact-lede');
    expect(lede).toBeTruthy();
    const words = (lede!.textContent ?? '').trim().split(/\s+/).length;
    // Short enough to read at a glance; long enough to be a sentence.
    expect(words).toBeGreaterThan(4);
    expect(words).toBeLessThan(40);
  });
});

// ─── Still not a support experience ───────────────────────────────────

describe('/contact is an enquiry form, not a support system', () => {
  it('has no chat, ticketing or FAQ copy', () => {
    const strip = (s: string) =>
      s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').toLowerCase();
    for (const src of [strip(BODY), strip(FORM)]) {
      for (const banned of [
        'faq', 'frequently asked', 'knowledge base', 'help centre',
        'help center', 'ticket', 'live chat', 'whatsapp',
      ]) {
        expect(src).not.toContain(banned);
      }
    }
  });

  it('renders exactly ONE form, and it is the enquiry form', () => {
    const { container } = render(<ContactPage />);
    expect(container.querySelectorAll('form')).toHaveLength(1);
    expect(screen.getByTestId('contact-form')).toBeTruthy();
  });
});
