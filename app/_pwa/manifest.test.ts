import { describe, it, expect } from 'vitest';
import manifest from '@/app/manifest';

// ─── Manifest validity + icon set ────────────────────────────────────────
//
// The manifest is one mis-key away from making the app non-installable.
// These tests pin the load-bearing properties — what every browser
// install picker reads when deciding whether the PWA is real and what
// to show during install.

describe('Web App Manifest', () => {
  const m = manifest();

  it('declares the four installability essentials', () => {
    expect(m.name).toBe('BetterNow — pay later for healthcare');
    expect(m.short_name).toBe('BetterNow');
    expect(m.start_url).toBe('/patient');
    expect(m.display).toBe('standalone');
  });

  it('declares brand-coded theme + background colours', () => {
    // Navy reads as trustworthy / medical-adjacent and matches our
    // status-bar overlay. Background is the page surface so the splash
    // before React mounts doesn't flash a wrong colour.
    expect(m.theme_color).toBe('#13294B');
    expect(m.background_color).toBe('#FAFBFD');
  });

  it('is portrait + scoped to root + en-ZA locale', () => {
    expect(m.orientation).toBe('portrait');
    expect(m.scope).toBe('/');
    expect(m.lang).toBe('en-ZA');
  });

  it('ships ALL three required icons (192 any, 512 any, 512 maskable)', () => {
    const icons = m.icons ?? [];
    expect(icons.length).toBeGreaterThanOrEqual(3);

    const find = (sizes: string, purpose?: string) =>
      icons.find((i) => {
        const sizeMatch = (i as { sizes?: string }).sizes === sizes;
        const purposeMatch = purpose ? (i as { purpose?: string }).purpose === purpose : true;
        return sizeMatch && purposeMatch;
      });

    // 192 — Android home screen / manifest minimum.
    expect(find('192x192')).toBeDefined();
    // 512 — Android splash + high-DPI installs.
    expect(find('512x512')).toBeDefined();
    // 512 maskable — Android adaptive icons. Without this, the OS
    // may render our icon with white halos inside its squircle.
    expect(find('512x512', 'maskable')).toBeDefined();
  });

  it('icon srcs are stable bare paths (not query-hashed)', () => {
    // The manifest icons must be cacheable by a service worker and
    // referenced verbatim. A query-hashed URL would mean the SW
    // can't match it on second-deploy precaching.
    for (const i of m.icons ?? []) {
      const src = (i as { src: string }).src;
      expect(src).toMatch(/^\/icon-[\w-]+\.png$/);
      expect(src).not.toContain('?');
    }
  });
});
