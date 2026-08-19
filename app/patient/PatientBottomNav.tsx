'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

// ─── PatientBottomNav — five-tab solid nav (mobile) ──────────────────────
//
// Home · Plans · Scan · Find care · Account. The old five-tab bar (Home /
// Orders / Explore / Cards / Profile) collapsed in v4 to Home / Plans / Find
// care / Account: Orders became Plans, Cards folded into Account, and the
// standalone /patient/payment-methods and /patient/profile routes now
// redirect into /patient/account. Scan was added back as a fifth tab,
// centred like the scan button on Payflex's bar, so a patient can point
// their camera at a practice's checkout QR without leaving the app. The bar
// itself moved from a floating rounded pill to a solid rectangle that fills
// the full width and the safe-area inset, matching that same reference.

function HomeIcon({ active }: { active: boolean }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={active ? 2.25 : 1.75} strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}

function PlansIcon({ active }: { active: boolean }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={active ? 2.25 : 1.75} strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="3" width="16" height="18" rx="3" />
      <path d="M8 9h8M8 13h8M8 17h4" />
    </svg>
  );
}

function FindCareIcon({ active }: { active: boolean }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={active ? 2.25 : 1.75} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.35-4.35" />
    </svg>
  );
}

function AccountIcon({ active }: { active: boolean }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={active ? 2.25 : 1.75} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="8" r="4" />
      <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7" />
    </svg>
  );
}

/** Viewfinder-corners glyph for the centre Scan tab. Always shown at full
    weight against its teal badge, so it ignores `active` like the others
    take it — kept for a uniform Icon signature across LINKS. */
function ScanIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.25} strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 8V5a1 1 0 0 1 1-1h3" />
      <path d="M16 4h3a1 1 0 0 1 1 1v3" />
      <path d="M20 16v3a1 1 0 0 1-1 1h-3" />
      <path d="M8 20H5a1 1 0 0 1-1-1v-3" />
      <rect x="9" y="9" width="6" height="6" rx="1" />
    </svg>
  );
}

const LINKS = [
  { href: '/patient',         label: 'Home',      Icon: HomeIcon     },
  { href: '/patient/orders',  label: 'Plans',     Icon: PlansIcon    },
  { href: '/patient/scan',    label: 'Scan',      Icon: ScanIcon     },
  { href: '/patient/explore', label: 'Find care', Icon: FindCareIcon },
  { href: '/patient/account', label: 'Account',   Icon: AccountIcon  },
];

export default function PatientBottomNav() {
  const pathname = usePathname();

  function isActive(href: string) {
    return href === '/patient' ? pathname === '/patient' : pathname.startsWith(href);
  }

  return (
    // Solid rectangle, full-bleed — the background carries through the
    // safe-area inset too, so there's no transparent gap below the bar on
    // devices with a home indicator (that's what makes it read as one solid
    // block rather than a floating pill).
    <div
      className="fixed bottom-0 inset-x-0 z-30 md:hidden"
      style={{
        background: '#ffffff',
        borderTop: '1px solid rgba(19,41,75,0.08)',
        boxShadow: '0 -2px 10px -4px rgba(11,31,58,0.15)',
        paddingBottom: 'env(safe-area-inset-bottom)',
      }}
    >
      <nav className="flex h-[68px] w-full">
        {LINKS.map(({ href, label, Icon }) => {
          const active = isActive(href);
          const isScan = href === '/patient/scan';
          return (
            <Link
              key={href}
              href={href}
              // Full-cell tap target: flex-1 for width, h-full to fill the
              // 68px bar height explicitly (not relying on implicit stretch),
              // min-h-[44px] as a floor. Icon + label + padding are all one
              // hit area.
              className="flex-1 flex flex-col items-center justify-center gap-[5px] h-full min-h-[44px]"
              style={{ color: active ? '#15A89E' : '#94A3B8', transition: 'color 0.15s' }}
            >
              {isScan ? (
                // Centre tab is a raised circular button, Payflex-style —
                // it pops above the bar instead of sitting flush with the
                // other four icons.
                <div
                  aria-hidden
                  className="flex items-center justify-center rounded-full"
                  style={{
                    width: 46,
                    height: 46,
                    marginTop: -20,
                    background: '#15A89E',
                    color: '#ffffff',
                    boxShadow: '0 6px 16px -4px rgba(11,31,58,0.45)',
                    border: '3px solid #ffffff',
                  }}
                >
                  <Icon active={active} />
                </div>
              ) : (
                <Icon active={active} />
              )}
              <span
                className="text-[10.5px] leading-none font-semibold"
                style={{ color: isScan ? '#13294B' : active ? '#13294B' : '#94A3B8', transition: 'color 0.15s' }}
              >
                {label}
              </span>
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
