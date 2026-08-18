// ─── Practice setup checklist — derived, never stored ─────────────────────
//
// A new practice meets tills, PINs, banking, team and details as a flat pile
// of sidebar links: no order, no sense of progress, no way to know what is
// still missing. This module answers one question — "what does this practice
// still have to do?" — from LIVE state only.
//
// NO PERSISTED COMPLETION FLAG. Deliberately.
// ───────────────────────────────────────────
// The obvious implementation is a practices.onboarding_completed boolean set
// when the last step is ticked. Every such flag is a second copy of a truth
// that already exists, and the copy is wrong the moment the underlying thing
// changes behind it: revoke the last till device, or have banking cleared by
// an admin, and the flag still says "done" while the practice silently cannot
// be paid. There is no reconciliation job that can fix that, because the flag
// has no way to know it went stale. So the state is DERIVED on every render
// from the same rows the rest of the product reads, and nothing is written.
//
// WHAT COUNTS AS REQUIRED
// ───────────────────────
// The required set is details / banking / practitioner — and it mirrors the
// trading gate rather than everything a practice could possibly configure.
//
// The till used to be a fourth required item and is not any more. A practice
// that bills from the manager's laptop and never registers a front-desk till
// is a valid, correctly-configured practice, so requiring one gave that
// practice an item it could never complete — and an unfinishable checklist
// breaks the only promise this card makes, which is that it finishes and goes
// away. It is now a SUGGESTION (see TILL_SUGGESTION): shown while the card is
// up, never counted, and gone the moment a till exists.
//
// SAME SOURCES AS THE TRADING GATE
// ────────────────────────────────
// Two of the three items ARE trading-gate conditions, so they must not be
// re-implemented — a checklist that disagrees with the gate is worse than no
// checklist, because it tells a practice they are ready when billing will
// still refuse them:
//   • banking  → resolvePayoutBanking, the SAME resolver lib/practice/
//     tradingGate.ts calls. NOT a direct read of practices.bank_*, which
//     would report "no banking" for a branch that settles through its
//     BRAND's central account — permanently nagging a practice to fix
//     something that is already correct.
//   • provider → the same practice_members predicate the gate uses
//     (active = true AND role = 'provider'), which post-0091 counts
//     login-less roster practitioners too.
//
// The gate's THIRD condition, practices.status = 'approved', is not a
// checklist item and is not stated by this card at all: nobody at the practice
// can action it, and an item with no action fails the "what do I do next" test
// the card exists to pass.
//
// It is not stated here because it is already stated, unconditionally, by the
// trading-gate panel on the same screen (app/practice/page.tsx) — that panel
// renders whenever the gate is closed, and pending approval always closes it.
// Saying it twice in two different sets of words reads as two different
// problems. So the panel owns approval and this card owns "what you can do",
// which is a sharper split than both surfaces half-owning both. That the card
// can be COMPLETE while billing is still blocked is therefore fine and
// expected: the panel is what explains the wait.
//
// FAIL-CLOSED
// ───────────
// Every unreadable fact resolves to NOT done. A missed tick costs a practice
// one redundant glance at a screen they have already filled in; a wrongly
// ticked box means they sit waiting to be paid into an account they never
// gave us.

import { resolvePayoutBanking } from './banking';

// Loose structural type — same reason and same shape as tradingGate.ts: the
// caller passes either the SSR client or the service-role client, and naming
// Supabase's generic builder here triggers "type instantiation is excessively
// deep" under strict mode.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SetupChecklistSupabase = any;

/**
 * Live facts the checklist is derived from. Nothing here is cached.
 *
 * practices.status is deliberately NOT among them. Approval is the gate's
 * third condition and this card says nothing about it (see the header) — the
 * trading-gate panel owns it. Carrying it here unused would be an invitation
 * to grow a second opinion about whether a practice is approved.
 */
export type SetupChecklistFacts = {
  phone:                 string | null;
  addressLine1:          string | null;
  latitude:              number | null;
  longitude:             number | null;
  /** resolvePayoutBanking(...).source !== 'none' — own OR brand banking. */
  bankingResolved:       boolean;
  /**
   * At least one practice_members row, active, role = 'provider' — roster rows
   * included.
   *
   * A BOOLEAN, not a count, and the name says so. It used to be
   * `activeProviderCount: number`, which was a lie the loader could not tell the
   * truth about: loadSetupChecklistFacts reads with .limit(1), because this
   * checklist only ever asks "> 0", so the value was 0-or-1 however many
   * practitioners a practice actually had.
   *
   * That lie nearly shipped. The brand Practices table read the field, believed
   * the name, and would have rendered "1 on roster" for a practice with nine —
   * a specific claim, and wrong. Presence is what is measured, so presence is
   * what it is called.
   *
   * If a real count is ever needed, it needs its OWN field and its own
   * un-limited read; dropping the .limit(1) here would change query cost on a
   * path used by both this checklist and the brand table.
   */
  hasActiveProvider:     boolean;
  /**
   * At least one till_devices row with revoked_at IS NULL. Revoked devices do
   * not count. Boolean for the same reason as hasActiveProvider above.
   */
  hasActiveTillDevice:   boolean;
  /** practices.till_pin_hash IS NOT NULL. */
  hasTillPin:            boolean;
};

