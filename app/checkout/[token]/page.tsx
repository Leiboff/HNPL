import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import CheckoutForm from './CheckoutForm';
import ResumeCapture from './ResumeCapture';
import {
  initiateCheckout,
  requestPhoneOtp,
  verifyPhoneOtp,
  resumeFirstInstalmentCapture,
} from './actions';
import { isAllowedSalaryDay } from '@/lib/salaryDates';
import { findExistingAuthUser } from '@/lib/auth/findExistingAuthUser';
import { decryptId, maskId } from '@/lib/idEncryption';

// The fresh-vs-resume decision reads the session cookie + plan state
// per request — the RSC output for this URL is different for the
// same user before and after their first Pay click. Next.js's default
// client-side router cache would happily serve the earlier (anonymous
// CheckoutForm) RSC on a soft-nav back to /checkout/[token] and then
// swap to the fresh (ResumeCapture) RSC after revalidation — that
// swap is the flicker prod saw 2026-07-31. Marking the route dynamic
// gives it staleTime=0 in the router cache, so soft-navs always
// re-fetch and the client never renders the stale surface. The route
// is already effectively dynamic (it reads cookies), but explicit
// beats implicit here.
export const dynamic  = 'force-dynamic';
export const revalidate = 0;

// ─── /checkout/[token] ─────────────────────────────────────────────────────
//
// Anonymous quasi-checkout / quasi-signup page for provider-initiated
// bill invitations. The token in the URL is proof that the patient
// controls the inbox we emailed it to — that's our email
// verification, no OTP needed.
//
// Auth is INTENTIONALLY not required for this route. An anonymous
// visitor can use the whole flow up to the "Pay" submit; the account
// is created at that point as a byproduct of paying. After payment,
// the /done page sets their real password.
//
// Invitation lookup goes through the SECURITY DEFINER RPC
// `get_invitation_by_token` (migration 0049). The function is the
// single anon-accessible surface — there is NO direct anon SELECT on
// patient_invitations, so the bulk-dump vector that the table
// previously exposed is closed. The function returns a row only if
// the invitation is non-expired, unaccepted, and its plan is still
// payable; otherwise it returns nothing and we render the generic
// "no longer valid" state.
//
// Mobile-first — this is a point-of-sale screen used at a practice
// counter or on the move. Single column, large tap targets, no
// horizontal overflow.

type Params = { token: string };

type InvitationRpcRow = {
  email:               string;
  practice_name:       string | null;
  plan_id:             string;
  plan_total_amount:   number | string;
  invoice_number:      string | null;
  practice_reference:  string | null;
};

// ─── POS counter session (migration 0085) — the SA-ID-keyed sibling of
// the email invitation above. No email; sa_id_number arrives encrypted
// and is decrypted+masked server-side below, never shipped as plaintext.
type SessionRpcRow = {
  plan_id:             string;
  practice_name:       string | null;
  plan_total_amount:   number | string;
  invoice_number:      string | null;
  practice_reference:  string | null;
  sa_id_number:        string;
};

type ResolvedToken =
  | { kind: 'invitation'; row: InvitationRpcRow }
  | { kind: 'session';    row: SessionRpcRow };

function InvalidLinkCard({ reason }: { reason: string }) {
  return (
    <div className="min-h-screen flex items-center justify-center px-5 py-12 bg-[#FAFBFD]">
      <div className="w-full max-w-md rounded-[20px] bg-white border border-[#E5E9F0] p-8 text-center space-y-4 shadow-[0_1px_2px_rgba(15,31,58,0.04)]">
        <div className="w-14 h-14 mx-auto rounded-full bg-[#FBF1DD] ring-1 ring-[#C8841C]/20 flex items-center justify-center text-[#8A5A11]">
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} aria-hidden>
            <circle cx="12" cy="12" r="9" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 7.5v5M12 16.25h.008" />
          </svg>
        </div>
        <h1 className="text-2xl font-semibold text-[#0F1F3A] tracking-[-0.01em]">
          This link is no longer valid
        </h1>
        <p className="text-[15px] leading-relaxed text-[#3A4B66]">{reason}</p>
        <p className="text-sm text-[#7A8AA0]">
          If you think this is a mistake, please ask your practice to send you a new bill.
        </p>
      </div>
    </div>
  );
}

