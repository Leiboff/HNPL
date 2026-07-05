'use client';

import { logoutAndRedirect } from '@/lib/auth/logout';

export default function LogoutButton() {
  return (
    <button
      onClick={() => logoutAndRedirect()}
      className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
    >
      Log out
    </button>
  );
}
