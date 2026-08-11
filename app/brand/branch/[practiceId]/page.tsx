import { redirect } from 'next/navigation';

// ─── /brand/branch/[practiceId] — pivot into the practice dashboard ────
//
// This route used to render a thinner, brand-side "branch view": a
// revenue rollup, a second Team roster, and the practice's details +
// banking cards. It was doing double duty — a multi-branch PERFORMANCE
// view AND the de-facto practice SETTINGS page (the sidebar "Practice
// details" link pointed here) — and it was wrong for a single practice
// either way: the rollup just restated their own dashboard, the roster
// duplicated /practice/members, and being outside the /practice tree
// meant PracticeShell never wrapped it, so the practice nav vanished.
// Making its content conditional on branch count patched the symptom;
// this is the structural fix.
//
// Now: clicking into a branch lands the brand-admin in THAT PRACTICE'S
// ORDINARY DASHBOARD — the same screen the practice's own staff see,
// with that practice as their context. The pieces went:
//   • performance / by-doctor rollup → /brand (the one place several
//     branches are compared side by side)
//   • team                           → /practice/members
//   • details + banking              → /practice/details
//   • a way back up                  → "← All practices" in the shell nav
//
// The route itself is KEPT rather than deleted, so every existing
// inbound link still resolves: the brand index's "Open branch →", any
// bookmark, and the six revalidatePath('/brand/branch/…') calls in
// app/brand/actions.ts.
//
// AUTHORIZATION is deliberately left to the destination and not
// duplicated here. /practice resolves the viewer through
// app/practice/practiceViewer.ts, which authorises an explicit
// ?practiceId= by either an active practice_members row OR an active
// practice_group_members row for the practice's group (the same check
// app/brand/actions.ts guardBrandAdminOfPractice makes) and notFound()s
// anything else. Re-implementing a narrower gate here is what made the
// brand-admin path 404 on /practice/pos/devices once before; one gate,
// at the screen that reads the data, is the pattern that fixed it.
//
// searchParams are not forwarded: this route never took any, and
// ?practiceId= is set from the path segment.

export default async function BrandBranchPivotPage({
  params,
}: {
  params: Promise<{ practiceId: string }>;
}) {
  const { practiceId } = await params;
  redirect(`/practice?practiceId=${encodeURIComponent(practiceId)}`);
}
