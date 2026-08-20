'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { normalizePhoneZA } from '@/lib/validation';
import { maskPhone } from '@/lib/patient/maskContact';
import EmptyState from '@/components/EmptyState';
import EditIconButton from '@/components/EditIconButton';
import ProfileFieldRow from '@/components/ProfileFieldRow';
import PhoneOtpStep from '@/app/_otp/PhoneOtpStep';

// ─── Phone — masked, verified, and re-verified on change ───────────────
//
// ─── WHAT CHANGED AND WHY ─────────────────────────────────────────────
//
// This field used to save a new number with a bare `.update({ phone })`.
// Because profiles.phone_verified_at is column-locked to the OTP path
// (0054 / 0065), the timestamp stayed set from the ORIGINAL number's
// verification — so the system believed an unverified number was verified,
// and lib/payments/dunningNotifications.ts (which SMSes profiles.phone with
// no verification check) delivered the patient's arrears reminders to it.
//
// Changing a number is now a three-state flow, and the OLD number stays
// authoritative throughout:
//
//   idle      → masked current number + its verification state
//   editing   → type the new number, "Send code" stages it
//   verifying → PhoneOtpStep for the STAGED number; success promotes it
//
// Nothing writes profiles.phone until the code checks out. Abandoning at any
// point — closing the tab, tapping Cancel — leaves the account on its
// previously-verified number, because the pending value simply never gets
// promoted. See ../account/phoneChangeActions.ts for the promotion.
//
// ─── THE OTP UI IS NOT REBUILT HERE ───────────────────────────────────
//
// PhoneOtpStep is the shared step already used by checkout and the organic
// signup gate: auto-send on mount, 30s resend cooldown, auto-submit on the
// sixth digit, and the coded-error vocabulary mapped to copy. It takes the
// server actions as callbacks, so this is a third caller rather than a
// second implementation. The 30s cooldown belongs to it and the real caps
// live in the RPCs — nothing here re-implements or relaxes any of them.
//
// Note the first send is PhoneOtpStep's job, not ours: it auto-sends on
// mount. `startPhoneChange` only stages. Sending from both would burn two of
// the five codes a patient gets per day for one change.
//
// ─── MASKED, STILL EDITABLE ───────────────────────────────────────────
//
// The DISPLAY is masked to the last four digits, matching the SA ID field
// beside it. Tapping Edit gives an empty input rather than the old number
// pre-filled: the task here is "what is your new number?", and pre-filling a
// value the patient must replace is friction, not a convenience.

type Props = {
  /** The current, VERIFIED account number. E.164, or null if none. */
  current:   string | null;
  /** A number awaiting verification, if a change is already in flight. */
  pending:   string | null;
  /** When profiles.phone was last verified — drives the state pill only. */
  verifiedAt: string | null;
  startPhoneChange:      (phoneRaw: string) => Promise<{ ok: true } | { ok: false; code: string }>;
  requestPhoneChangeOtp: () => Promise<{ ok: true } | { ok: false; code: string }>;
  verifyPhoneChangeOtp:  (code: string) => Promise<{ ok: true } | { ok: false; code: string }>;
  cancelPhoneChange:     () => Promise<{ ok: true } | { ok: false; code: string }>;
};

const inputCls =
  'rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 ' +
  'focus:border-[#15A89E] focus:outline-none focus:ring-1 focus:ring-[#15A89E]';

function startErrorCopy(code: string): string {
  switch (code) {
    case 'invalid_phone': return 'Enter a valid South African mobile number (e.g. 082 123 4567).';
    case 'same_number':   return 'That’s already your number — nothing to change.';
    case 'unauthenticated': return 'Your session expired. Please sign in again.';
    default:              return 'Something went wrong. Please try again.';
  }
}

/** Verification state, stated rather than implied. */
function StatePill({ verified }: { verified: boolean }) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-semibold"
      style={
        verified
          ? { background: 'rgba(21,168,158,.12)', color: '#0F766E' }
          : { background: 'rgba(200,132,28,.12)', color: '#8A5A11' }
      }
      data-testid={verified ? 'phone-state-verified' : 'phone-state-unverified'}
    >
      {verified ? (
        <svg width="9" height="9" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M5 10.5l3 3 7-7" />
        </svg>
      ) : null}
      {verified ? 'Verified' : 'Not verified'}
    </span>
  );
}

