import {
  loadSetupChecklistFacts,
  buildSetupChecklist,
  type SetupChecklistSupabase,
  type SetupChecklistItem,
  type SetupChecklistItemKey,
} from '@/lib/practice/setupChecklist';
import type { BrandPracticeRow } from './brandViewer';

// ─── Setup state for every practice in a brand ──────────────────────────────
//
// WHY IT DELEGATES INSTEAD OF QUERYING
// ────────────────────────────────────
// A brand admin needs to spot that one branch has no banking without visiting
// it. The temptation is to read practices.bank_name across the group in one
// query and call it done. That answer would be WRONG, and wrong in the
// direction that nags a correctly-configured practice forever: a branch that
// settles through its BRAND's central account has empty bank_* columns and is
// perfectly settleable. lib/practice/banking.ts resolvePayoutBanking is what
// knows that, the trading gate calls it, and lib/practice/setupChecklist.ts
// calls it too — so the only way for this table to agree with the practice's own
// checklist card is to go through the same derivation.
//
// So it does, literally: loadSetupChecklistFacts for the facts and
// buildSetupChecklist for the verdicts, per practice. The three booleans this
// table shows for banking / practitioner / details ARE the checklist's own
// `item.done` values — not a re-derivation that happens to agree today. That
// makes "the table and the card agree" true by construction, and the test that
// asserts it is checking the wiring rather than a coincidence.
//
// IT RUNS FOR A PRACTICE THE VIEWER IS NOT A MEMBER OF
// ───────────────────────────────────────────────────
// Which is the normal case here: a brand admin usually has no practice_members
// row anywhere. That works because loadSetupChecklistFacts takes a SERVICE-ROLE
// client by design — its own docstring says why: how far a practice has got with
// its setup is a property of the PRACTICE, not of whoever is looking. Reading it
// through the viewer's client would make the answer depend on their RLS reach,
// and a brand admin with no membership reads no till_devices at all, so the
// table would report "no till" for a practice that has three. Same client, same
// reason, one scope up. Nothing about the checklist needed changing to serve
// this surface.
//
// WHAT IT ADDS THAT THE CHECKLIST DOES NOT
// ────────────────────────────────────────
// Two things the card deliberately omits, both of which a brand admin does need:
//
//   APPROVAL. practices.status is not a checklist item and the card says nothing
//   about it, because nobody AT the practice can action it — the trading-gate
//   panel on their dashboard owns that message. A brand admin is a different
//   reader with a different question ("why is this branch not trading?"), and for
//   them the status is the answer, so it is a column here. It is reported
//   verbatim from the row, never re-derived.
//
//   THE TILL, AS FACTS RATHER THAN A VERDICT. The checklist demoted the till to
//   an optional suggestion — a practice billing from one laptop is correctly
//   configured — so there is no `done` for it to borrow. Rather than
//   re-implementing its two-part predicate here (which is exactly the parallel
//   implementation this module exists to avoid), the two facts are surfaced as
//   they stand: whether a device is registered, and whether a PIN is set.
//   Nothing to diverge, and it reads better anyway — "registered, no PIN" is
//   more useful to whoever has to fix it than a red cross.
//
// PRESENCE, NOT COUNTS
// ────────────────────
// loadSetupChecklistFacts applies .limit(1) to both its practice_members and
// till_devices reads, because the checklist only ever asks "is there one?". Its
// facts are therefore named for what they measure — hasActiveProvider and
// hasActiveTillDevice — and this module passes them straight through.
//
// They were `activeProviderCount` / `activeTillDeviceCount` when this module was
// written, and this table is the reason they are not any more: it read them,
// believed the names, and would have rendered "1 on roster" for a practice with
// nine — a specific claim, and wrong. The conversion that used to happen here
// (`facts.activeProviderCount > 0`) is gone because there is nothing left to
// convert.
//
// A real count would need its own field and its own un-limited read. Not worth
// it for a number no decision on this screen depends on, and dropping the
// .limit(1) would change query cost on a path both surfaces share.

