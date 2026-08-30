import { redirect } from 'next/navigation';

type Props = {
  searchParams: Promise<{ token?: string }>;
};

// ─── /signup/patient — retired, now a redirect ─────────────────────────
//
// The account-creation form used to live here, on its own route, while
// /signup was a separate chooser screen. That split is gone: /signup now
// holds both, as a chooser and a form view on one route, exactly the way
// /login holds its chooser and its email screen. One canonical URL for
// "create an account".
//
// This route survives only to catch traffic already pointing at it —
// links in emails we have sent, bookmarks, anything indexed — so nothing
// that worked yesterday 404s today.
//
// The ?token= branch is UNCHANGED and is the reason this file still
// awaits searchParams: a stale provider-invitation link must keep
// landing on /checkout/[token], which is the single invite-acceptance
// path. Only the no-token case is new.
//
// The form itself did not move house — it is still
// app/signup/patient/PatientSignupForm.tsx, imported by /signup. Keeping
// it there keeps it beside the server action it calls (actions.ts) and
// avoids a rename that ~9 source-text suites read by path. Worth
// revisiting as its own change; not worth bundling into a routing fix.

export default async function PatientSignupPage({ searchParams }: Props) {
  const { token } = await searchParams;

  if (token) {
    redirect(`/checkout/${encodeURIComponent(token)}`);
  }

  redirect('/signup');
}
