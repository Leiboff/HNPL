'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { TILL_DEVICE_SECRET_KEY } from './tillStorage';
import PinInput from './PinInput';
import CounterSessionForm from './CounterSessionForm';
import type {
  DeviceStatus,
  ProviderOption,
  IssueCounterSessionResult,
  CounterSessionStage,
} from './actions';

// ─── TillShell ──────────────────────────────────────────────────────────
//
// The ONLY place /practice/pos reads localStorage or calls
// checkDeviceStatus. Renders exactly one of five states:
//   loading    — before the initial check resolves. No practice data.
//   no_device  — routes to /practice/pos/register. No practice data.
//   revoked    — dead end, contact a manager. No practice data.
//   locked     — PIN entry. No practice data (the PIN screen never
//                needs to know which practice it belongs to).
//   unlocked   — renders CounterSessionForm with the practice data THIS
//                check call returned — nothing fetched separately.
//
// Known device-auth error strings (from lib/auth/tillDevice.ts's
// requireUnlockedDevice, threaded through unchanged by every action)
// trigger a background re-check rather than string-matched UI branching
// inside CounterSessionForm itself — that component stays unaware of
// the device-auth mechanism entirely, same as before this feature.

type Props = {
  checkDeviceStatus: (deviceSecret: string | null) => Promise<DeviceStatus>;
  unlockTill:        (deviceSecret: string, pin: string) => Promise<{ error: string | null }>;
  issueCounterSession: (data: {
    deviceSecret: string;
    billAmount:   number;
    saIdNumber:   string;
    cellNumber?:  string;
    providerId:   string;
  }) => Promise<IssueCounterSessionResult>;
  expireCounterSession: (deviceSecret: string, token: string, opts?: { force?: boolean }) => Promise<{ error: string | null }>;
  getCounterSessionStage: (deviceSecret: string, token: string) => Promise<{ error: string | null; stage?: CounterSessionStage }>;
  acknowledgeCounterSession: (deviceSecret: string, token: string) => Promise<{ error: string | null }>;
};

const DEVICE_AUTH_ERROR_MESSAGES = new Set([
  'This till is not registered. Please register it again.',
  'This device has been revoked. Contact your practice manager.',
  'This till is locked. Enter the PIN to continue.',
]);

