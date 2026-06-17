// ─── Bill lifecycle (Sent / Viewed / Paid / Expired) ─────────────────────
//
// ONE source of truth that maps the underlying state of a bill to a
// single user-facing label. The lifecycle is derived from data that
// already exists today (plan status + invitation timestamps) — there
// is intentionally no new persisted "status" column. Different surfaces
// (practice bills list, bill detail, admin) all read through this
// helper so the label stays consistent.
//
// Why these four labels (and only these four):
//
//   • Sent     — bill exists, patient hasn't engaged yet.
//   • Viewed   — patient has opened the checkout link (or, for an
//                existing-account bill, has moved past the dashboard
//                accept screen — i.e. they've engaged with it).
//   • Paid     — first instalment has landed. The plan is now active /
//                completed / defaulted; from the provider's revenue
//                point of view the bill is in collection, the till
//                moment has already happened.
//   • Expired  — either the plan was cancelled/declined, or the
//                invitation link has passed expires_at without the
//                patient ever paying.
//
// Why "Paid" subsumes active/completed/defaulted:
//   The first instalment lands when the plan flips to 'active'. That
//   is the "card machine beep" the provider is waiting for. The plan
//   may later be 'completed' (every instalment collected) or
//   'defaulted' (later instalment(s) failed — collection risk lives
//   with HNPL, not the practice). In all three the practice has been
//   paid for instalment 1, so "Paid" is the honest label here.
//
// Why an active/completed/defaulted plan that ALSO has an expired
// invitation row still counts as Paid:
//   The plan flag wins. If money landed, expiry of the link is moot.

export type BillLifecycleStatus = 'sent' | 'viewed' | 'paid' | 'expired';

export type BillLifecycleInput = {
  /** plans.status — pending_acceptance | pending_first_payment | active | completed | defaulted | cancelled | declined */
  planStatus: string;

  /** patient_invitations.viewed_at — null/undefined when no invitation row or never opened. */
  invitationViewedAt?:   string | Date | null;

  /** patient_invitations.accepted_at — null/undefined for unpaid invitations. */
  invitationAcceptedAt?: string | Date | null;

  /** patient_invitations.expires_at — null/undefined for existing-account bills (no invitation row). */
  invitationExpiresAt?:  string | Date | null;

  /** Override for testability; defaults to `new Date()`. */
  now?: Date;
};

function toDate(v: string | Date | null | undefined): Date | null {
  if (!v) return null;
  return v instanceof Date ? v : new Date(v);
}

export function deriveBillLifecycleStatus(input: BillLifecycleInput): BillLifecycleStatus {
  const now = input.now ?? new Date();

  // Paid wins over everything else. If the first instalment landed the
  // plan is active (or has progressed to completed / defaulted), and
  // the practice has been paid.
  if (
    input.planStatus === 'active' ||
    input.planStatus === 'completed' ||
    input.planStatus === 'defaulted'
  ) {
    return 'paid';
  }

  // Cancelled / declined plans are dead — render as expired so the
  // provider's list doesn't dangle them in 'Sent' forever.
  if (input.planStatus === 'cancelled' || input.planStatus === 'declined') {
    return 'expired';
  }

  // Invitation-backed: link past expiry without ever being accepted.
  const expiresAt = toDate(input.invitationExpiresAt);
  const accepted  = toDate(input.invitationAcceptedAt);
  if (expiresAt && !accepted && expiresAt.getTime() <= now.getTime()) {
    return 'expired';
  }

  // Viewed: the patient either opened the checkout link OR (for the
  // existing-account scenario where no invitation exists) the plan
  // has moved past pending_acceptance. Both signal "engaged but not
  // yet paid".
  const viewedAt = toDate(input.invitationViewedAt);
  if (viewedAt || input.planStatus === 'pending_first_payment') {
    return 'viewed';
  }

  return 'sent';
}

// ─── Chip styling ────────────────────────────────────────────────────────
//
// Returned classes match the existing chip vocabulary used elsewhere in
// the app so the four lifecycle labels feel native in the practice +
// admin views. Stays small on purpose — surfaces compose their own
// wrapper (rounded-full, padding, font size) so this helper does not
// dictate layout.

export type BillLifecycleChip = {
  label: string;
  /** Tailwind classes for background + text. */
  cls:   string;
  /** Plain-English tooltip/aria-label for screen readers + hover. */
  hint:  string;
};

export function billLifecycleChip(status: BillLifecycleStatus): BillLifecycleChip {
  switch (status) {
    case 'sent':
      return {
        label: 'Sent',
        cls:   'bg-gray-100 text-gray-700',
        hint:  'Invitation emailed — patient has not opened it yet.',
      };
    case 'viewed':
      return {
        label: 'Viewed',
        cls:   'bg-blue-100 text-blue-800',
        hint:  'Patient has opened the checkout link.',
      };
    case 'paid':
      return {
        label: 'Paid',
        cls:   'bg-green-100 text-green-700',
        hint:  'First instalment collected — bill is in collection.',
      };
    case 'expired':
      return {
        label: 'Expired',
        cls:   'bg-gray-100 text-gray-400',
        hint:  'Link expired, or the bill was cancelled.',
      };
  }
}
