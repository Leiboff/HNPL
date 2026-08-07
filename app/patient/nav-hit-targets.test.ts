import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── Primary-nav hit targets ─────────────────────────────────────────────
//
// Both nav items must be ONE reliable click/tap target across the whole
// visible item (icon + label + padding), not just the icon/text node. These
// pins lock the explicit full-item anchors so a future refactor can't shrink
// the hit area back to content-size, and confirm ≥44px on mobile.

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8').replace(/\r\n/g, '\n');
const BOTTOM = read('app/patient/PatientBottomNav.tsx');
const SIDE   = read('app/patient/PatientNav.tsx');

/** The className string of the item <Link> in a nav file. */
function itemLinkClasses(src: string): string {
  // The item Link is the one carrying flex-1 (bottom) or the nav row (side).
  const m = src.match(/href=\{href\}[\s\S]*?className=(?:"([^"]*)"|\{\[\s*'([^']*)')/);
  if (!m) throw new Error('item Link className not found');
  return m[1] ?? m[2] ?? '';
}

describe('mobile bottom nav — full-cell tap target ≥44px', () => {
  const cls = itemLinkClasses(BOTTOM);
  it('the item anchor fills the cell (flex-1 for width, explicit height)', () => {
    expect(cls).toContain('flex-1');
    expect(cls).toContain('h-full');
  });
  it('guarantees a ≥44px target (min-h floor + the 68px bar)', () => {
    expect(cls).toContain('min-h-[44px]');
    expect(BOTTOM).toContain('h-[68px]');
  });
  it('destinations untouched (four routes still present)', () => {
    for (const href of ['/patient', '/patient/orders', '/patient/explore', '/patient/account']) {
      expect(BOTTOM).toContain(`'${href}'`);
    }
  });
});

describe('desktop sidebar — full-row click target ≥44px', () => {
  const cls = itemLinkClasses(SIDE);
  it('the item anchor is an explicit full-width box (not implicit stretch)', () => {
    expect(cls).toContain('flex');
    expect(cls).toContain('items-center');
    expect(cls).toContain('w-full');
  });
  it('guarantees a ≥44px row height', () => {
    expect(cls).toContain('min-h-[44px]');
  });
  it('destinations untouched (four routes still present)', () => {
    for (const href of ['/patient', '/patient/orders', '/patient/explore', '/patient/account']) {
      expect(SIDE).toContain(`'${href}'`);
    }
  });
});
