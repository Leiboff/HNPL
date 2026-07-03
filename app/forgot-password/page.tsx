import { Suspense } from 'react';
import ForgotPasswordForm from './ForgotPasswordForm';

// ─── /forgot-password ──────────────────────────────────────────────────
//
// Public request page for the password-reset flow. Role-agnostic — the
// same email + form works for patient, practice, and admin (whichever
// role owns the address). Enumeration-safe by design: the success
// state is identical whether the email matches an account or not.

export default function ForgotPasswordPage() {
  return (
    <div
      className="min-h-screen flex items-center justify-center px-4 py-12"
      style={{
        background: '#f7fbfb',
        backgroundImage: 'radial-gradient(58% 48% at 84% 0%, rgba(21,168,158,.12), transparent 70%), radial-gradient(48% 42% at 4% 90%, rgba(19,41,75,.07), transparent 70%)',
      }}
    >
      <div className="w-full max-w-md">
        <Suspense fallback={null}>
          <ForgotPasswordForm />
        </Suspense>
      </div>
    </div>
  );
}
