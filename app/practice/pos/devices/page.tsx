import { redirect } from 'next/navigation';
import { requireConfirmedUser } from '@/lib/auth/requireConfirmedUser';

// ─── /practice/pos/devices → /practice/settings#till ─────────────────────
//
// Till administration is a SECTION of /practice/settings now. This stays as
// a redirect rather than being deleted because inbound links still point
// here and none of them may 404:
//
//   • the setup checklist's till suggestion (lib/practice/setupChecklist.ts)
//   • the brand dashboard's per-branch "Till devices" link
//     (app/brand/GroupDashboard.tsx), scoped by that branch's id
//   • anything a practice has bookmarked
//
// Unlike the /practice/details stub, this one DOES name a fragment: nothing
// links here with a fragment of its own, so there is none to preserve, and
// landing on the section itself beats landing at the top of a page whose
// first two sections a plain manager cannot even see.
//
// requireConfirmedUser stays. This route has always required a normal login
// — it is the till ADMIN screen, not the device-credentialled kiosk
// (/practice/pos) or its anon-reachable registration screen
// (/practice/pos/register). app/practice/practice-routes-auth.test.ts pins
// that boundary at exactly those two, and a redirect is not a reason to
// widen it.
//
// The authorization decision has NOT moved to this file. It still belongs
// to listDevices()'s own guardTillManager, which the Settings page calls
// before rendering the section. This stub deliberately checks nothing
// beyond "is there a logged-in user": a stub that re-implemented the
// manager check would be a second, narrower gate, and a narrower duplicate
// gate here is exactly what made the brand-admin path 404 on this route
// once before.
//
// DeviceAdminView.tsx and actions.ts still live in this directory and are
// imported from here by the Settings page — their test suites address them
// at these paths.

type SearchParams = { practiceId?: string };

export default async function DevicesRedirect({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  await requireConfirmedUser({ next: '/practice/pos/devices' });

  // The scope must survive: the brand dashboard's link identifies WHICH
  // branch's tills are being administered, and dropping it would land a
  // brand-admin on their first membership instead.
  const suffix = params.practiceId
    ? `?practiceId=${encodeURIComponent(params.practiceId)}`
    : '';

  redirect(`/practice/settings${suffix}#till`);
}
