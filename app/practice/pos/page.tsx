import {
  checkDeviceStatus,
  unlockTill,
  issueCounterSession,
  expireCounterSession,
  getCounterSessionStage,
  acknowledgeCounterSession,
} from './actions';
import TillShell from './TillShell';

// ─── /practice/pos — counter QR bill issuance (device-gated) ──────────
//
// Deliberately NOT gated by requireConfirmedUser — this route is the
// kiosk model: a registered, unlocked TILL DEVICE is the access
// control, not a logged-in staff member. There is no server-side data
// fetch here at all (no practice_id, no provider list, no practice
// name) — the device secret lives in the browser's localStorage, which
// a server component cannot read, so EVERY practice-scoped read is
// deferred to the client-driven checkDeviceStatus call inside
// TillShell, and only ever returned once that call itself confirms
// 'unlocked'. See TillShell.tsx + lib/auth/tillDevice.ts.
//
// The manager screens that administer devices (app/practice/pos/
// devices) stay on normal per-user login, unchanged — this file is the
// ONLY /practice/* route whose auth model is different.

export default function PosPage() {
  return (
    <TillShell
      checkDeviceStatus={checkDeviceStatus}
      unlockTill={unlockTill}
      issueCounterSession={issueCounterSession}
      expireCounterSession={expireCounterSession}
      getCounterSessionStage={getCounterSessionStage}
      acknowledgeCounterSession={acknowledgeCounterSession}
    />
  );
}