/** What the table shows for one practice. */
export type BrandPracticeSetup = {
  practiceId:   string;
  practiceName: string;
  suburb: string | null;
  city:   string | null;

  /** practices.status, verbatim. Never re-derived. */
  status:   string;
  approved: boolean;

  /**
   * The checklist's OWN items, carried whole so the table can print their
   * titles for whatever is outstanding rather than inventing its own words.
   * Read for `key`, `done` and `title` only — see BRAND_TABLE_AUTHORITY on why
   * `href` is deliberately unused.
   */
  items: SetupChecklistItem[];
  /** The same verdicts, keyed, for column lookup. */
  done:  Record<SetupChecklistItemKey, boolean>;
  /** Outstanding keys in the checklist's own order (costliest first). */
  outstanding: SetupChecklistItemKey[];
  doneCount: number;
  total:     number;
  /** Every required item ticked. Note this can be true while status is still
   *  pending — the checklist's header explains why that is correct. */
  setupComplete: boolean;

  /**
   * Facts the checklist gathers but does not turn into an item. Passed straight
   * through from SetupChecklistFacts, which names them for presence too — see
   * the header for why neither layer pretends to have a count.
   */
  hasProvider:   boolean;
  hasTillDevice: boolean;
  hasTillPin:    boolean;

  /**
   * The one flag the table's styling keys off: something here needs a human.
   * Either a required item is outstanding, or the practice is not approved.
   * Approval is included because "set up but not trading" is precisely the
   * state a brand admin is scanning for, and a green row for it would be a lie
   * of omission.
   */
  needsAttention: boolean;
};

/**
 * The authority passed to buildSetupChecklist, and the reason it barely matters.
 *
 * That argument decides two things: whether each item carries a fix-it `href`,
 * and whether the optional till nudge is offered. This table uses NEITHER — the
 * row's only destination is the practice's own dashboard, where the checklist
 * card recomputes every href for the real viewer with the real authority.
 * Deep-linking from here would mean a second set of fix-it URLs that could drift
 * from the card's, and the card is the canonical fix path.
 *
 * The values are still the brand admin's genuine rights rather than a
 * convenient `true`, so nothing here quietly asserts an authority the viewer
 * does not have:
 *   canEditDetails  brand-admin — which every viewer of this page is
 *   canManageTeam   FALSE: /practice/members' add control is manager-only, and
 *                   brand authority is never converted into a practice-member
 *                   capability (see app/practice/practiceViewer.ts)
 *   canManageTill   brand-admin satisfies guardTillManager
 */
export const BRAND_TABLE_AUTHORITY = {
  canEditDetails: true,
  canManageTeam:  false,
  canManageTill:  true,
} as const;

/**
 * Resolve setup state for every practice handed in.
 *
 * @param svc SERVICE-ROLE client. Required, not merely accepted — see the header.
 *
 * Practices fan out concurrently, so latency is one round of reads rather than
 * one per practice. The query COUNT does scale (loadSetupChecklistFacts is three
 * reads plus banking resolution, so roughly five per practice), which is the same
 * bargain lib/brand/brandPayouts.ts documents and accepts for the same reason:
 * a cheaper bulk query would mean a second derivation of a rule that already
 * exists, and the two copies would disagree on exactly the branch that settles
 * centrally.
 */
export async function resolveBrandPracticeSetup(
  svc:       SetupChecklistSupabase,
  practices: BrandPracticeRow[],
): Promise<BrandPracticeSetup[]> {
  const resolved = await Promise.all(
    practices.map(async (practice) => {
      const facts     = await loadSetupChecklistFacts(svc, practice.id);
      const checklist = buildSetupChecklist(facts, BRAND_TABLE_AUTHORITY);

      const done = {} as Record<SetupChecklistItemKey, boolean>;
      for (const item of checklist.items) done[item.key] = item.done;

      const approved = practice.status === 'approved';

      return {
        practiceId:   practice.id,
        practiceName: practice.name,
        suburb: practice.suburb,
        city:   practice.city,

        status: practice.status,
        approved,

        items:       checklist.items,
        done,
        outstanding: checklist.items.filter((i) => !i.done).map((i) => i.key),
        doneCount:   checklist.doneCount,
        total:       checklist.total,
        setupComplete: checklist.complete,

        hasProvider:   facts.hasActiveProvider,
        hasTillDevice: facts.hasActiveTillDevice,
        hasTillPin:    facts.hasTillPin,

        needsAttention: !checklist.complete || !approved,
      } satisfies BrandPracticeSetup;
    }),
  );

  // Practices needing attention first — the table exists to surface them, and a
  // brand admin should not have to scan an alphabetical list to find the one
  // branch with no banking. Within each group, the practice with MORE
  // outstanding leads, then name, so the order is stable across renders.
  return resolved.sort((a, b) =>
    Number(b.needsAttention) - Number(a.needsAttention) ||
    b.outstanding.length - a.outstanding.length ||
    a.practiceName.localeCompare(b.practiceName),
  );
}
