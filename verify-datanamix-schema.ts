/**
 * Probes Datanamix Profile Plus ID and Photo Verification.
 *
 *   pnpm tsx verify-datanamix-schema.ts                 # SANDBOX, no auth needed
 *   pnpm tsx verify-datanamix-schema.ts <ID>            # SANDBOX, your ID
 *   DNX_LIVE=1 pnpm tsx verify-datanamix-schema.ts <ID> # LIVE, needs OAuth creds
 *
 * SANDBOX requires NO credentials — per Datanamix's own spec, sandbox
 * requests need no OAuth and any Authorization header is ignored. So this
 * runs today, before you have an account.
 *
 * LIVE needs DATANAMIX_CLIENT_ID + DATANAMIX_CLIENT_SECRET (OAuth2
 * client-credentials against /v1/oauth/token).
 *
 * Answers the questions the adapter depends on:
 *   - is ImageBase64 real base64, and how big?
 *   - exact strings in DeceasedStatus / IDNumberBlocked / HasImage /
 *     HanisIDMatch / IDNumberMatchStatus
 *   - what OfflineIndicator + LastUpdated say (the staleness window)
 *   - does ResponseCode track HTTP status, or diverge from it?
 *   - is X-Signature actually sent?
 */

const BASE = 'https://api.datanamix.com';
const ENDPOINT = `${BASE}/v1/id-verification/ProfilePlusIDVerificationAndPhoto`;
const TOKEN_URL = `${BASE}/v1/oauth/token`;

// Datanamix's own documented sandbox ID (Amelia Naidoo).
const SANDBOX_ID = '8402181202086';

const live = process.env.DNX_LIVE === '1';
const idNumber = (process.argv[2] ?? SANDBOX_ID).replace(/\s+/g, '');

if (!/^\d{13}$/.test(idNumber)) {
  console.error('ID must be 13 digits.');
  process.exit(1);
}
if (live && (!process.env.DATANAMIX_CLIENT_ID || !process.env.DATANAMIX_CLIENT_SECRET)) {
  console.error('LIVE needs DATANAMIX_CLIENT_ID and DATANAMIX_CLIENT_SECRET.');
  process.exit(1);
}

/** Redacts the portrait and masks the ID so output is safe to share. */
function safe(obj: unknown): unknown {
  return JSON.parse(JSON.stringify(obj, (key, value) => {
    if ((key === 'ImageBase64' || key === 'PDFReport') && typeof value === 'string') {
      return `<${value.length} chars — present>`;
    }
    if ((key === 'IDNumber' || key === 'ReportName') && typeof value === 'string') {
      return value.replace(/\d{7,13}/g, (m) => `${m.slice(0, 6)}${'*'.repeat(m.length - 6)}`);
    }
    return value;
  }));
}

async function getToken(): Promise<string> {
  const body = new URLSearchParams({
    grant_type:    'client_credentials',
    client_id:     process.env.DATANAMIX_CLIENT_ID!,
    client_secret: process.env.DATANAMIX_CLIENT_SECRET!,
  });
  const res = await fetch(TOKEN_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`token HTTP ${res.status}: ${text.slice(0, 300)}`);
  const json = JSON.parse(text);
  const token = json.access_token ?? json.accessToken ?? json.token;
  if (!token) throw new Error(`no access_token in token response: ${text.slice(0, 300)}`);
  console.log(`  token acquired (expires_in: ${json.expires_in ?? 'not stated'})`);
  return token;
}

function show(label: string, value: unknown) {
  const v = value === undefined ? 'ABSENT' : JSON.stringify(value);
  console.log(`  ${label.padEnd(24)}: ${v}${value === undefined ? '' : `   (typeof ${typeof value})`}`);
}

