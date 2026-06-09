'use client';

import Link from 'next/link';
import { useState } from 'react';
import { usePathname } from 'next/navigation';
import SettingsSheet from './SettingsSheet';

type Props = {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
};

function HomeIcon({ active }: { active: boolean }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={active ? 2.25 : 1.75} strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <polyline points="9 22 9 12 15 12 15 22" />
    </svg>
  );
}

function OrdersIcon({ active }: { active: boolean }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={active ? 2.25 : 1.75} strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2" />
      <rect x="9" y="3" width="6" height="4" rx="1" />
      <path d="M9 12h6M9 16h4" />
    </svg>
  );
}

function CardIcon({ active }: { active: boolean }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={active ? 2.25 : 1.75} strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="5" width="20" height="14" rx="2" />
      <path d="M2 10h20" />
    </svg>
  );
}

function ProfileIcon({ active }: { active: boolean }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={active ? 2.25 : 1.75} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="8" r="4" />
      <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7" />
    </svg>
  );
}

const LINKS = [
  { href: '/patient',                 label: 'Home',   Icon: HomeIcon   },
  { href: '/patient/orders',          label: 'Orders', Icon: OrdersIcon },
  { href: '/patient/payment-methods', label: 'Cards',  Icon: CardIcon   },
];

export default function PatientBottomNav({ firstName, lastName, email, phone }: Props) {
  const pathname = usePathname();
  const [sheetOpen, setSheetOpen] = useState(false);

  function isActive(href: string) {
    return href === '/patient' ? pathname === '/patient' : pathname.startsWith(href);
  }

  const profileActive = pathname.startsWith('/patient/profile');

  return (
    <>
      {/* Settings sheet — controlled by the Profile tab */}
      <SettingsSheet
        firstName={firstName}
        lastName={lastName}
        email={email}
        phone={phone}
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
      />

      {/* Floating bottom nav — mobile only */}
      <div
        className="fixed bottom-0 inset-x-0 z-30 md:hidden px-4"
        style={{ paddingBottom: 'max(14px, env(safe-area-inset-bottom))' }}
      >
        <nav
          className="flex h-[62px] rounded-2xl overflow-hidden"
          style={{
            background: 'rgba(255,255,255,0.92)',
            backdropFilter: 'blur(20px)',
            WebkitBackdropFilter: 'blur(20px)',
            border: '1px solid rgba(19,41,75,0.10)',
            boxShadow: '0 8px 32px -6px rgba(19,41,75,0.18), 0 2px 8px -2px rgba(19,41,75,0.08)',
          }}
        >
          {LINKS.map(({ href, label, Icon }) => {
            const active = isActive(href);
            return (
              <Link
                key={href}
                href={href}
                className="flex-1 flex flex-col items-center justify-center gap-[4px]"
                style={{ color: active ? '#15A89E' : '#94a3b8', transition: 'color 0.15s' }}
              >
                <Icon active={active} />
                <span
                  className="text-[10px] leading-none font-semibold"
                  style={{ color: active ? '#13294B' : '#94a3b8', transition: 'color 0.15s' }}
                >
                  {label}
                </span>
              </Link>
            );
          })}

          {/* Profile tab — opens settings sheet */}
          <button
            type="button"
            onClick={() => setSheetOpen(true)}
            className="flex-1 flex flex-col items-center justify-center gap-[4px]"
            style={{ color: profileActive ? '#15A89E' : '#94a3b8', transition: 'color 0.15s' }}
          >
            <ProfileIcon active={profileActive} />
            <span
              className="text-[10px] leading-none font-semibold"
              style={{ color: profileActive ? '#13294B' : '#94a3b8', transition: 'color 0.15s' }}
            >
              Profile
            </span>
          </button>
        </nav>
      </div>
    </>
  );
}
