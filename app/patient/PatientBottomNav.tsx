'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

// ─── PatientBottomNav — v4 four-tab floating nav (mobile) ────────────────
//
// Home · Plans · Find care · Account. The old five-tab bar (Home / Orders
// / Explore / Cards / Profile) collapsed in v4: Orders became Plans, Cards
// folded into Account, and the standalone /patient/payment-methods and
// /patient/profile routes now redirect into /patient/account.

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

const LINKS = [
  { href: '/patient',         label: 'Home',      Icon: HomeIcon     },
  { href: '/patient/orders',  label: 'Plans',     Icon: PlansIcon    },
  { href: '/patient/explore', label: 'Find care', Icon: FindCareIcon },
  { href: '/patient/account', label: 'Account',   Icon: AccountIcon  },
];

export default function PatientBottomNav() {
  const pathname = usePathname();

  function isActive(href: string) {
    return href === '/patient' ? pathname === '/patient' : pathname.startsWith(href);
  }

  return (
    <div
      className="fixed bottom-0 inset-x-0 z-30 md:hidden px-[14px]"
      style={{ paddingBottom: 'max(18px, env(safe-area-inset-bottom))' }}
    >
      <nav
        className="mx-auto flex h-[68px] max-w-md rounded-[20px] overflow-hidden"
        style={{
          background: '#ffffff',
          border: '1px solid rgba(19,41,75,0.07)',
          boxShadow: '0 10px 28px -10px rgba(11,31,58,0.22)',
        }}
      >
        {LINKS.map(({ href, label, Icon }) => {
          const active = isActive(href);
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
              <Icon active={active} />
              <span
                className="text-[10.5px] leading-none font-semibold"
                style={{ color: active ? '#13294B' : '#94A3B8', transition: 'color 0.15s' }}
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