/**
 * What the VIEWER is allowed to do, so the card never links someone to a
 * screen that will reject them. Each flag mirrors the authority the target
 * screen actually enforces — see the per-item comments in ITEM_BUILDERS.
 */
export type SetupChecklistAuthority = {
  /** /practice/details — notFound() for anyone who is not a brand-admin. */
  canEditDetails: boolean;
  /** The "+ Add practitioner" control on /practice/members is manager-only. */
  canManageTeam:  boolean;
  /** /practice/pos/devices — per-practice manager OR brand-admin. */
  canManageTill:  boolean;
};

/**
 * The REQUIRED items — the ones that are counted and that hold the card open.
 * The till is deliberately not among them; see SetupChecklistSuggestion.
 */
export type SetupChecklistItemKey = 'banking' | 'provider' | 'details';

export type SetupChecklistItem = {
  key:   SetupChecklistItemKey;
  /** WHAT to do, in the words a practice would use. */
  title: string;
  /** WHY it matters, for someone who has never used a payments product. */
  why:   string;
  done:  boolean;
  /**
   * The exact screen that completes this item, or null when the viewer has
   * no authority there — a link that 404s is worse than no link.
   */
  href:        string | null;
  actionLabel: string;
  /**
   * Extra plain-language detail, only when it tells the reader something the
   * title cannot — e.g. WHICH half of the till is still missing.
   */
  hint: string | null;
};

/**
 * A strongly-encouraged extra that is NOT part of the count and cannot hold
 * the card open. Structurally separate from SetupChecklistItem on purpose:
 * there is no `done` field, because a suggestion is either offered or it is
 * not — "outstanding" is a state only a required item can be in, and a
 * suggestion that could sit un-ticked forever is the thing this replaced.
 */
export type SetupChecklistSuggestion = {
  key:     'till';
  /** Small label above the title, saying plainly that this one is optional. */
  eyebrow: string;
  title:   string;
  why:     string;
  /** Names the missing half when one of the two pieces is already in place. */
  hint:        string | null;
  href:        string;
  actionLabel: string;
};

export type SetupChecklist = {
  items:     SetupChecklistItem[];
  doneCount: number;
  total:     number;
  /** True → the card must not render at all. */
  complete:  boolean;
  /**
   * The till nudge, or null when there is nothing to nudge about: the till is
   * already set up, the viewer could not act on it anyway, or the card itself
   * is about to disappear.
   */
  suggestion: SetupChecklistSuggestion | null;
};

// ─── Copy ─────────────────────────────────────────────────────────────────
//
// Every line is written for someone with no training and no manual. Two
// rules, both learned from the wording this card replaces:
//   • say the BENEFIT, not the feature — "so we can pay you", not "required
//     for payout processing". A practice owner does not know what a payout
//     run is and should not have to.
//   • never name a database column, a screen, or a role in the reason. The
//     reason has to survive being read aloud to someone standing at a front
//     desk.

const COPY: Record<SetupChecklistItemKey, { title: string; why: string; action: string }> = {
  banking: {
    title:  'Bank account',
    why:    'So we can pay you. This is the account your patients’ payments land in.',
    action: 'Add bank details',
  },
  provider: {
    title:  'The doctor or practitioner',
    why:    'Every bill has to say who treated the patient. Add them once and they’re on the list.',
    action: 'Add a practitioner',
  },
  details: {
    title:  'Address and phone number',
    why:    'So patients can find you, and so you come up when someone searches for a practice near them.',
    action: 'Add your address',
  },
};

/**
 * The till, as an invitation rather than a demand.
 *
 * It says plainly that it is optional, because a practice that bills from one
 * laptop is not doing anything wrong and must not be told otherwise. The
 * reason covers the two things that actually persuade someone: reception can
 * get on with it without waiting for the manager, and nobody ends up sharing
 * the manager's login to do it. The second half is the security point, said
 * without the word security — "your login never has to be shared" is the thing
 * a grandmother can picture; "role-based access control" is not.
 */
export const TILL_SUGGESTION = {
  eyebrow: 'Optional — but worth doing',
  title:   'Set up the front desk till',
  why:     'Then whoever is at reception can take a card payment without waiting for you, and they do it with a short PIN of their own — so your login never has to be shared.',
  action:  'Set up the till',
} as const;

