import { redeemDeviceRegistrationCode } from '../actions';
import RegisterForm from './RegisterForm';

// ─── /practice/pos/register — till device registration ────────────────
//
// Anon-reachable, deliberately: a till PC has no user session before
// it has a device credential at all. No requireConfirmedUser, no
// practice-scoped data fetched or rendered here — the manager's own
// code-generation screen (app/practice/pos/devices) is what's gated by
// normal login + can_manage_practice.

export default function RegisterTillPage() {
  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-6">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <span className="text-lg font-semibold tracking-tight" style={{ fontFamily: 'var(--font-poppins), Poppins, system-ui, sans-serif' }}>
            <span style={{ color: '#13294B' }}>better</span><span style={{ color: '#15A89E' }}>now</span>
          </span>
          <p className="mt-2 text-sm text-gray-500">Register this till</p>
        </div>
        <RegisterForm redeemDeviceRegistrationCode={redeemDeviceRegistrationCode} />
      </div>
    </div>
  );
}
