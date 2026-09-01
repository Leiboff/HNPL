import crypto from 'crypto';
import { createClient as createServiceClient } from '@supabase/supabase-js';

// ─── Till/device auth — /practice/pos's parallel auth mechanism ───────────
//
// A registered till PC authenticates itself via a long-lived, PRACTICE-
// SCOPED device secret (stored in the browser's localStorage, never a
// cookie) instead of a normal Supabase user JWT. The secret ALONE is not
// sufficient to issue a bill — issuance additionally requires a same-day
// PIN unlock that hasn't gone idle. See migration 0088.
//
// Every helper here runs through the SERVICE-ROLE client — there is no
// user session anywhere in this path. Authorization is entirely "does
// this secret hash to a live, unrevoked till_devices row, and is that
// row currently unlocked" — mirrors how RLS resolves practice_id from an
// authenticated user elsewhere in the app, just resolved from a device
// row instead of a practice_members row.

const PEPPER_ENV = 'TILL_AUTH_PEPPER';

// Idle re-lock window. Shorter than InactivityGuard's 20-minute
// logged-in-staff default on purpose — this protects a SHARED physical
// device sitting in a space patients also occupy, not one person's
// personal account, so the bar for "walked away" is lower.
export const TILL_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

// PIN brute-force lockout — 5 wrong attempts (matches the phone-OTP
// attempts cap in migration 0052) locks the till for 15 minutes,
// rejecting even a subsequently-correct PIN until it elapses.
export const PIN_MAX_ATTEMPTS  = 5;
export const PIN_LOCKOUT_MS    = 15 * 60 * 1000;

function pepper(): string {
  const p = process.env[PEPPER_ENV];
  if (!p) {
    // Fail loudly, same posture as hashOtpCode — a missing pepper means
    // every hash collapses to the same unsalted SHA-256 digest.
    throw new Error(`${PEPPER_ENV} is not set`);
  }
  return p;
}

/**
 * SHA-256(value + pepper), hex-encoded. One shared helper for the three
 * till-auth secrets (registration code, device secret, practice PIN) —
 * they're all "prove knowledge of a value, hashed at rest" under the
 * same threat model, unlike e.g. the SA-ID encryption-vs-lookup key
 * split (which separates two DIFFERENT properties: decryptable
 * confidentiality vs. one-way linkability). Mirrors lib/sms/otp.ts's
 * hashOtpCode exactly, just generalized to one pepper env var for this
 * whole feature instead of three.
 */
export function hashTillSecret(value: string): string {
  return crypto.createHash('sha256').update(value + pepper()).digest('hex');
}

// ─── The PIN gets a slow, salted hash. The other two do not. ───────────
//
// THE DEFECT (audit 2026-09-01, F-14)
//
// practices.till_pin_hash was SHA-256(pin + pepper) over a 4-6 digit
// space. One GPU-second recovers every practice PIN in the table if the
// database and the pepper are ever exposed together, and unlike the two
// values above the PIN is long-lived — it persists until a manager
// rotates it, which in practice is never.
//
// WHY ONLY THE PIN CHANGES
//
// The other two secrets are looked up by hash: requireUnlockedDevice does
// `.eq('secret_hash', …)` and the registration RPC matches on code_hash.
// A per-row salt makes an equality lookup impossible, so those must stay
// deterministic — and they can, because their threat model is different.
// The device secret is 256 random bits, where a slow hash buys nothing a
// pepper does not. The registration code is short-lived, single-use, and
// (as of this same commit) rate-limited.
//
// The PIN is the one of the three that is COMPARED rather than looked up:
// unlockTill has already resolved the device, so it knows which practice's
// hash to check against. That is what makes a salt affordable here.
//
// FORMAT — `scrypt$N$r$p$<salt b64>$<hash b64>`, parameters stored inline
// so they can be raised later without invalidating existing rows.
//
// LEGACY — verifyTillPin still accepts a bare 64-char hex digest, which is
// what every PIN set before this migration looks like. Refusing them would
// lock every practice out of its own till on deploy. They upgrade the next
// time a manager sets a PIN; there is no way to upgrade one in place,
// because we never see the plaintext except at that moment.

const SCRYPT_N = 16384;  // 2^14 — ~50ms per hash, unnoticeable on an unlock
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;

