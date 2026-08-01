'use client';

import { useState, useTransition } from 'react';
import { StepShell, PrimaryButton } from '../_components/CheckoutChrome';

// Setting a password is a SECONDARY, skippable next step — the success
// confirmation above is the hero and must never be gated behind this.
// Skipping is safe: the account's email is already confirmed (the emailed
// checkout link proved possession), so "Forgot password" on /login always
// gets the patient back in, and the patient portal surfaces the passkey
// prompt post-login (a better durable credential for this cohort). A
// password here just makes the NEXT login one tap faster.

type Props = {
  email:            string;
  finalizePassword: (password: string)
                      => Promise<{ ok: true } | { ok: false; error: string }>;
};

const INPUT =
  'w-full rounded-xl border border-[#D8DEE8] bg-white px-3.5 py-3 text-base text-[#0F1F3A] placeholder:text-[#A3AEC2] outline-none transition-colors focus:border-[#15A89E] focus:ring-4 focus:ring-[#15A89E]/15';
const INPUT_ERR =
  'w-full rounded-xl border border-[#E07A7A] bg-white px-3.5 py-3 text-base text-[#0F1F3A] outline-none transition-colors focus:border-[#D14141] focus:ring-4 focus:ring-[#D14141]/15';

export default function PasswordSetForm({ email, finalizePassword }: Props) {
  const [password,        setPassword]        = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error,           setError]           = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 8)           { setError('Password must be at least 8 characters.'); return; }
    if (password !== confirmPassword)  { setError('Passwords don\'t match.'); return; }

    startTransition(async () => {
      const result = await finalizePassword(password);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      // Hard navigate to the patient portal — gives the proxy a clean
      // run with the fresh session.
      window.location.href = '/patient';
    });
  }

  return (
    <form onSubmit={handleSubmit}>
      <StepShell
        icon="shield"
        iconTone="teal"
        heading="Secure your account"
        subhead={`Optional — set a password for ${email} to make next time's login one tap.`}
        actions={
          <div className="space-y-3">
            <PrimaryButton type="submit" disabled={isPending}>
              {isPending ? 'Saving…' : 'Create password'}
            </PrimaryButton>
            <div className="flex justify-center">
              <a
                href="/patient"
                data-testid="checkout-done-skip"
                className="text-sm font-medium text-[#7A8AA0] underline underline-offset-2 hover:text-[#3A4B66]"
              >
                Skip for now
              </a>
            </div>
          </div>
        }
      >
        <div>
          <label htmlFor="password" className="block text-sm font-medium text-[#3A4B66] mb-1.5">
            New password
          </label>
          <input
            id="password"
            type="password"
            autoComplete="new-password"
            minLength={8}
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="At least 8 characters"
            className={error ? INPUT_ERR : INPUT}
          />
        </div>

        <div>
          <label htmlFor="confirmPassword" className="block text-sm font-medium text-[#3A4B66] mb-1.5">
            Confirm password
          </label>
          <input
            id="confirmPassword"
            type="password"
            autoComplete="new-password"
            minLength={8}
            required
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            placeholder="Type it again"
            className={error ? INPUT_ERR : INPUT}
          />
        </div>

        {error && (
          <div role="alert" className="rounded-xl bg-[#FCEAEA] border border-[#E07A7A] px-4 py-3 text-sm text-[#8A1F1F]">
            {error}
          </div>
        )}
      </StepShell>
    </form>
  );
}