export default function TillShell({
  checkDeviceStatus, unlockTill,
  issueCounterSession, expireCounterSession, getCounterSessionStage, acknowledgeCounterSession,
}: Props) {
  const router = useRouter();
  const [status, setStatus] = useState<DeviceStatus | null>(null);
  const [pin, setPin] = useState('');
  const [pinError, setPinError] = useState<string | null>(null);
  const [unlocking, setUnlocking] = useState(false);
  // Plain state, not a ref: withDeviceRecovery's closures are rebuilt
  // every render (created inline in JSX below), so they always close
  // over the current value here — no ref needed, and reading it later
  // from an event handler can't trip the react-hooks/refs rule.
  const [deviceSecret, setDeviceSecret] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const secret = window.localStorage.getItem(TILL_DEVICE_SECRET_KEY);
    setDeviceSecret(secret);
    const result = await checkDeviceStatus(secret);
    setStatus(result);
  }, [checkDeviceStatus]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (status?.state === 'no_device') {
      router.replace('/practice/pos/register');
    }
  }, [status, router]);

  function handleUnlock(e: React.FormEvent) {
    e.preventDefault();
    setPinError(null);
    const secret = deviceSecret;
    if (!secret) return;
    setUnlocking(true);
    unlockTill(secret, pin).then((result) => {
      setUnlocking(false);
      if (result.error) {
        setPinError(result.error);
        return;
      }
      setPin('');
      refresh();
    });
  }

  // Wraps a device action so a device-auth rejection (locked/revoked/
  // no_device — the till losing authority mid-use, e.g. idle timeout or
  // a manager revoking it) triggers a re-check and screen swap, instead
  // of CounterSessionForm having to know anything about device auth.
  function withDeviceRecovery<A extends unknown[], R extends { error: string | null }>(
    fn: (secret: string, ...args: A) => Promise<R>,
  ): (...args: A) => Promise<R> {
    return async (...args: A) => {
      const secret = deviceSecret;
      if (!secret) {
        await refresh();
        return { error: 'No device registered on this till.' } as R;
      }
      const result = await fn(secret, ...args);
      if (result.error && DEVICE_AUTH_ERROR_MESSAGES.has(result.error)) {
        refresh();
      }
      return result;
    };
  }

  if (!status || status.state === 'no_device') {
    // no_device redirects via the effect above; render nothing while
    // that happens rather than flashing practice-shaped UI.
    return <div className="min-h-screen bg-gray-50" />;
  }

  if (status.state === 'revoked') {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center px-6">
        <div className="w-full max-w-sm rounded-2xl border border-gray-200 bg-white p-8 text-center space-y-3">
          <h1 className="text-xl font-semibold text-gray-900">This till has been revoked</h1>
          <p className="text-sm text-gray-500">Contact your practice manager to register it again.</p>
        </div>
      </div>
    );
  }

  if (status.state === 'locked') {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center px-6">
        <form onSubmit={handleUnlock} className="w-full max-w-sm rounded-2xl border border-gray-200 bg-white p-8 space-y-5">
          <div className="text-center">
            <h1 className="text-xl font-semibold text-gray-900">Till locked</h1>
            <p className="mt-1 text-sm text-gray-500">Enter the practice PIN to continue.</p>
          </div>
          <PinInput
            value={pin}
            onChange={setPin}
            placeholder="PIN"
            testId="till-pin-input"
            className="py-3 text-lg"
          />
          {pinError && (
            <div role="alert" className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-800">
              {pinError}
            </div>
          )}
          <button
            type="submit"
            disabled={unlocking || pin.length < 4}
            className="w-full inline-flex items-center justify-center rounded-lg bg-[#13294B] px-6 py-3 text-sm font-semibold text-white hover:shadow-lg transition-shadow disabled:opacity-60"
          >
            {unlocking ? 'Unlocking…' : 'Unlock'}
          </button>
        </form>
      </div>
    );
  }

  // status.state === 'unlocked' — the only branch that ever sees
  // practice-scoped data, sourced entirely from THIS response.
  const { practiceName, providers } = status as { practiceName: string; providers: ProviderOption[] };

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200">
        <div className="mx-auto max-w-3xl px-6 py-4">
          <span className="text-lg font-semibold tracking-tight" style={{ fontFamily: 'var(--font-poppins), Poppins, system-ui, sans-serif' }}>
            <span style={{ color: '#13294B' }}>better</span><span style={{ color: '#15A89E' }}>now</span>
          </span>
          <span className="ml-2 text-sm text-gray-400">— {practiceName} · Counter</span>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-6 py-12">
        <div className="mb-8">
          <h1 className="text-3xl font-semibold text-gray-900">Counter checkout</h1>
          <p className="mt-2 text-gray-500">
            Enter the amount and the patient&apos;s SA ID number. They scan the QR with their own
            phone to finish signing up and pay — nothing is typed into this screen beyond the
            amount and ID.
          </p>
        </div>

        <CounterSessionForm
          providers={providers}
          issueCounterSession={withDeviceRecovery(
            (secret, data: Omit<Parameters<Props['issueCounterSession']>[0], 'deviceSecret'>) =>
              issueCounterSession({ ...data, deviceSecret: secret }),
          )}
          expireCounterSession={withDeviceRecovery(expireCounterSession)}
          getCounterSessionStage={withDeviceRecovery(getCounterSessionStage)}
          acknowledgeCounterSession={withDeviceRecovery(acknowledgeCounterSession)}
        />
      </main>
    </div>
  );
}