/** Shown in place of the action link when the viewer cannot do it themselves. */
export const ASK_A_MANAGER_NOTE = 'Ask whoever manages your practice to do this one.';

// ─── Derivation ───────────────────────────────────────────────────────────

/**
 * Practice details count as done when we have the three things the rest of
 * the product actually consumes: a phone number, a street address, and map
 * coordinates.
 *
 * Coordinates are in the list because they are the one part that silently
 * goes missing. Signup geocodes the address and writes latitude/longitude
 * best-effort — on a geocode failure it nulls them and carries on, so the
 * practice looks complete while being un-findable: lib/practitioner/
 * grouping.ts gives a coordinate-less practice distanceKm = null, which
 * sorts it BELOW every practice that has coordinates, in a list patients
 * scan by distance. Nothing else in the product ever tells them.
 */
function detailsDone(f: SetupChecklistFacts): boolean {
  return (
    !!f.phone?.trim() &&
    !!f.addressLine1?.trim() &&
    f.latitude  != null &&
    f.longitude != null
  );
}

/**
 * The till is ONE thing, not two, even though a device and a PIN are two
 * separate pieces of setup on two separate controls.
 *
 * Two reasons. Neither half is worth anything alone — a registered till with
 * no PIN cannot be unlocked, and a PIN with no till has nothing to unlock —
 * so "device done, PIN outstanding" describes no state a practice can use.
 * And both are completed on the SAME screen (/practice/pos/devices), so
 * splitting them would produce two prompts carrying the identical link. The
 * half that is still missing is named in the hint, so nothing is hidden by
 * collapsing them.
 *
 * This is now what decides whether the SUGGESTION is offered rather than
 * whether an item is ticked: once the till is genuinely usable, the nudge
 * stops. Nagging a practice about something they have already done is how a
 * suggestion turns into noise.
 */
function tillDone(f: SetupChecklistFacts): boolean {
  return f.hasActiveTillDevice && f.hasTillPin;
}

function tillHint(f: SetupChecklistFacts): string | null {
  if (tillDone(f)) return null;
  if (f.hasActiveTillDevice && !f.hasTillPin) {
    return 'The till computer is registered. It just needs a PIN before anyone can use it.';
  }
  if (f.hasTillPin && !f.hasActiveTillDevice) {
    return 'The PIN is set. Now register the computer at your front desk.';
  }
  return null;
}

function detailsHint(f: SetupChecklistFacts): string | null {
  if (detailsDone(f)) return null;
  // The specific, easily-missed case: address text is there but we could not
  // place it on a map. "Add your address" would read as already done.
  if (f.addressLine1?.trim() && (f.latitude == null || f.longitude == null)) {
    return 'We couldn’t find your address on the map. Open it and pick your address from the list of suggestions.';
  }
  return null;
}

/**
 * Build the checklist from live facts + the viewer's authority.
 *
 * Pure: same inputs, same output, no clock and no I/O. The freshness of the
 * answer is entirely a property of the facts handed in — see
 * loadSetupChecklistFacts.
 */
export function buildSetupChecklist(
  facts:     SetupChecklistFacts,
  authority: SetupChecklistAuthority,
): SetupChecklist {
  // Ordered by what it costs the practice to leave undone: the two
  // trading-gate conditions block billing outright, so they lead. Being hard
  // to find costs them patients. A practice reading top-to-bottom fixes the
  // expensive things first.
  const items: SetupChecklistItem[] = [
    {
      key:   'banking',
      ...pick('banking'),
      done:  facts.bankingResolved,
      // Banking lives on /practice/details behind the #banking anchor, and
      // both of that page's save actions are guarded on brand-admin — the
      // same authority the page itself enforces before rendering anything.
      href:  authority.canEditDetails ? '/practice/details#banking' : null,
      hint:  null,
    },
    {
      key:   'provider',
      ...pick('provider'),
      done:  facts.hasActiveProvider,
      // /practice/members is readable by any member, but the control that
      // adds a practitioner is manager-only, so a non-manager sent here
      // would find nothing to click.
      href:  authority.canManageTeam ? '/practice/members' : null,
      hint:  null,
    },
    {
      key:   'details',
      ...pick('details'),
      done:  detailsDone(facts),
      href:  authority.canEditDetails ? '/practice/details' : null,
      hint:  detailsHint(facts),
    },
  ];

  const doneCount = items.filter((i) => i.done).length;
  const complete  = doneCount === items.length;

  return {
    items,
    doneCount,
    total:    items.length,
    complete,
    // Suppressed when `complete`, even though the card is about to return null
    // anyway. Two reasons to enforce it HERE rather than leaving it to the
    // renderer: the returned value then cannot describe a state the product
    // does not have (a live suggestion on a finished checklist), and the rule
    // "the till never keeps this card on the page" becomes a property of the
    // derivation that a test can state directly instead of an emergent
    // property of two guards in two files.
    suggestion: complete ? null : tillSuggestion(facts, authority),
  };
}

