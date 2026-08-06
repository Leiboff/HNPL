import { redirect } from 'next/navigation';

// ─── /patient/profile — folded into Account (consolidated) ───────────────
//
// Account and Profile are now ONE surface: the Account tab. This route is an
// INERT server-side redirect to the canonical page — no UI, no data fetch,
// no client component, so there is no flash of an old surface before the
// redirect and no 404. The profile editors (phone, salary date,
// notifications, security) live on /patient/account; the server actions
// that back them moved there too. Same pattern as the payment-methods
// redirect that folded card management into Account.

export default async function ProfilePage() {
  redirect('/patient/account');
}
