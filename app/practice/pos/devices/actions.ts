'use server';

import { createClient } from '@/lib/supabase/server';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import {
  hashTillSecret,
  generateRegistrationCode,
  generateTillPin,
} from '@/lib/auth/tillDevice';

// ─── Till device administration — manager-gated, normal login ─────────────
//
// Generating registration codes, revoking devices, and setting the till
// PIN are ALL manager actions on the caller's own authenticated Supabase
// session — same auth model as every other manager action in this
// codebase (app/practice/members/actions.ts's guardManager, gated on
// can_manage_practice). This file does NOT touch the device-auth
// mechanism itself (lib/auth/tillDevice.ts) — it only administers the
// rows that mechanism reads. A biller who can issue bills cannot reach
// any of these actions; only can_manage_practice OR brand-admin
// authority over the practice (below) can.
//
// Data reads/writes below go through the SERVICE-ROLE client, guarded
// solely by guardTillManager() — mirroring app/brand/actions.ts's
// TeamSection actions, which face the exact same "per-practice manager
// OR brand-admin" bimodal authority and made the same choice: RLS
// (is_practice_manager) only recognises practice_members, so a brand-
// admin-only caller (a practice_group_members row with no matching
// practice_members row on this specific branch) would pass the app-
// level guard but then have every authenticated-client query silently
// blocked by RLS. till_devices/till_device_registration_codes' RLS
// (migration 0088) is untouched by this — is_practice_manager() stays
// exactly as narrow as it always was for every OTHER table it gates.

const REGISTRATION_CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes, one-time

function svc() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}

// ─── Scoped manager guard ──────────────────────────────────────────────
//
// Mirrors createBill/issueCounterSession's practiceId-scope-selector
// pattern (not app/practice/members/actions.ts's older guardManager,
// which uses a bare .single() that throws for a brand-admin with N>=2
// active memberships) — a manager administering till devices is exactly
// the same "which of my practices" question createBill already had to
// solve.
//
// Brand-admin fallback: when the caller has no (or an insufficiently
// privileged) practice_members row on this SPECIFIC practice, fall back
// to checking practice_group_members on the practice's own brand —
// exactly app/brand/actions.ts's guardBrandAdminOfPractice, resolving
// group_id via service-role first (RLS on practices is relationship-
// scoped, so the caller's own session client would silently return null
// for a practice they can't already see through practice_members,
// conflating "wrong group" with "no such practice").
type GuardOk  = { ok: true;  userId: string; practiceId: string };
type GuardErr = { ok: false; error: string };

async function guardTillManager(practiceId?: string): Promise<GuardOk | GuardErr> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: 'Session expired. Please log in again.' };

  if (practiceId) {
    const { data: membership } = await supabase
      .from('practice_members')
      .select('practice_id')
      .eq('user_id',             user.id)
      .eq('practice_id',         practiceId)
      .eq('active',              true)
      .eq('can_manage_practice', true)
      .maybeSingle();
    if (membership) return { ok: true, userId: user.id, practiceId: membership.practice_id as string };

    const { data: practice } = await svc()
      .from('practices')
      .select('group_id')
      .eq('id', practiceId)
      .maybeSingle();
    if (practice?.group_id) {
      const { data: brandMembership } = await supabase
        .from('practice_group_members')
        .select('user_id')
        .eq('group_id', practice.group_id as string)
        .eq('user_id',  user.id)
        .eq('active',   true)
        .maybeSingle();
      if (brandMembership) return { ok: true, userId: user.id, practiceId };
    }

    return { ok: false, error: 'You do not have permission to manage that practice.' };
  }

  const { data: memberships } = await supabase
    .from('practice_members')
    .select('practice_id, created_at')
    .eq('user_id',             user.id)
    .eq('active',              true)
    .eq('can_manage_practice', true)
    .order('created_at', { ascending: true })
    .limit(1);
  if (!memberships || memberships.length === 0) {
    return { ok: false, error: 'You do not have permission to manage any practice.' };
  }
  return { ok: true, userId: user.id, practiceId: memberships[0].practice_id as string };
}