/**
 * The till nudge, or null.
 *
 * Withheld in three cases, all of which mean "there is nothing useful to say":
 *   • the till is already set up — a suggestion that survives being acted on
 *     is a nag
 *   • the viewer cannot manage the till, so the only honest version would be
 *     "ask someone else to do this optional thing", which is noise rather than
 *     help. Required items DO fall back to naming who to ask, because those
 *     have to get done by somebody; an optional one does not.
 *   • the required items are finished, handled by the caller above
 */
function tillSuggestion(
  facts:     SetupChecklistFacts,
  authority: SetupChecklistAuthority,
): SetupChecklistSuggestion | null {
  if (tillDone(facts))           return null;
  if (!authority.canManageTill)  return null;

  return {
    key:         'till',
    eyebrow:     TILL_SUGGESTION.eyebrow,
    title:       TILL_SUGGESTION.title,
    why:         TILL_SUGGESTION.why,
    hint:        tillHint(facts),
    href:        '/practice/pos/devices',
    actionLabel: TILL_SUGGESTION.action,
  };
}

function pick(key: SetupChecklistItemKey): { title: string; why: string; actionLabel: string } {
  const c = COPY[key];
  return { title: c.title, why: c.why, actionLabel: c.action };
}

// ─── Loading the facts ────────────────────────────────────────────────────

/**
 * Read every fact the checklist needs, live.
 *
 * Called with the SERVICE-ROLE client for the same reason checkTradingGate is:
 * whether a practice is set up is a property of the PRACTICE, not of whoever
 * is looking at it. Reading it through the viewer's own client would make the
 * card's contents depend on that viewer's RLS reach — a brand-admin with no
 * practice_members row reads no till_devices at all, and the card would
 * cheerfully report "no till registered" for a practice that has three.
 *
 * `resolveBanking` is injectable for the same reason tradingGate.ts exposes
 * it: it lets the unit tests state banking as a fact instead of reproducing
 * the resolver's two-table query shape.
 */
export async function loadSetupChecklistFacts(
  supabase:   SetupChecklistSupabase,
  practiceId: string,
  opts?: { resolveBanking?: typeof resolvePayoutBanking },
): Promise<SetupChecklistFacts> {
  const resolveBanking = opts?.resolveBanking ?? resolvePayoutBanking;

  // ─── All four reads at once ─────────────────────────────────────────────
  //
  // These were four sequential awaits. Nothing here depends on anything else
  // here — every one is keyed on `practiceId` alone — so the sequence was an
  // artefact of how it was written, and it cost four serial round trips.
  //
  // It matters more than the four suggests, because of ONE caller:
  // resolveBrandPracticeSetup invokes this once per branch inside its own
  // Promise.all. A twelve-branch brand was therefore paying four serial round
  // trips, twelve times over concurrently. Collapsing this to one collapses
  // that to one-times-twelve, and the saving grows with brand size.
  //
  // Nothing about the queries changes — same tables, same columns, same
  // filters, same limits, same result shape. Only the number of sequential
  // waits does.
  const [
    { data: practice },
    { data: providers },
    // Revoked devices are kept forever (0088 revokes, never deletes), so this
    // MUST filter on revoked_at — counting rows would tick the item for a
    // practice whose only till was revoked months ago.
    { data: devices },
    banking,
  ] = await Promise.all([
    supabase
      .from('practices')
      .select('phone, address_line1, latitude, longitude, till_pin_hash')
      .eq('id', practiceId)
      .maybeSingle(),
    supabase
      .from('practice_members')
      .select('id')
      .eq('practice_id', practiceId)
      .eq('active', true)
      .eq('role', 'provider')
      .limit(1),
    supabase
      .from('till_devices')
      .select('id')
      .eq('practice_id', practiceId)
      .is('revoked_at', null)
      .limit(1),
    resolveBanking(supabase, practiceId),
  ]);

  return {
    phone:        (practice?.phone        as string | null) ?? null,
    addressLine1: (practice?.address_line1 as string | null) ?? null,
    latitude:     practice?.latitude  != null ? Number(practice.latitude)  : null,
    longitude:    practice?.longitude != null ? Number(practice.longitude) : null,
    bankingResolved:       banking.source !== 'none',
    hasActiveProvider:   (providers?.length ?? 0) > 0,
    hasActiveTillDevice: (devices?.length   ?? 0) > 0,
    hasTillPin:            !!practice?.till_pin_hash,
  };
}