async function main() {
  console.log(`\nEnvironment : ${live ? 'LIVE' : 'SANDBOX'}`);
  console.log(`ID          : ${idNumber.slice(0, 6)}*******`);
  if (!live && idNumber === SANDBOX_ID) console.log("(Datanamix's own documented sandbox ID)");

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (live) {
    console.log('\n─── OAuth ──────────────────────────────────────────────────');
    headers.Authorization = `Bearer ${await getToken()}`;
  }

  console.log('\n─── Profile Plus ID and Photo ──────────────────────────────');
  const res = await fetch(ENDPOINT, {
    method:  'POST',
    headers,
    body: JSON.stringify({
      IDNumber:        idNumber,
      OutputFormat:    'JSON',
      ClientReference: 'schema-verification',
      EnvironmentType: live ? 'LIVE' : 'SANDBOX',
    }),
  });

  console.log(`HTTP ${res.status} ${res.statusText}`);
  const sig = res.headers.get('x-signature');
  console.log(`X-Signature header: ${sig ? `present (${sig.length} chars)` : 'ABSENT'}`);

  const text = await res.text();
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text);
  } catch {
    console.log(text.slice(0, 1500));
    return;
  }
  console.log(JSON.stringify(safe(json), null, 2));

  const result = json.Result as Record<string, unknown> | null | undefined;
  const idv = result?.IDVerificationResults as Record<string, unknown> | undefined;
  const bio = result?.BiometricVerificationResults as Record<string, unknown> | undefined;

  console.log('\n─── ENVELOPE (route on ResponseCode, NOT HTTP status) ──────');
  show('Success', json.Success);
  show('ResponseCode', json.ResponseCode);
  show('Messages', json.Messages);
  if (typeof json.ResponseCode === 'number' && json.ResponseCode !== res.status) {
    console.log(`  ** ResponseCode ${json.ResponseCode} != HTTP ${res.status} — they diverge.`);
    console.log('     Confirms the adapter must branch on ResponseCode only.');
  }

  if (!result) {
    console.log('\n  No Result block. Nothing further to inspect.');
    return;
  }

  console.log('\n─── PORTRAIT (feeds Didit portrait_image) ──────────────────');
  const img = bio?.ImageBase64;
  show('HasImage', bio?.HasImage);
  show('HanisIDMatch', bio?.HanisIDMatch);
  if (typeof img === 'string') {
    const looksBase64 = /^[A-Za-z0-9+/=\r\n]+$/.test(img) && img.length > 100;
    console.log(`  ImageBase64 length      : ${img.length} chars (~${Math.floor(img.length * 0.75)} bytes)`);
    console.log(`  looks like real base64  : ${looksBase64 ? 'yes' : 'NO — likely a placeholder'}`);
    if (!looksBase64) console.log(`  literal value           : ${JSON.stringify(img.slice(0, 80))}`);
    const cap = Number(process.env.DHA_PORTRAIT_MAX_BYTES ?? 1_000_000);
    console.log(`  within DHA_PORTRAIT_MAX_BYTES (${cap}) : ${Math.floor(img.length * 0.75) <= cap ? 'yes' : 'NO'}`);
  } else {
    console.log('  ImageBase64             : ABSENT — no portrait to face-match against.');
  }

  console.log('\n─── FLAG VOCABULARY (drives the routing table) ─────────────');
  for (const f of ['IDNumberMatchStatus', 'DeceasedStatus', 'DeceasedDate', 'IDNumberBlocked']) {
    show(f, idv?.[f]);
  }

  console.log('\n─── STALENESS (the bureau-vs-live-DHA tradeoff) ────────────');
  for (const f of ['OfflineIndicator', 'LastUpdatedIndicator', 'LastUpdated']) show(f, idv?.[f]);
  console.log('\n  These quantify how far behind Home Affairs the bureau copy');
  console.log('  may be. A blocked or deceased status could lag by this much.');

  console.log('\n─── IDENTITY FIELDS ────────────────────────────────────────');
  for (const f of ['Names', 'Surname', 'Gender', 'DateOfBirth', 'BirthPlace', 'MarriageStatus']) {
    show(f, idv?.[f]);
  }

  console.log('\n─── WHAT THIS SETTLES ──────────────────────────────────────');
  console.log('  1. Real base64 portrait?  → is the whole swap viable at all');
  console.log('  2. Exact flag strings     → the reject conditions');
  console.log('  3. OfflineIndicator       → how stale the bureau copy is');
  console.log('  4. ResponseCode vs HTTP   → confirms envelope-only routing');
  console.log('  Sandbox answers 2 and 4. Only LIVE answers 1 and 3 honestly');
  console.log('  — Didit\'s sandbox fabricated its response, so assume this');
  console.log('  one does too.\n');
}

main().catch((err) => {
  console.error('\nFailed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
