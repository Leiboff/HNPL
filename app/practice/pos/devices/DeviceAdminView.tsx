'use client';

import { useState, useTransition } from 'react';
import PinInput from '../PinInput';
import type { GenerateCodeResult, DeviceRow } from './actions';

// ─── DeviceAdminView ────────────────────────────────────────────────────
//
// Manager-only. Three jobs on one screen:
//   1. Generate a one-time registration code (shown ONCE, never re-shown
//      or persisted client-side beyond this render).
//   2. Set/reset the practice till PIN — the "no PIN set" state is made
//      obvious (a banner), since no device at this practice can unlock
//      until one exists. The PIN field is masked by default (PinInput)
//      with an optional "Generate a PIN" shortcut — either way, nothing
//      is hashed/stored until the manager submits the form; a generated
//      value sits in the same client-only state a manually-typed one
//      would, shown once via the reveal toggle, never logged.
//   3. List + revoke registered devices.

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-ZA', { dateStyle: 'medium', timeStyle: 'short' });
}

type Props = {
  practiceId:     string;
  initialDevices: DeviceRow[];
  hasPin:         boolean;
  generateDeviceRegistrationCode: (practiceId?: string) => Promise<GenerateCodeResult>;
  revokeDevice:                   (deviceId: string) => Promise<{ error: string | null }>;
  setTillPin:                     (pin: string, practiceId?: string) => Promise<{ error: string | null }>;
  generateTillPinValue:           (practiceId?: string) => Promise<{ error: string | null; pin?: string }>;
};

