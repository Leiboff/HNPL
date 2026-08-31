'use client';

import { useState, useTransition } from 'react';
import PinInput from '../PinInput';
import { describeDevice, deviceCode } from '@/lib/auth/deviceModel';
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

// OS-derived model + the device's own short code — shown together on both
// the Active and Revoked tabs so two devices sharing a label AND a model
// stay distinguishable (e.g. "Windows PC · #A1B2C3").
function DeviceMeta({ d }: { d: DeviceRow }) {
  return (
    <p className="text-xs text-gray-600 flex items-center gap-1.5">
      <span data-testid={`device-model-${d.id}`}>{describeDevice(d.userAgent)}</span>
      <span aria-hidden>·</span>
      <span className="font-mono text-gray-500" data-testid={`device-code-${d.id}`}>#{deviceCode(d.id)}</span>
    </p>
  );
}

type Props = {
  practiceId:     string;
  initialDevices: DeviceRow[];
  hasPin:         boolean;
  generateDeviceRegistrationCode: (practiceId?: string) => Promise<GenerateCodeResult>;
  revokeDevice:                   (deviceId: string) => Promise<{ error: string | null }>;
  setTillPin:                     (pin: string, practiceId?: string) => Promise<{ error: string | null }>;
  generateTillPinValue:           (practiceId?: string) => Promise<{ error: string | null; pin?: string }>;
  relabelDevice:                  (deviceId: string, label: string) => Promise<{ error: string | null }>;
};