export function hashTillPin(pin: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pin + pepper(), salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P,
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

/**
 * Constant-time verify against either format.
 *
 * Returns false rather than throwing on a malformed stored value: a PIN
 * check is an authentication decision, and "the stored hash looks wrong"
 * has to fail closed like any other mismatch.
 */
export function verifyTillPin(pin: string, stored: string | null | undefined): boolean {
  if (!stored) return false;

  if (!stored.startsWith('scrypt$')) {
    // Legacy: SHA-256(pin + pepper), hex. Compared in constant time all
    // the same — the format is weak, the comparison need not also be.
    const expected = Buffer.from(hashTillSecret(pin), 'utf8');
    const actual   = Buffer.from(stored, 'utf8');
    if (expected.length !== actual.length) return false;
    return crypto.timingSafeEqual(expected, actual);
  }

  const parts = stored.split('$');
  if (parts.length !== 6) return false;
  const [, nStr, rStr, pStr, saltB64, hashB64] = parts;
  const N = Number(nStr), r = Number(rStr), p = Number(pStr);
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;

  try {
    const salt     = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    if (salt.length === 0 || expected.length === 0) return false;
    const actual = crypto.scryptSync(pin + pepper(), salt, expected.length, { N, r, p });
    return crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

/** Cryptographically-random 8-digit code for device registration. */
export function generateRegistrationCode(): string {
  const n = crypto.randomInt(0, 100_000_000);
  return n.toString().padStart(8, '0');
}

/** Long random device secret — high-entropy on its own; hashed at rest
 * the same way as the other two for consistency, not because a 256-bit
 * random value needs pepper-assisted brute-force resistance. */
export function generateDeviceSecret(): string {
  return crypto.randomBytes(32).toString('hex');
}

/** Cryptographically-random 6-digit numeric till PIN — same
 * length/RNG convention as lib/sms/otp.ts's generateOtpCode
 * (crypto.randomInt is bias-free across [0, max), unlike
 * Math.random().toString().slice(...)). Numeric-only by design; this
 * function generates a candidate value only — it is NOT persisted here,
 * the manager still must submit it through setTillPin to hash + store
 * it, same two-step shape as a registration code being shown once. */
export function generateTillPin(): string {
  const n = crypto.randomInt(0, 1_000_000);
  return n.toString().padStart(6, '0');
}

function svc() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

// ─── requireUnlockedDevice ──────────────────────────────────────────────
//
// The one check every /practice/pos till action runs first. Collapses
// "never unlocked" / "unlocked on a previous calendar day" / "idle
// timeout" into a single 'locked' code — none of the three need
// different client handling, all three just mean "show the PIN screen
// again" (see the Build D report). 'revoked' and 'no_device' stay
// distinct: those are NOT "enter your PIN," they're "this till cannot
// be used at all."
//
// Calendar-day boundary is checked in UTC. That's deliberately NOT
// naive: South African business hours (SAST = UTC+2) never cross a UTC
// midnight — 00:00 UTC is 02:00 SAST, hours outside any till's actual
// operating window — so a UTC-day check can never spuriously re-lock a
// till mid-shift the way a wall-clock-native check picked without
// thought might.
//
// On success, refreshes last_activity_at (the sliding idle window) as
// part of the SAME check — every till action that calls this is itself
// "activity."

export type DeviceCheckResult =
  | { ok: true;  practiceId: string; deviceId: string }
  | { ok: false; code: 'no_device' | 'revoked' | 'locked'; error: string };

function isSameUtcDay(a: Date, b: Date): boolean {
  return a.getUTCFullYear() === b.getUTCFullYear()
      && a.getUTCMonth()    === b.getUTCMonth()
      && a.getUTCDate()     === b.getUTCDate();
}

export async function requireUnlockedDevice(deviceSecret: string): Promise<DeviceCheckResult> {
  if (!deviceSecret) return { ok: false, code: 'no_device', error: 'No device registered on this till.' };

  const client = svc();
  const secretHash = hashTillSecret(deviceSecret);

  const { data: device } = await client
    .from('till_devices')
    .select('id, practice_id, revoked_at, unlocked_at, last_activity_at')
    .eq('secret_hash', secretHash)
    .maybeSingle();

  if (!device) return { ok: false, code: 'no_device', error: 'This till is not registered. Please register it again.' };
  if (device.revoked_at) return { ok: false, code: 'revoked', error: 'This device has been revoked. Contact your practice manager.' };

  const now = new Date();
  const unlockedAt = device.unlocked_at ? new Date(device.unlocked_at as string) : null;
  const lastActivityAt = device.last_activity_at ? new Date(device.last_activity_at as string) : null;

  const neverUnlocked = !unlockedAt;
  const staleDay      = unlockedAt ? !isSameUtcDay(unlockedAt, now) : true;
  const idleTimedOut  = !lastActivityAt || (now.getTime() - lastActivityAt.getTime() > TILL_IDLE_TIMEOUT_MS);

  if (neverUnlocked || staleDay || idleTimedOut) {
    return { ok: false, code: 'locked', error: 'This till is locked. Enter the PIN to continue.' };
  }

  await client
    .from('till_devices')
    .update({ last_activity_at: now.toISOString() })
    .eq('id', device.id as string);

  return { ok: true, practiceId: device.practice_id as string, deviceId: device.id as string };
}
