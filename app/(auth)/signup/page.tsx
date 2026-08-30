import type { Metadata } from 'next';
import SignupEntry from './SignupEntry';

// ─── /signup — auth entry screen ───────────────────────────────────────
//
// Was `redirect('/')`, which dead-ended anyone who typed /signup or
// followed a "sign up" link that didn't already know about
// /signup/patient. It now renders the entry screen: brand, the promise,
// and every way in (email / Google / passkey) as one stack.
//
// Deliberately NOT an async server component — it has nothing to await,
// and staying synchronous keeps it out of the loading.tsx coverage
// requirement for server-rendered pages (app/loading-coverage.test.tsx).
// All the interactive work lives in the client child.

export const metadata: Metadata = {
  title: 'Sign up · betternow',
  description:
    'Create a betternow account and split any medical bill into 2 or 3 interest-free instalments, timed around your payday.',
};

export default function SignupPage() {
  return <SignupEntry />;
}
