'use server';

import { createClient } from '@/lib/supabase/server';
import {
  hashTillSecret,
  generateRegistrationCode,
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
// any of these actions; only can_manage_practice can.

const REGISTRATION_CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes, one-time

// ─── Scoped manager guard ──────────────────────────────────────────────
//
// Mirrors createBill/issueCounterSession's practiceId-scope-selector
// pattern (not app/practice/members/actions.ts's older guardManager,
// which uses a bare .single() that throws for a brand-admin with N>=2
// active memberships) — a manager administering till devices is exactly
// the same "which of my practices" question createBill already had to
// solve.
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
    if (!membership) return { ok: false, error: 'You do not have permission to manage that practice.' };
    return { ok: true, userId: user.id, practiceId: membership.practice_id as string };
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

  const supabase = await createClient();

  const code      = generateRegistrationCode();
  const codeHash  = hashTillSecret(code);
  const expiresAt = new Date(Date.now() + REGISTRATION_CODE_TTL_MS).toISOString();

  const { error } = await supabase.from('till_device_registration_codes').insert({
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
  registeredAt:    string;
  revokedAt:       string | null;
  lastActivityAt:  string | null;
  unlockedAt:      string | null;
};

export async function listDevices(practiceId?: string): Promise<{ error: string | null; devices?: DeviceRow[] }> {
  const guard = await guardTillManager(practiceId);
  if (!guard.ok) return { error: guard.error };

  const supabase = await createClient();
  const { data, error } = await supabase
    .from('till_devices')
    .select('id, label, registered_at, revoked_at, last_activity_at, unlocked_at')
    .eq('practice_id', guard.practiceId)
    .order('registered_at', { ascending: false });
  if (error) return { error: error.message };

  return {
    error: null,
    devices: (data ?? []).map((d) => ({
      id:             d.id as string,
      label:          d.label as string | null,
      registeredAt:   d.registered_at as string,
      revokedAt:      d.revoked_at as string | null,
      lastActivityAt: d.last_activity_at as string | null,
      unlockedAt:     d.unlocked_at as string | null,
    })),
  };
}

// ─── revokeDevice ───────────────────────────────────────────────────────
//
// Immediate — the very next requireUnlockedDevice call for this device
// (any till action) rejects on revoked_at IS NOT NULL, even if it was
// mid-unlocked-session. No caching anywhere in that check.

export async function revokeDevice(deviceId: string): Promise<{ error: string | null }> {
  const guard = await guardTillManager();
  if (!guard.ok) return { error: guard.error };

  const supabase = await createClient();

  // Scope-check the target belongs to the manager's own practice before
  // touching it — the RLS UPDATE policy (is_practice_manager) is the
  // real enforcement, this is belt-and-braces so a wrong-practice id
  // reads as a clear error rather than a silent 0-row update.
  const { data: device } = await supabase
    .from('till_devices')
    .select('id, practice_id')
    .eq('id', deviceId)
    .maybeSingle();
  if (!device || (device.practice_id as string) !== guard.practiceId) {
    return { error: 'Device not found on your practice.' };
  }

  const { error } = await supabase
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

  const supabase = await createClient();

  const pinHash = hashTillSecret(pin);
  const { error: practiceErr } = await supabase
    .from('practices')
    .update({ till_pin_hash: pinHash })
    .eq('id', guard.practiceId);
  if (practiceErr) return { error: practiceErr.message };

  const { error: resetErr } = await supabase
    .from('till_devices')
    .update({ pin_attempts: 0, pin_locked_until: null })
    .eq('practice_id', guard.practiceId);
  if (resetErr) return { error: resetErr.message };

  return { error: null };
}

// ─── hasTillPin ─────────────────────────────────────────────────────────
//
// Lets the manager screen make the "no bills can be issued until a PIN
// exists" state obvious, without ever exposing the hash itself.

export async function hasTillPin(practiceId?: string): Promise<{ error: string | null; hasPin?: boolean }> {
  const guard = await guardTillManager(practiceId);
  if (!guard.ok) return { error: guard.error };

  const supabase = await createClient();
  const { data, error } = await supabase
    .from('practices')
    .select('till_pin_hash')
    .eq('id', guard.practiceId)
    .maybeSingle();
  if (error) return { error: error.message };
  return { error: null, hasPin: !!data?.till_pin_hash };
}