// ─── generateDeviceRegistrationCode ────────────────────────────────────

export type GenerateCodeResult =
  | { error: string; code?: undefined; expiresAt?: undefined }
  | { error: null; code: string; expiresAt: string };

export async function generateDeviceRegistrationCode(practiceId?: string): Promise<GenerateCodeResult> {
  const guard = await guardTillManager(practiceId);
  if (!guard.ok) return { error: guard.error };

  const code = generateRegistrationCode();
  let codeHash: string;
  try {
    codeHash = hashTillSecret(code);
  } catch {
    // hashTillSecret throws if TILL_AUTH_PEPPER isn't configured in this
    // environment (lib/auth/tillDevice.ts's pepper()) — a real deploy-
    // config gap this exact call hit in production (uncaught, it crashed
    // the whole Server Action with no error boundary in the /practice
    // route tree to catch it). Same posture as issueCounterSession's
    // encryptId try/catch: fail into a clear, actionable error instead
    // of an unhandled throw.
    return { error: 'Server configuration error — please contact support.' };
  }
  const expiresAt = new Date(Date.now() + REGISTRATION_CODE_TTL_MS).toISOString();

  const { error } = await svc().from('till_device_registration_codes').insert({
    practice_id: guard.practiceId,
    code_hash:   codeHash,
    created_by:  guard.userId,
    expires_at:  expiresAt,
  });
  if (error) return { error: error.message };

  // Plaintext returned ONCE, to the manager's own screen — never
  // persisted, never logged.
  return { error: null, code, expiresAt };
}

// ─── listDevices ────────────────────────────────────────────────────────

export type DeviceRow = {
  id:              string;
  label:           string | null;
  userAgent:       string | null;
  registeredAt:    string;
  revokedAt:       string | null;
  lastActivityAt:  string | null;
  unlockedAt:      string | null;
};

export async function listDevices(practiceId?: string): Promise<{ error: string | null; devices?: DeviceRow[] }> {
  const guard = await guardTillManager(practiceId);
  if (!guard.ok) return { error: guard.error };

  const { data, error } = await svc()
    .from('till_devices')
    .select('id, label, user_agent, registered_at, revoked_at, last_activity_at, unlocked_at')
    .eq('practice_id', guard.practiceId)
    .order('registered_at', { ascending: false });
  if (error) return { error: error.message };

  return {
    error: null,
    devices: (data ?? []).map((d) => ({
      id:             d.id as string,
      label:          d.label as string | null,
      userAgent:      d.user_agent as string | null,
      registeredAt:   d.registered_at as string,
      revokedAt:      d.revoked_at as string | null,
      lastActivityAt: d.last_activity_at as string | null,
      unlockedAt:     d.unlocked_at as string | null,
    })),
  };
}

// ─── relabelDevice ────────────────────────────────────────────────────────
//
// Rename a registered till. Same resolve-then-guard scoping as revokeDevice
// (resolve the device's OWN practice via service-role first, then guard
// against THAT practice) so a brand-admin can rename a device on a branch
// they administer only via practice_group_members, and no manager can touch
// another practice's device. Empty name is rejected — a till must stay
// named once registered.

const MAX_LABEL_LEN = 60;

export async function relabelDevice(deviceId: string, label: string): Promise<{ error: string | null }> {
  const cleanLabel = (label ?? '').trim();
  if (!cleanLabel) return { error: 'Enter a name for this till.' };
  if (cleanLabel.length > MAX_LABEL_LEN) {
    return { error: `Device name must be ${MAX_LABEL_LEN} characters or fewer.` };
  }

  const { data: device } = await svc()
    .from('till_devices')
    .select('id, practice_id')
    .eq('id', deviceId)
    .maybeSingle();
  if (!device) return { error: 'Device not found.' };

  const guard = await guardTillManager(device.practice_id as string);
  if (!guard.ok) return { error: guard.error };

  const { error } = await svc()
    .from('till_devices')
    .update({ label: cleanLabel })
    .eq('id', deviceId);
  if (error) return { error: error.message };
  return { error: null };
}

