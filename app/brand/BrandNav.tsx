'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { getBrandNavLinks, isBrandNavActive } from './brandNavLinks';
import { brand } from './brandTheme';

// ─── Brand nav — Overview · Practices · Reports · Settings ─────────────────
//
// ONE component for every width. The practice side runs a desktop sidebar and
// a separate mobile menu because they grew that way; brand starts clean, so a
// horizontally-scrolling tab strip serves both and there is no second surface
// that could fall out of step. See ./brandNavLinks for why that is the stronger
// version of the parity guard rather than a shortcut around it.
//
// Every href comes from getBrandNavLinks(). Nothing is spliced in here, and the
// active-tab rule is the shared isBrandNavActive — not a startsWith written out
// locally, which would light Overview on all four tabs since /brand prefixes
// every brand route.

export default function BrandNav() {
  const pathname = usePathname();
  const links = getBrandNavLinks();

  return (
    <nav
      aria-label="Brand"
      data-testid="brand-nav"
      className="bg-white border-b"
      style={{ borderColor: brand.line }}
    >
      <div className="mx-auto max-w-3xl px-4 sm:px-6 py-2.5">
        {/* Scrolls rather than wraps: four tabs fit a phone, but a fifth
            must push sideways instead of silently forming a second row that
            reads as two separate navs. */}
        <div className="flex gap-1 overflow-x-auto">
          {links.map(({ href, label }) => {
            const active = isBrandNavActive(href, pathname);
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? 'page' : undefined}
                data-testid={`brand-nav-${label.toLowerCase()}`}
                className="whitespace-nowrap px-3.5 py-2 text-sm rounded-full transition-colors"
                style={{
                  background: active ? brand.mint : 'transparent',
                  color: active ? brand.ink : brand.muted,
                  fontWeight: active ? 600 : 500,
                }}
              >
                {label}
              </Link>
            );
          })}
        </div>
      </div>
    </nav>
  );
}
