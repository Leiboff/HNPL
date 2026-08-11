// ─── describeDevice — friendly device label from a raw User-Agent ─────────
//
// till_devices.user_agent stores the raw UA captured at registration
// (migration 0089). Managers shouldn't have to read a raw UA string, so we
// derive a short, honest device label at DISPLAY time (not stored) — e.g.
// a Samsung Galaxy S23 sends "…Android 13; SM-S911B)…", which we surface as
// "Samsung SM-S911B (Android 13)".
//
// Best-effort by nature: modern browsers increasingly freeze/reduce the UA
// (Chrome on Android now often sends the literal model "K"), so when the
// model can't be recovered we degrade to the platform ("Android device",
// "iPhone", "Windows PC") rather than guessing. Pure + input-only so it's
// trivially unit-tested; the raw UA remains the source of truth in the DB.

/** Pull the model token + Android version out of an Android UA, if present. */
function androidModel(ua: string): { model: string; version: string | null } {
  // The device sits in the first parenthetical group:
  //   "(Linux; Android 13; SM-S911B)" or "(Linux; Android 13; SM-S911B Build/…)"
  const paren = ua.match(/\(([^)]*)\)/);
  const inner = paren ? paren[1] : ua;
  const parts = inner.split(';').map((s) => s.trim());

  const idx = parts.findIndex((p) => /^Android\s+[\d.]+/i.test(p));
  const version = idx >= 0 ? (parts[idx].match(/Android\s+([\d.]+)/i)?.[1] ?? null) : null;

  // The model is the segment right after "Android <version>", minus any
  // trailing "Build/…" the WebView form appends.
  let model = idx >= 0 && parts[idx + 1] ? parts[idx + 1] : '';
  model = model.replace(/\s*Build\/.*$/i, '').trim();

  return { model, version };
}

/**
 * A short, human-readable device description derived from a User-Agent.
 * Returns "Unknown device" for a null/blank/unrecognised UA — never throws.
 */
export function describeDevice(userAgent: string | null | undefined): string {
  const ua = (userAgent ?? '').trim();
  if (!ua) return 'Unknown device';

  if (/\biPhone\b/.test(ua)) return 'iPhone';
  if (/\biPad\b/.test(ua))   return 'iPad';
  if (/\biPod\b/.test(ua))   return 'iPod';

  if (/\bAndroid\b/i.test(ua)) {
    const { model, version } = androidModel(ua);
    const verSuffix = version ? ` (Android ${version})` : '';
    // "K" is Chrome's frozen/reduced Android model; "wv" marks a WebView —
    // neither identifies hardware, so fall back to the platform.
    if (!model || /^(K|wv)$/i.test(model)) return `Android device${verSuffix}`;
    const brand = /^SM-/i.test(model) ? 'Samsung ' : '';
    return `${brand}${model}${verSuffix}`;
  }

  if (/\bCrOS\b/.test(ua))                return 'Chromebook';
  if (/\bWindows NT\b/.test(ua))          return 'Windows PC';
  if (/(Macintosh|Mac OS X)/.test(ua))    return 'Mac';
  if (/\bLinux\b/.test(ua))               return 'Linux PC';

  return 'Unknown device';
}

// ─── deviceCode — short, stable, visually-distinct code from a device's id ─
//
// till_devices.id (UUID primary key) is the only column guaranteed unique
// per registration by construction — a manager can rename a device to any
// label (including a duplicate one) and two devices can share the same
// derived model (e.g. two identical till PCs), so label+model alone can't
// tell them apart. secret_hash is also unique, but it's the hashed
// credential itself — even a truncated slice of security material has no
// business appearing on a screen other staff can see over someone's
// shoulder. The id has neither problem: it carries no secret, and it
// already exists (Postgres mints it at INSERT), so no new column is
// needed.
//
// A UUID v4's last 6 hex chars carry 24 bits of its randomness — plenty to
// keep two devices at the same small practice visually distinct, and (since
// it's a stored id, not derived from mutable fields) it never changes
// across reloads or a rename.

export function deviceCode(id: string): string {
  const hex = id.replace(/-/g, '').slice(-6);
  return hex.toUpperCase();
}
