import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { renderOnboardingNudge, nudgeSubject } from './onboardingNudge';

// The nudge email. Two things matter beyond it rendering: it must not read
// as an accusation, and its brand colours must match the tokens the app
// moved onto — email clients ignore CSS custom properties, so this is the
// one place brand hex is still stated literally and the only place a drift
// could hide.

const base = { to: 'p@example.com', firstName: 'Thandi', stepLabel: 'your income details' };

/**
 * Readable text as the recipient sees it: entities decoded and whitespace
 * collapsed. Asserting on raw template output instead means a test that
 * breaks when prose is re-wrapped, which teaches people to loosen the
 * assertion rather than read it.
 */
function readable(html: string): string {
  return html
    .replace(/&rsquo;/g, "'")
    .replace(/&mdash;/g, '—')
    .replace(/&rarr;/g, '→')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

describe('subjects', () => {
  it('names the remaining step on the first nudge', () => {
    expect(nudgeSubject({ ...base, nudgeNumber: 1 })).toContain('your income details');
  });

  it('changes on the final one, and neither says "incomplete" or "failed"', () => {
    const first = nudgeSubject({ ...base, nudgeNumber: 1 });
    const final = nudgeSubject({ ...base, nudgeNumber: 2 });
    expect(final).not.toBe(first);
    for (const s of [first, final]) {
      expect(s).not.toMatch(/fail|incomplete|abandon|expired|rejected/i);
    }
  });
});

describe('body', () => {
  it('greets by name when there is one, and still greets when there is not', () => {
    expect(readable(renderOnboardingNudge({ ...base, nudgeNumber: 1 }))).toContain('Hi Thandi,');
    expect(readable(renderOnboardingNudge({ ...base, firstName: null, nudgeNumber: 1 })))
      .toContain('Hi there,');
    // A blank-string name is the same case as no name — profiles.first_name
    // is created as '' by the 0023 trigger and only filled in later.
    expect(readable(renderOnboardingNudge({ ...base, firstName: '   ', nudgeNumber: 1 })))
      .toContain('Hi there,');
  });

  it('escapes the name — it is user-supplied and lands in HTML', () => {
    const html = renderOnboardingNudge({
      ...base, firstName: '<script>alert(1)</script>', nudgeNumber: 1,
    });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('says the final one is the last', () => {
    expect(readable(renderOnboardingNudge({ ...base, nudgeNumber: 2 }))).toMatch(/last reminder/i);
    expect(readable(renderOnboardingNudge({ ...base, nudgeNumber: 1 }))).not.toMatch(/last reminder/i);
  });

  it('reassures that nothing is lost — the top reason people do not resume', () => {
    expect(readable(renderOnboardingNudge({ ...base, nudgeNumber: 1 })))
      .toMatch(/nothing you'?ve entered is lost/i);
  });

  it('links through /login so a click with no session still works', () => {
    // They are being nudged precisely because they left, so the click very
    // often arrives cold. /onboarding would bounce them to /login anyway.
    const html = renderOnboardingNudge({ ...base, nudgeNumber: 1 });
    expect(html).toMatch(/\/login\?next=\/onboarding/);
  });

  it('says why they are receiving it', () => {
    expect(readable(renderOnboardingNudge({ ...base, nudgeNumber: 1 })))
      .toMatch(/because you started a BetterNow application/i);
  });
});

describe('brand colours match the tokens', () => {
  const globals = readFileSync('app/globals.css', 'utf8');
  const token = (name: string) =>
    globals.match(new RegExp(`--${name}:\\s*(#[0-9A-Fa-f]{6})\\s*;`))![1].toUpperCase();

  it('uses the same navy and teal as :root', () => {
    const html = renderOnboardingNudge({ ...base, nudgeNumber: 1 }).toUpperCase();
    expect(html).toContain(token('brand-navy'));
    expect(html).toContain(token('brand-teal'));
  });

  it('states them literally, and says why', () => {
    // Custom properties do not survive email clients. This is a real
    // exception to the token rule, so it has to be written down where the
    // next person will look.
    const src = readFileSync('lib/email/templates/onboardingNudge.ts', 'utf8');
    expect(src).toMatch(/Email clients do not support them/);
    expect(src).not.toMatch(/var\(--brand|var\(--portal/);
  });
});
