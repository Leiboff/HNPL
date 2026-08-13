import { redirect } from 'next/navigation';
import { requireConfirmedUser } from '@/lib/auth/requireConfirmedUser';

// ─── /practice/details → /practice/settings ──────────────────────────────
//
// Practice details and banking are SECTIONS of /practice/settings now, not
// a route of their own. This stays as a redirect rather than being deleted
// because several inbound links still point here and none of them may 404:
//
//   • the setup checklist's "Add your address" and "Add bank details" items
//     (lib/practice/setupChecklist.ts) — the banking one carries #banking
//   • the dashboard's trading-gate "Go to Banking →" panel link, which also
//     carries #banking
//   • revalidatePath('/practice/details') in app/brand/actions.ts
//   • anything a practice has bookmarked
//
// THE FRAGMENT SURVIVES WITHOUT BEING NAMED HERE. This redirect's Location
// deliberately carries NO fragment: when a redirect target has none, the
// browser re-applies the fragment from the original request, so
// /practice/details#banking lands on #banking — which the Settings page
// still renders as the id of its banking section. Naming a fragment here
// would OVERRIDE the caller's and break exactly that.
//
// requireConfirmedUser stays, even though nothing is read: dropping it
// would make this the third /practice/** route reachable without a login,
// and app/practice/practice-routes-auth.test.ts pins that boundary at two
// (the till kiosk and its registration screen). An anonymous visitor to a
// bookmarked settings URL should meet the login page, which is what
// happened before and what still happens.
//
// The two form COMPONENTS still live in this directory
// (BranchDetailsForm.tsx, BranchBankingForm.tsx) and are imported from
// here by the Settings page. They were not moved: their own test suites
// address them at these paths, and a file move would have meant editing
// tests for code that did not change.

type SearchParams = { practiceId?: string };

export default async function PracticeDetailsRedirect({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  await requireConfirmedUser({ next: '/practice/details' });

  // The scope must survive: a brand-admin with N≥2 branches arrives here
  // with ?practiceId= identifying which branch they meant, and dropping it
  // would silently land them on their first membership instead.
  const suffix = params.practiceId
    ? `?practiceId=${encodeURIComponent(params.practiceId)}`
    : '';

  redirect(`/practice/settings${suffix}`);
}