export default async function CheckoutPage({
  params,
  searchParams,
}: {
  params:       Promise<Params>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { token } = await params;
  await searchParams; // no query params drive this route anymore

  if (!token || token.length < 16) {
    return <InvalidLinkCard reason="The checkout link is missing or malformed." />;
  }

  // Anon-callable RPCs. No direct SELECT on patient_invitations or
  // checkout_sessions — these functions are the ONLY anon surface for
  // each, and each returns a single row exactly when its token is
  // still valid + its plan is payable. A null / empty result from BOTH
  // collapses every "invalid" reason into one generic message; the
  // privacy fix (0049) is worth that, and the same posture extends to
  // the session token (0085).
  //
  // Try the email-invitation token first (the far more common path
  // today), then fall back to a POS counter-session token. The two
  // token spaces don't overlap (different tables, different random
  // generation), so this is unambiguous.
  const supabase = await createClient();

  const { data: invRpcRows, error: invRpcErr } = await supabase.rpc('get_invitation_by_token', {
    p_token: token,
  });
  if (invRpcErr) {
    console.error('[checkout] get_invitation_by_token failed', invRpcErr.message);
    return <InvalidLinkCard reason="Couldn't load this invitation. Please try again in a moment." />;
  }

  let resolved: ResolvedToken | null = null;
  const invRows = (invRpcRows ?? []) as InvitationRpcRow[];
  if (invRows.length > 0) {
    resolved = { kind: 'invitation', row: invRows[0] };
  } else {
    const { data: sessionRpcRows, error: sessionRpcErr } = await supabase.rpc('get_checkout_session_by_token', {
      p_token: token,
    });
    if (sessionRpcErr) {
      console.error('[checkout] get_checkout_session_by_token failed', sessionRpcErr.message);
      return <InvalidLinkCard reason="Couldn't load this checkout. Please try again in a moment." />;
    }
    const sessionRows = (sessionRpcRows ?? []) as SessionRpcRow[];
    if (sessionRows.length > 0) {
      resolved = { kind: 'session', row: sessionRows[0] };
    }
  }

  // If neither function returned a row, the link/QR is invalid /
  // expired / already used / or its plan has moved out of an
  // acceptable state. Send any logged-in caller home to their portal
  // as a courtesy (a returning patient whose bill is already settled
  // belongs there).
  if (!resolved) {
    const { data: { user } } = await supabase.auth.getUser();
    if (user) redirect('/patient');
    return (
      <InvalidLinkCard reason="This link is no longer valid — it may have expired, already been used, or never existed. If you think this is a mistake, please ask your practice to send you a new bill." />
    );
  }

  const row          = resolved.row;
  const practiceName = row.practice_name ?? 'your practice';

  // ── Anonymous-Checkout structural rule ────────────────────────────
  //
  // The anonymous multi-step Checkout below is for genuinely-new
  // people ONLY. Anyone who already has a betternow account (however
  // they signed up — password, Google, or a prior bill) MUST be sent
  // through Sign In → the plan's saved-card acceptance page. That
  // gets them the saved-card offer + avoids minting a duplicate Peach
  // registration for the same physical card.
  //
  // Ownership signals (in priority order):
  //   1. plan.patient_id (stamped at bill creation when the target
  //      email resolves to an existing profile — see
  //      app/practice/bills/new/actions.ts).
  //   2. an existing auth account for the invitation's email (covers
  //      the "bill was for a NEW email that then signed up organically
  //      before clicking the link" #6 race — findExistingAuthUser).
  //
  // Session state (in priority order):
  //   • logged-in owner (session.user.id === plan.patient_id)
  //       → straight to /patient/orders/{planId}/confirm.
  //   • logged-in non-owner
  //       → /patient?reason=invitation_not_yours. We DO NOT drop them
  //         into a plan they don't own, and we DO NOT sign them out
  //         or force account re-onboarding. The confirm page's own
  //         .eq('patient_id', user.id) guard is the second line of
  //         defence.
  //   • logged-out AND ownership signal present
  //       → /login?next=/patient/orders/{planId}/confirm. The safeNext
  //         validator on /auth/callback + the confirm page's own
  //         ownership guard ensure only the right patient lands there.
  //   • logged-out AND no ownership signal
  //       → anonymous CheckoutForm renders (unchanged).
  //
  // Account-enumeration consideration:
  //   The logged-out branch "existing-account vs truly-new" differs
  //   visibly (redirect to login vs. rendered anonymous form). This
  //   fits the app's existing posture — the invitation token in the
  //   URL is proof of email possession (only the invited inbox sees
  //   it), and /login already leaks account presence via "please
  //   confirm your email" and passkey suggestions. See the report
  //   for the tradeoff.
  const confirmPath = `/patient/orders/${row.plan_id}/confirm`;

  // Service-role client — used for BOTH the plan.patient_id lookup
  // (RLS-scoped read that anon can't do) and findExistingAuthUser.
  const svcForLookup = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );

  // Plan-side ownership signal + capture state. The RPC does NOT
  // return these (extending its signature would be a migration); a
  // direct service-role read on plans is enough.
  //
  // Additional fields beyond patient_id:
  //   • status                — routes an "uncaptured" plan back to
  //     the widget instead of to /confirm (which only accepts
  //     pending_acceptance and would otherwise bounce to /patient/orders).
  //   • peach_registration_id — presence means a card was tokenised
  //     on a prior attempt; that plan belongs on the saved-card path.
  //     Absence + pending_first_payment = "attempt 1 wrote the schedule
  //     but never captured a card" = the resume case.
  const { data: planPatientRow } = await svcForLookup
    .from('plans')
    .select('patient_id, status, peach_registration_id')
    .eq('id', row.plan_id)
    .maybeSingle();
  const planPatientId      = (planPatientRow?.patient_id            as string | null | undefined) ?? null;
  const planStatus         = (planPatientRow?.status                as string | null | undefined) ?? null;
  const planRegistrationId = (planPatientRow?.peach_registration_id as string | null | undefined) ?? null;
  const isUncapturedPlan   = planStatus === 'pending_first_payment' && !planRegistrationId;

  const { data: { user: sessionUser } } = await supabase.auth.getUser();

  if (sessionUser) {
    if (planPatientId === sessionUser.id) {
      // Uncaptured plan — attempt 1 wrote plans.status='pending_first_payment'
      // and payments[1].status='processing' but never minted a
      // peach_registration_id (widget mount-race or user abort). The
      // /confirm page's `.eq('status','pending_acceptance')` filter
      // would send this owner to /patient/orders with no way to
      // resume. Keep them on the checkout flow with a Resume CTA that
      // re-opens the Peach V2 widget for the SAME instalment-1 row
      // (deterministic ref → Peach dedups the transaction).
      if (isUncapturedPlan) {
        // Full schedule for the capture surface. This is THE single
        // "Confirm and pay" surface — the only confirm in the flow, for
        // both the fresh signup journey (CheckoutForm → "Continue to
        // payment" → initiateCheckout → redirect here) and a genuine
        // re-entry via the emailed link. No query param, no auto-start.
        const { data: paymentRows } = await svcForLookup
          .from('payments')
          .select('amount, due_date, instalment_number')
          .eq('plan_id', row.plan_id)
          .order('instalment_number', { ascending: true });
        const rows2         = (paymentRows ?? []) as Array<{
          amount: number | string;
          due_date: string | null;
          instalment_number: number;
        }>;
        const firstRow      = rows2.find((r) => r.instalment_number === 1);
        const firstInstalmentAmount = Number(firstRow?.amount ?? row.plan_total_amount);
        const scheduleAmounts = rows2.map((r) => Number(r.amount));
        const scheduleDates   = rows2.map((r) => r.due_date ?? '');

        return (
          <div className="min-h-screen bg-[#FAFBFD]">
            <header className="bg-white border-b border-[#E5E9F0] sticky top-0 z-10">
              <div className="mx-auto max-w-md px-5 py-4 flex items-center justify-between">
                <span
                  className="text-lg font-bold tracking-tight"
                  style={{ fontFamily: 'var(--font-poppins), Poppins, system-ui, sans-serif' }}
                >
                  <span style={{ color: '#13294B' }}>better</span>
                  <span style={{ color: '#15A89E' }}>now</span>
                </span>
                <span className="text-[11px] uppercase tracking-[0.08em] font-medium text-[#7A8AA0]">
                  Secure checkout
                </span>
              </div>
            </header>
            <main className="mx-auto max-w-md px-5 py-8 sm:py-10">
              <ResumeCapture
                token={token}
                practiceName={practiceName}
                totalAmount={Number(row.plan_total_amount)}
                firstInstalmentAmount={firstInstalmentAmount}
                scheduleAmounts={scheduleAmounts}
                scheduleDates={scheduleDates}
                resumeAction={resumeFirstInstalmentCapture}
              />
            </main>
          </div>
        );
      }
      redirect(confirmPath);
    }
    // Session doesn't match — either plan.patient_id is another user
    // (adversarial or wrong-account scenario) or is null AND the
    // signed-in user's email doesn't match the invitation. Bounce to
    // /patient with a reason code; the reason is informational only —
    // we NEVER drop them into a plan they don't own.
    redirect('/patient?reason=invitation_not_yours');
  }

  // Logged out — check for an existing account.
  //
  // For an INVITATION token, two signals:
  //   1. plan.patient_id (bill was created for a matching email, or
  //      a returning patient's second bill).
  //   2. findExistingAuthUser by invitation email (covers the #6
  //      race: bill created for a new email, patient signed up
  //      organically before clicking the link).
  //
  // For a SESSION token (POS counter QR) there is no email signal at
  // all — recognition of "already has a BetterNow account" happens
  // ONLY via this device's own login state, which was already checked
  // above (the sessionUser branch). A logged-out scan always renders
  // CheckoutForm: even if this same person has an account under some
  // other device/session, we don't search for it — matching how
  // QR-at-counter BNPL checkouts elsewhere recognize returning
  // customers (their own device's session), not a background identity
  // lookup. See the practice-bill-POS-checkout investigation.
  let existingAccount = false;
  if (resolved.kind === 'invitation') {
    if (planPatientId) {
      existingAccount = true;
    } else {
      try {
        const found = await findExistingAuthUser(svcForLookup, resolved.row.email);
        existingAccount = !!found;
      } catch (err) {
        console.warn('[checkout] findExistingAuthUser failed (non-fatal)',
          err instanceof Error ? err.message : err);
        // Fall through — a lookup blip should not lock out a truly-new
        // patient. The confirm page's own guard is the second line of
        // defence for the wrong-owner path.
      }
    }
  }

  if (existingAccount) {
    redirect(`/login?next=${encodeURIComponent(confirmPath)}`);
  }

  // Post-0065: salary_day is a profile-first field. If a profile
  // already exists for the invitation's email AND has a salary_day
  // stored, we skip the checkout picker (it's derivable server-side
  // at initiateCheckout time). Otherwise the form shows the inline
  // picker so the value is captured once and persisted alongside
  // the plan creation. Session tokens have no known email yet — the
  // picker always renders for them, same as any first-time patient.
  //
  // Service-role client scoped to a single lookup by email — safe
  // because the invitation RPC (SECURITY DEFINER) already proved
  // the caller controls this inbox. If the lookup fails for any
  // reason we default to "no salary day known" and the picker
  // renders — never blocks the flow.
  let initialSalaryDay: number | null = null;
  if (resolved.kind === 'invitation') {
    try {
      const svc = createServiceClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY!,
        { auth: { persistSession: false } },
      );
      const { data: existingProfile } = await svc
        .from('profiles')
        .select('salary_day')
        .eq('email', resolved.row.email)
        .maybeSingle();
      const stored = existingProfile?.salary_day as number | null | undefined;
      if (isAllowedSalaryDay(stored)) initialSalaryDay = stored;
    } catch (err) {
      console.warn('[checkout] salary_day lookup failed (non-fatal)',
        err instanceof Error ? err.message : err);
    }
  }

  // ── viewed_at / scanned_at stamp ────────────────────────────────────────
  // Drives the practice-side "Viewed" lifecycle signal (the receptionist
  // wants to know the patient at least opened the link/scanned the QR).
  // Both RPCs are idempotent — they only write on the first call per
  // row — so re-loading the page does not overwrite the original
  // timestamp.
  //
  // CRITICAL: this MUST NOT block the patient. A transient RPC failure
  // (DB hiccup, the migration not yet applied) is non-fatal — we render
  // the form regardless. The promise is awaited so the request lifecycle
  // captures it, but any error is swallowed.
  try {
    const stampRpc = resolved.kind === 'invitation' ? 'stamp_invitation_viewed' : 'stamp_checkout_session_scanned';
    const { error: stampErr } = await supabase.rpc(stampRpc, { p_token: token });
    if (stampErr) {
      console.warn(`[checkout] ${stampRpc} failed (non-fatal)`, stampErr.message);
    }
  } catch (err) {
    console.warn(
      '[checkout] viewed/scanned stamp threw (non-fatal)',
      err instanceof Error ? err.message : err,
    );
  }

  // ── SA ID display for the session case ─────────────────────────────────
  // Decrypt + mask server-side only — CheckoutForm receives the masked
  // string as a display-only prop (e.g. "•••••••••0086") and renders the
  // field read-only. The plaintext never reaches a client-rendered prop;
  // initiateCheckout re-derives it server-side from the session row
  // itself when it writes profiles.sa_id_number, ignoring any client-
  // submitted value for a session-sourced token.
  let maskedSaId: string | null = null;
  if (resolved.kind === 'session') {
    try {
      maskedSaId = maskId(decryptId(resolved.row.sa_id_number));
    } catch (err) {
      console.error('[checkout] failed to decrypt session SA ID for display', err instanceof Error ? err.message : err);
      return <InvalidLinkCard reason="Couldn't load this checkout. Please try again in a moment." />;
    }
  }

  return (
    <div className="min-h-screen bg-[#FAFBFD]">
      <header className="bg-white border-b border-[#E5E9F0] sticky top-0 z-10">
        <div className="mx-auto max-w-md px-5 py-4 flex items-center justify-between">
          <span
            className="text-lg font-bold tracking-tight"
            style={{ fontFamily: 'var(--font-poppins), Poppins, system-ui, sans-serif' }}
          >
            <span style={{ color: '#13294B' }}>better</span>
            <span style={{ color: '#15A89E' }}>now</span>
          </span>
          <span className="text-[11px] uppercase tracking-[0.08em] font-medium text-[#7A8AA0]">
            Secure checkout
          </span>
        </div>
      </header>

      <main className="mx-auto max-w-md px-5 py-8 sm:py-10">
        <CheckoutForm
          token={token}
          email={resolved.kind === 'invitation' ? resolved.row.email : ''}
          practiceName={practiceName}
          totalAmount={Number(row.plan_total_amount)}
          invoiceNumber={row.invoice_number}
          practiceReference={row.practice_reference}
          initialSalaryDay={initialSalaryDay}
          prefilledSaId={maskedSaId}
          requireEmail={resolved.kind === 'session'}
          initiateCheckout={initiateCheckout}
          requestPhoneOtp={requestPhoneOtp}
          verifyPhoneOtp={verifyPhoneOtp}
        />
      </main>
    </div>
  );
}