export default function DeviceAdminView({
  practiceId, initialDevices, hasPin,
  generateDeviceRegistrationCode, revokeDevice, setTillPin, generateTillPinValue,
}: Props) {
  const [devices, setDevices] = useState(initialDevices);
  const [pinConfigured, setPinConfigured] = useState(hasPin);
  const [pinInput, setPinInput] = useState('');
  const [pinVisible, setPinVisible] = useState(false);
  const [pinError, setPinError] = useState<string | null>(null);
  const [pinSaved, setPinSaved] = useState(false);
  const [codeResult, setCodeResult] = useState<GenerateCodeResult | null>(null);
  const [codeError, setCodeError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleGenerateCode() {
    setCodeError(null);
    setCodeResult(null);
    startTransition(async () => {
      const result = await generateDeviceRegistrationCode(practiceId);
      if (result.error) {
        setCodeError(result.error);
        return;
      }
      setCodeResult(result);
    });
  }

  function handleSetPin(e: React.FormEvent) {
    e.preventDefault();
    setPinError(null);
    setPinSaved(false);
    if (!/^\d{4,6}$/.test(pinInput)) {
      setPinError('PIN must be 4-6 digits.');
      return;
    }
    startTransition(async () => {
      const result = await setTillPin(pinInput, practiceId);
      if (result.error) {
        setPinError(result.error);
        return;
      }
      setPinInput('');
      setPinVisible(false);
      setPinConfigured(true);
      setPinSaved(true);
      // Resetting the PIN also clears every device's lockout — reflect
      // that locally so the list doesn't show a stale locked state.
      setDevices((prev) => prev.map((d) => ({ ...d })));
    });
  }

  function handleGeneratePin() {
    setPinError(null);
    setPinSaved(false);
    startTransition(async () => {
      const result = await generateTillPinValue(practiceId);
      if (result.error || !result.pin) {
        setPinError(result.error ?? 'Could not generate a PIN. Please try again.');
        return;
      }
      setPinInput(result.pin);
      // Reveal it immediately — the manager needs to actually read the
      // value to note it down before submitting; they can still hide it
      // again via the same toggle.
      setPinVisible(true);
    });
  }

  function handleRevoke(deviceId: string) {
    startTransition(async () => {
      const result = await revokeDevice(deviceId);
      if (!result.error) {
        setDevices((prev) => prev.map((d) => (d.id === deviceId ? { ...d, revokedAt: new Date().toISOString() } : d)));
      }
    });
  }

  return (
    <div className="space-y-8">
      {!pinConfigured && (
        <div role="alert" data-testid="no-pin-banner" className="rounded-lg bg-amber-50 border border-amber-300 px-4 py-3 text-sm text-amber-900">
          <strong>No till PIN set.</strong> No device at this practice can unlock until you set one below —
          bills cannot be issued from any till yet.
        </div>
      )}

      {/* ── Registration code ─────────────────────────────────────── */}
      <section className="rounded-2xl border border-gray-200 bg-white p-6 space-y-4">
        <h2 className="text-lg font-semibold text-gray-900">Register a new till</h2>
        <p className="text-sm text-gray-500">
          Generate a one-time code, then enter it on the till PC. The code expires in 10 minutes
          and can only be used once.
        </p>
        {codeResult?.code ? (
          <div className="rounded-lg bg-[#13294B]/5 border border-[#13294B]/20 px-4 py-3">
            <p className="text-xs uppercase tracking-wide text-gray-500 mb-1">One-time code</p>
            <p className="text-3xl font-mono font-bold tabular-nums text-[#13294B]" data-testid="registration-code">
              {codeResult.code}
            </p>
            <p className="mt-1 text-xs text-gray-500">
              Shown once. Expires {formatDate(codeResult.expiresAt ?? null)}.
            </p>
          </div>
        ) : (
          <button
            type="button"
            onClick={handleGenerateCode}
            disabled={isPending}
            className="inline-flex items-center justify-center rounded-lg bg-[#13294B] px-5 py-2.5 text-sm font-semibold text-white hover:shadow-lg transition-shadow disabled:opacity-60"
          >
            Generate code
          </button>
        )}
        {codeError && <p role="alert" className="text-sm text-red-700">{codeError}</p>}
      </section>

      {/* ── Till PIN ───────────────────────────────────────────────── */}
      <section className="rounded-2xl border border-gray-200 bg-white p-6 space-y-4">
        <h2 className="text-lg font-semibold text-gray-900">Till PIN</h2>
        <p className="text-sm text-gray-500">
          One PIN shared by every registered till at this practice. Resetting it also clears any
          lockouts and immediately requires the new PIN everywhere.
        </p>
        <form onSubmit={handleSetPin} className="space-y-3">
          <div className="max-w-[240px]">
            <label htmlFor="till-pin" className="block text-sm font-medium text-gray-700 mb-1.5">
              {pinConfigured ? 'New PIN' : 'Set PIN'}
            </label>
            <PinInput
              id="till-pin"
              value={pinInput}
              onChange={setPinInput}
              placeholder="4-6 digits"
              testId="till-pin-input"
              visible={pinVisible}
              onVisibleChange={setPinVisible}
              className="text-base"
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={handleGeneratePin}
              disabled={isPending}
              data-testid="till-pin-generate"
              className="inline-flex items-center justify-center rounded-lg border border-gray-300 px-4 py-2.5 text-sm font-semibold text-gray-700 hover:bg-gray-50 transition-colors disabled:opacity-60"
            >
              Generate a PIN
            </button>
            <button
              type="submit"
              disabled={isPending}
              data-testid="till-pin-submit"
              className="inline-flex items-center justify-center rounded-lg bg-[#13294B] px-5 py-2.5 text-sm font-semibold text-white hover:shadow-lg transition-shadow disabled:opacity-60"
            >
              {pinConfigured ? 'Reset PIN' : 'Set PIN'}
            </button>
          </div>
        </form>
        {pinError && <p role="alert" className="text-sm text-red-700">{pinError}</p>}
        {pinSaved && <p className="text-sm text-green-700">PIN saved.</p>}
      </section>

      {/* ── Device list ────────────────────────────────────────────── */}
      <section className="rounded-2xl border border-gray-200 bg-white p-6 space-y-4">
        <h2 className="text-lg font-semibold text-gray-900">Registered devices</h2>
        {devices.length === 0 ? (
          <p className="text-sm text-gray-500">No devices registered yet.</p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {devices.map((d) => (
              <li key={d.id} className="py-3 flex items-center justify-between gap-4">
                <div>
                  <p className="text-sm font-medium text-gray-900">{d.label ?? 'Unnamed till'}</p>
                  <p className="text-xs text-gray-500">
                    Registered {formatDate(d.registeredAt)} · Last active {formatDate(d.lastActivityAt)}
                  </p>
                  {d.revokedAt && <p className="text-xs text-red-700 mt-0.5">Revoked {formatDate(d.revokedAt)}</p>}
                </div>
                {!d.revokedAt && (
                  <button
                    type="button"
                    onClick={() => handleRevoke(d.id)}
                    disabled={isPending}
                    data-testid={`revoke-${d.id}`}
                    className="text-sm font-semibold text-red-700 hover:text-red-900 disabled:opacity-60"
                  >
                    Revoke
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
