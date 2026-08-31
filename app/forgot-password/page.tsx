import { Suspense } from 'react';
import ForgotPasswordForm from './ForgotPasswordForm';
import AuthSurface from '@/app/_components/AuthSurface';

// ─── /forgot-password ──────────────────────────────────────────────────
//
// Public request page for the password-reset flow. Role-agnostic — the
// same email + form works for patient, practice, and admin (whichever
// role owns the address). Enumeration-safe by design: the success
// state is identical whether the email matches an account or not.
//
// On the shared auth surface: this screen is reached by one tap from the
// email sign-in view of /login, and a white card on the other side of
// that tap reads as having left the app.

export default function ForgotPasswordPage() {
  return (
    <AuthSurface centred>
      <Suspense fallback={null}>
        <ForgotPasswordForm />
      </Suspense>
    </AuthSurface>
  );
}