// ─── revokeDevice ───────────────────────────────────────────────────────
//
// Immediate — the very next requireUnlockedDevice call for this device
// (any till action) rejects on revoked_at IS NOT NULL, even if it was
// mid-unlocked-session. No caching anywhere in that check.
//
// Resolves the device's OWN practice_id first (service-role — same
// "resolve before checking" reasoning as guardTillManager's brand
// fallback: an authenticated-client read would silently return null for
// a device this caller can't already see, conflating "someone else's
// device" with "no such device"), then guards SCOPED to that practice —
// this is what lets a brand-admin (no practice_members row at all)
// revoke a device on a branch they administer only via
// practice_group_members.

export async function revokeDevice(deviceId: string): Promise<{ error: string | null }> {
  const { data: device } = await svc()
    .from('till_devices')
    .select('id, practice_id')
    .eq('id', deviceId)
    .maybeSingle();
  if (!device) return { error: 'Device not found.' };

  const guard = await guardTillManager(device.practice_id as string);
  if (!guard.ok) return { error: guard.error };

  const { error } = await svc()
    .from('till_devices')
    .update({ revoked_at: new Date().toISOString(), revoked_by: guard.userId })
    .eq('id', deviceId);
  if (error) return { error: error.message };
  return { error: null };
}

// ─── setTillPin ─────────────────────────────────────────────────────────
//
// A practice with no PIN set cannot unlock ANY device (till_pin_hash
// starts NULL). Resetting the PIN is also the recovery path for a
// forgotten or possibly-compromised PIN — no separate rotation feature.
// Changing it also clears pin_attempts/pin_locked_until on every device
// at the practice, so a manager fixing a locked-out till and rotating
// the PIN is one action, not two.

export async function setTillPin(pin: string, practiceId?: string): Promise<{ error: string | null }> {
  if (!/^\d{4,6}$/.test(pin)) {
    return { error: 'PIN must be 4-6 digits.' };
  }

  const guard = await guardTillManager(practiceId);
  if (!guard.ok) return { error: guard.error };

  let pinHash: string;
  try {
    pinHash = hashTillSecret(pin);
  } catch {
    // See generateDeviceRegistrationCode's identical try/catch — same
    // TILL_AUTH_PEPPER misconfiguration, same fix.
    return { error: 'Server configuration error — please contact support.' };
  }
  const { error: practiceErr } = await svc()
    .from('practices')
    .update({ till_pin_hash: pinHash })
    .eq('id', guard.practiceId);
  if (practiceErr) return { error: practiceErr.message };

  const { error: resetErr } = await svc()
    .from('till_devices')
    .update({ pin_attempts: 0, pin_locked_until: null })
    .eq('practice_id', guard.practiceId);
  if (resetErr) return { error: resetErr.message };

  return { error: null };
}

// ─── generateTillPinValue ───────────────────────────────────────────────
//
// Pure generation — does NOT persist anything. Manager-gated (same
// guard as every other action here), returns a candidate 6-digit PIN
// for the manager to review (masked/revealed client-side) and then
// submit through setTillPin, which is the only thing that actually
// hashes + stores it. Mirrors generateDeviceRegistrationCode's "shown
// once, never persisted in plaintext" shape.

export async function generateTillPinValue(practiceId?: string): Promise<{ error: string | null; pin?: string }> {
  const guard = await guardTillManager(practiceId);
  if (!guard.ok) return { error: guard.error };
  return { error: null, pin: generateTillPin() };
}

// ─── hasTillPin ─────────────────────────────────────────────────────────
//
// Lets the manager screen make the "no bills can be issued until a PIN
// exists" state obvious, without ever exposing the hash itself.

export async function hasTillPin(practiceId?: string): Promise<{ error: string | null; hasPin?: boolean }> {
  const guard = await guardTillManager(practiceId);
  if (!guard.ok) return { error: guard.error };

  const { data, error } = await svc()
    .from('practices')
    .select('till_pin_hash')
    .eq('id', guard.practiceId)
    .maybeSingle();
  if (error) return { error: error.message };
  return { error: null, hasPin: !!data?.till_pin_hash };
}