export default function PhoneField({
  current,
  pending,
  verifiedAt,
  startPhoneChange,
  requestPhoneChangeOtp,
  verifyPhoneChangeOtp,
  cancelPhoneChange,
}: Props) {
  // A change already in flight (staged on a previous visit) puts the field
  // straight into the verifying state — a pending change must be visible, not
  // something the patient has to rediscover.
  const [mode, setMode] = useState<'idle' | 'editing' | 'verifying'>(
    pending ? 'verifying' : 'idle',
  );
  const [draft,   setDraft]   = useState('');
  const [staged,  setStaged]  = useState<string | null>(pending);
  const [error,   setError]   = useState<string | null>(null);
  const [okMsg,   setOkMsg]   = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  function backToIdle() {
    setDraft('');
    setError(null);
    setMode('idle');
  }

  function onSendCode() {
    setError(null);
    setOkMsg(null);
    // Client-side pre-check with the SHARED validator — the server action
    // re-validates with the same one as the real gate.
    const raw = draft.trim();
    const normalized = raw ? normalizePhoneZA(raw) : null;
    if (!normalized) {
      setError('Enter a valid South African mobile number (e.g. 082 123 4567).');
      return;
    }
    startTransition(async () => {
      const r = await startPhoneChange(raw);
      if (!r.ok) { setError(startErrorCopy(r.code)); return; }
      setStaged(normalized);
      setMode('verifying');
    });
  }

  function onCancel() {
    setError(null);
    startTransition(async () => {
      await cancelPhoneChange();
      setStaged(null);
      backToIdle();
      router.refresh();
    });
  }

  // ── Verifying: hand off to the shared OTP step ───────────────────────
  if (mode === 'verifying' && staged) {
    return (
      <ProfileFieldRow icon="phone" label="Phone">
        <div data-testid="profile-phone-verifying">
          <div className="mb-3 rounded-xl px-3 py-2" style={{ background: 'rgba(200,132,28,.08)' }}>
            <p className="text-[12.5px] leading-[1.5]" style={{ color: '#8A5A11' }}>
              <span className="font-semibold">Verifying {maskPhone(staged)}.</span>{' '}
              Until you enter the code, {current ? `we'll keep using ${maskPhone(current)}` : 'no number is on your account'}.
            </p>
          </div>
          <PhoneOtpStep
            phoneDisplay={maskPhone(staged)}
            requestCode={requestPhoneChangeOtp}
            verifyCode={verifyPhoneChangeOtp}
            onVerified={() => {
              setStaged(null);
              setOkMsg('Number updated and verified.');
              setMode('idle');
              router.refresh();
            }}
            onChangeNumber={onCancel}
            // Plain body — the field is already inside a profile row, so the
            // step's default card chrome would be a card inside a card.
            shell={(body, actions) => (
              <div className="space-y-4">{body}{actions}</div>
            )}
          />
        </div>
      </ProfileFieldRow>
    );
  }

  return (
    <ProfileFieldRow
      icon="phone"
      label="Phone"
      action={
        mode === 'idle' ? (
          <EditIconButton
            label={current ? 'Change phone' : 'Add phone'}
            onClick={() => { setOkMsg(null); setMode('editing'); }}
            testId="profile-phone-edit"
          />
        ) : (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={backToIdle}
              disabled={isPending}
              className="text-xs text-gray-500 hover:underline disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onSendCode}
              disabled={isPending}
              data-testid="profile-phone-save"
              className="rounded-lg px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
              style={{ background: 'linear-gradient(135deg, #13294B 0%, #15A89E 145%)' }}
            >
              {isPending ? 'Sending…' : 'Send code'}
            </button>
          </div>
        )
      }
    >
      {mode === 'editing' ? (
        <input
          className={`${inputCls} w-full`}
          type="tel"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="New number, e.g. 082 000 0000"
          autoFocus
          data-testid="profile-phone-input"
        />
      ) : current ? (
        <div className="flex items-center gap-2">
          <p
            className="text-sm font-medium tabular-nums text-gray-800"
            data-testid="profile-phone-value"
          >
            {maskPhone(current)}
          </p>
          <StatePill verified={!!verifiedAt} />
        </div>
      ) : (
        <div data-testid="profile-phone-value">
          <EmptyState icon="field" title="No mobile number" inline>
            Add one so we can text you about a payment before it goes out.
          </EmptyState>
        </div>
      )}

      {mode === 'editing' && (
        <p className="mt-1.5 text-[11.5px]" style={{ color: '#A3B1C2' }}>
          We&rsquo;ll text a 6-digit code to the new number. Your current number stays in use
          until you enter it.
        </p>
      )}

      {error && <p className="mt-1.5 text-xs text-red-700" role="alert">{error}</p>}
      {okMsg && <p className="mt-1.5 text-xs text-emerald-700">{okMsg}</p>}
    </ProfileFieldRow>
  );
}