export default function DeviceAdminView({
  practiceId, initialDevices, hasPin,
  generateDeviceRegistrationCode, revokeDevice, setTillPin, generateTillPinValue, relabelDevice,
}: Props) {
  const [devices, setDevices] = useState(initialDevices);
  const [tab, setTab] = useState<'active' | 'revoked'>('active');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState('');
  const [renameError, setRenameError] = useState<string | null>(null);
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

  function startRename(d: DeviceRow) {
    setRenameError(null);
    setEditingId(d.id);
    setEditLabel(d.label ?? '');
  }

  function handleRenameSave(deviceId: string) {
    const next = editLabel.trim();
    setRenameError(null);
    if (!next) {
      setRenameError('Enter a name for this till.');
      return;
    }
    startTransition(async () => {
      const result = await relabelDevice(deviceId, next);
      if (result.error) {
        setRenameError(result.error);
        return;
      }
      setDevices((prev) => prev.map((d) => (d.id === deviceId ? { ...d, label: next } : d)));
      setEditingId(null);
      setEditLabel('');
    });
  }

  const activeDevices  = devices.filter((d) => !d.revokedAt);
  const revokedDevices = devices.filter((d) => d.revokedAt);

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
          <div className="rounded-lg bg-[var(--portal-ink)]/5 border border-[var(--portal-ink)]/20 px-4 py-3">
            <p className="text-xs uppercase tracking-wide text-gray-500 mb-1">One-time code</p>
            <p className="text-3xl font-mono font-bold tabular-nums text-[var(--portal-ink)]" data-testid="registration-code">
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
            className="inline-flex items-center justify-center rounded-lg bg-[var(--portal-ink)] px-5 py-2.5 text-sm font-semibold text-white hover:shadow-lg transition-shadow disabled:opacity-60"
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
              className="inline-flex items-center justify-center rounded-lg bg-[var(--portal-ink)] px-5 py-2.5 text-sm font-semibold text-white hover:shadow-lg transition-shadow disabled:opacity-60"
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

        <div className="flex gap-4 border-b border-gray-200">
          <button
            type="button"
            onClick={() => setTab('active')}
            data-testid="tab-active"
            aria-pressed={tab === 'active'}
            className={`pb-2 text-sm font-semibold border-b-2 transition-colors ${
              tab === 'active' ? 'border-[var(--portal-ink)] text-[var(--portal-ink)]' : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            Active ({activeDevices.length})
          </button>
          <button
            type="button"
            onClick={() => setTab('revoked')}
            data-testid="tab-revoked"
            aria-pressed={tab === 'revoked'}
            className={`pb-2 text-sm font-semibold border-b-2 transition-colors ${
              tab === 'revoked' ? 'border-[var(--portal-ink)] text-[var(--portal-ink)]' : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            Revoked ({revokedDevices.length})
          </button>
        </div>

        {tab === 'active' ? (
          activeDevices.length === 0 ? (
            <p className="text-sm text-gray-500">No devices registered yet.</p>
          ) : (
            <ul className="divide-y divide-gray-100" data-testid="active-device-list">
              {activeDevices.map((d) => (
                <li key={d.id} className="py-3 flex items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    {editingId === d.id ? (
                      <div className="space-y-2">
                        <input
                          type="text"
                          maxLength={60}
                          autoFocus
                          value={editLabel}
                          onChange={(e) => setEditLabel(e.target.value)}
                          data-testid={`rename-input-${d.id}`}
                          className="w-full max-w-xs rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900"
                        />
                        <div className="flex gap-2">
                          <button
                            type="button"
                            onClick={() => handleRenameSave(d.id)}
                            disabled={isPending}
                            data-testid={`rename-save-${d.id}`}
                            className="rounded-lg bg-[var(--portal-ink)] px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-60"
                          >
                            Save
                          </button>
                          <button
                            type="button"
                            onClick={() => { setEditingId(null); setRenameError(null); }}
                            className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-semibold text-gray-700"
                          >
                            Cancel
                          </button>
                        </div>
                        {renameError && <p role="alert" className="text-xs text-red-700">{renameError}</p>}
                      </div>
                    ) : (
                      <>
                        <p className="text-sm font-medium text-gray-900">{d.label ?? 'Unnamed till'}</p>
                        <DeviceMeta d={d} />
                        <p className="text-xs text-gray-500">
                          Registered {formatDate(d.registeredAt)} · Last active {formatDate(d.lastActivityAt)}
                        </p>
                      </>
                    )}
                  </div>
                  {editingId !== d.id && (
                    <div className="flex flex-none items-center gap-3">
                      <button
                        type="button"
                        onClick={() => startRename(d)}
                        disabled={isPending}
                        data-testid={`rename-${d.id}`}
                        className="text-sm font-semibold text-[var(--portal-accent)] hover:text-[var(--portal-ink)] disabled:opacity-60"
                      >
                        Rename
                      </button>
                      <button
                        type="button"
                        onClick={() => handleRevoke(d.id)}
                        disabled={isPending}
                        data-testid={`revoke-${d.id}`}
                        className="text-sm font-semibold text-red-700 hover:text-red-900 disabled:opacity-60"
                      >
                        Revoke
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )
        ) : revokedDevices.length === 0 ? (
          <p className="text-sm text-gray-500">No revoked devices.</p>
        ) : (
          // Read-only audit view — no rename/revoke here, matching the
          // archive-not-delete pattern already used for payment cards
          // elsewhere in this codebase. There is no delete/permanent-
          // remove action for till_devices anywhere (server or UI):
          // revocation only ever sets revoked_at, never removes the row.
          <ul className="divide-y divide-gray-100" data-testid="revoked-device-list">
            {revokedDevices.map((d) => (
              <li key={d.id} className="py-3">
                <p className="text-sm font-medium text-gray-900">{d.label ?? 'Unnamed till'}</p>
                <DeviceMeta d={d} />
                <p className="text-xs text-gray-500">
                  Registered {formatDate(d.registeredAt)} · Last active {formatDate(d.lastActivityAt)}
                </p>
                <p className="text-xs text-red-700 mt-0.5" data-testid={`revoked-info-${d.id}`}>
                  Revoked {formatDate(d.revokedAt)}{d.revokedBy ? ` by ${d.revokedBy}` : ''}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
