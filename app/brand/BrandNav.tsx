'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { getBrandNavLinks, isBrandNavActive } from './brandNavLinks';

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
      className="border-b border-gray-200 bg-white"
    >
      <div className="mx-auto max-w-5xl px-4 sm:px-6">
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
                className={[
                  'whitespace-nowrap px-3 py-3 text-sm font-medium border-b-2 -mb-px transition-colors',
                  active
                    ? 'border-[#13294B] text-[#13294B]'
                    : 'border-transparent text-gray-500 hover:text-gray-900',
                ].join(' ')}
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
