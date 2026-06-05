'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/client';

interface Props {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
}

function GearIcon() {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function UserIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  );
}

function ChevronRightIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M9 18l6-6-6-6" />
    </svg>
  );
}

function LogOutIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" y1="12" x2="9" y2="12" />
    </svg>
  );
}

export default function SettingsSheet({ firstName, lastName, email, phone }: Props) {
  const [open, setOpen] = useState(false);

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') close();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, close]);

  // Prevent body scroll when sheet is open
  useEffect(() => {
    document.body.style.overflow = open ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
  }, [open]);

  async function handleSignOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    window.location.href = '/login';
  }

  const fullName = [firstName, lastName].filter(Boolean).join(' ');

  return (
    <>
      {/* Gear trigger */}
      <button
        onClick={() => setOpen(true)}
        aria-label="Settings"
        className="flex items-center justify-center w-9 h-9 rounded-full text-white/80 hover:text-white hover:bg-white/10 transition-colors"
      >
        <GearIcon />
      </button>

      {/* Overlay */}
      {open && (
        <div className="fixed inset-0 z-50 flex items-end md:items-center justify-center">
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/40 backdrop-blur-[2px]"
            onClick={close}
            aria-hidden
          />

          {/* Sheet / Modal card */}
          <div
            className="
              relative w-full md:max-w-sm
              bg-white
              rounded-t-2xl md:rounded-2xl
              shadow-2xl
              max-h-[90dvh] overflow-y-auto
              flex flex-col
            "
            role="dialog"
            aria-modal="true"
            aria-label="Settings"
          >
            {/* Drag handle (mobile only) */}
            <div className="flex justify-center pt-3 pb-1 md:hidden">
              <div className="w-10 h-1 rounded-full bg-gray-200" />
            </div>

            {/* Header */}
            <div className="flex items-center justify-between px-6 pt-4 pb-3 md:pt-6">
              <div>
                <h2 className="text-lg font-semibold text-gray-900">Settings</h2>
                <p className="text-xs text-gray-400 mt-0.5">Manage your account</p>
              </div>
              <button
                onClick={close}
                className="text-sm font-medium text-gray-500 hover:text-gray-700 transition-colors"
              >
                Close
              </button>
            </div>

            <div className="px-6 pb-6 space-y-4">
              {/* Identity card */}
              <div className="bg-gray-50 rounded-xl p-4 flex gap-3">
                <div
                  className="flex-shrink-0 w-9 h-9 rounded-full flex items-center justify-center"
                  style={{ backgroundColor: '#0F4C75' }}
                >
                  <span className="text-white">
                    <UserIcon />
                  </span>
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-gray-900 truncate">{fullName || '—'}</p>
                  {email && (
                    <p className="text-xs text-gray-500 truncate mt-0.5">{email}</p>
                  )}
                  {phone && (
                    <p className="text-xs text-gray-500 truncate mt-0.5">{phone}</p>
                  )}
                </div>
              </div>

              {/* Profile & address link */}
              <Link
                href="/patient/profile"
                onClick={close}
                className="flex items-center justify-between w-full bg-gray-50 rounded-xl px-4 py-3.5 hover:bg-gray-100 transition-colors group"
              >
                <div>
                  <p className="text-sm font-medium text-gray-900">Profile &amp; address</p>
                  <p className="text-xs text-gray-400 mt-0.5">Update your contact details</p>
                </div>
                <span className="text-gray-400 group-hover:text-gray-600 transition-colors">
                  <ChevronRightIcon />
                </span>
              </Link>

              {/* Divider */}
              <div className="border-t border-gray-100" />

              {/* Sign out */}
              <button
                onClick={handleSignOut}
                className="flex items-center gap-3 w-full px-4 py-3 rounded-xl text-red-600 hover:bg-red-50 transition-colors"
              >
                <LogOutIcon />
                <span className="text-sm font-medium">Sign out</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
