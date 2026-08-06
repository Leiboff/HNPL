import { redirect } from 'next/navigation';
import { CARDS_SURFACE } from '@/lib/patient/cardReturn';

// ─── /patient/payment-methods — folded into Account (v4) ─────────────────
//
// Card management now lives in ONE place: the Account tab's "How you pay"
// section. This route is an INERT server-side redirect to the canonical
// surface — no card UI, no data fetch, no client component, so there is no
// flash of an old surface before the redirect. The shared card server
// actions live in ./actions (imported by the Account surface), NOT here,
// so deleting this redirect can never take a money-path action with it.

export default async function PaymentMethodsPage() {
  redirect(CARDS_SURFACE);
}
