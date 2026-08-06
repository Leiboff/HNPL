import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── Desktop layout — PatientScreen content column ──────────────────────
//
// The whole patient portal renders through PatientScreen, so its wrapper
// governs the content width on every screen. The desktop bug was a fixed
// max-w-md (phone) column leaving a dead void beside the sidebar. The fix:
// keep the phone column on mobile, widen to a comfortable CENTRED column on
// desktop, capped so ultra-wide doesn't sprawl. These pins lock that shape
// and guarantee mobile is untouched.

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8').replace(/\r\n/g, '\n');
const SCREEN = read('app/patient/PatientScreen.tsx');
const LAYOUT = read('app/patient/layout.tsx');

/** The single content-column wrapper class string. */
function wrapperClasses(): string {
  const m = SCREEN.match(/className="(mx-auto[^"]*)"/);
  if (!m) throw new Error('PatientScreen content-column wrapper not found');
  return m[1];
}

describe('PatientScreen — responsive content column', () => {
  const cls = wrapperClasses();

  it('keeps the phone column on mobile (max-w-md, unchanged)', () => {
    // Base (unprefixed) max-w-md governs < md — i.e. mobile is exactly as
    // before. A prefixed md:/lg: cap must NOT replace the base value.
    expect(cls).toMatch(/(^|\s)max-w-md(\s|$)/);
  });

  it('is horizontally centred (no left-pin, symmetric margins)', () => {
    expect(cls).toContain('mx-auto');
    expect(cls).toContain('w-full');
  });

  it('widens on desktop to a comfortable column', () => {
    expect(cls).toMatch(/md:max-w-\w+/);
    expect(cls).toMatch(/lg:max-w-\w+/);
  });

  it('caps the desktop width so ultra-wide screens do not sprawl', () => {
    // The largest step is a bounded Tailwind token (…xl), never max-w-full
    // / max-w-none / w-screen.
    expect(cls).toMatch(/lg:max-w-(2xl|3xl|4xl|5xl|6xl|7xl)/);
    expect(cls).not.toMatch(/max-w-(full|none|screen)/);
    expect(cls).not.toContain('lg:w-screen');
  });
});

describe('patient layout shell — content fills the space beside the sidebar', () => {
  it('main is flex-1 min-w-0 (takes the remaining width; the column centres within it)', () => {
    expect(LAYOUT).toMatch(/<main[^>]*className="[^"]*flex-1[^"]*min-w-0/);
  });

  it('the sidebar is desktop-only so mobile layout is unaffected', () => {
    // PatientNav owns the md+ sidebar; the bottom nav owns mobile. This pin
    // documents that the width change lives beside a desktop-only sidebar.
    expect(LAYOUT).toContain('<PatientNav');
    expect(LAYOUT).toContain('<PatientBottomNav');
  });
});
