import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── CRM Phase 2 — source-pin regressions ────────────────────────────
//
// Covers the invariants that unit tests can't check directly: token
// storage never crossing to the client, cron auth pattern, OAuth
// scopes, RLS shape, public-form abuse controls, map-view API loader.

const ROOT = resolve(process.cwd());
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

// ── Migration 0071 ────────────────────────────────────────────────

describe('0071 — crm_email_accounts + templates + activities extension', () => {
  const SRC = read('supabase/migrations/0071_crm_phase2.sql');

  it('creates crm_email_accounts with the encrypted refresh_token column', () => {
    expect(SRC).toMatch(/CREATE TABLE IF NOT EXISTS crm_email_accounts/);
    expect(SRC).toMatch(/refresh_token_enc\s+TEXT\s+NOT NULL/);
    expect(SRC).toMatch(/status\s+TEXT[\s\S]*?CHECK\s*\([\s\S]*?connected[\s\S]*?reauth_required[\s\S]*?revoked/);
  });

  it('enables RLS on crm_email_accounts with NO policies (deny-all to session clients)', () => {
    expect(SRC).toMatch(/ALTER TABLE crm_email_accounts ENABLE ROW LEVEL SECURITY/);
    // No CREATE POLICY … ON crm_email_accounts anywhere in the file.
    expect(SRC).not.toMatch(/CREATE POLICY[^;]*ON crm_email_accounts/);
  });

  it('creates crm_email_templates with admin/sales RLS', () => {
    expect(SRC).toMatch(/CREATE TABLE IF NOT EXISTS crm_email_templates/);
    expect(SRC).toMatch(/crm_email_templates_admin_sales_select/);
    expect(SRC).toMatch(/crm_email_templates_admin_sales_insert/);
    expect(SRC).toMatch(/IN\s*\(\s*'admin'\s*,\s*'sales'\s*\)/);
  });

  it('extends crm_activities with gmail_thread_id + gmail_message_id + email_reply', () => {
    expect(SRC).toMatch(/ADD COLUMN IF NOT EXISTS gmail_thread_id\s+TEXT/);
    expect(SRC).toMatch(/ADD COLUMN IF NOT EXISTS gmail_message_id\s+TEXT/);
    // The CHECK now includes 'email_reply'.
    expect(SRC).toMatch(/crm_activities_type_check[\s\S]*?email_reply/);
  });

  it('seeds two templates that stay INSIDE the /practices forbidden-strings pin', () => {
    // These strings are explicitly forbidden by app/practices-copy.test.ts;
    // pin their ABSENCE in the seed copy so a future edit can't slip them in.
    const FORBIDDEN_IN_SEEDS = [
      'promotional rate', 'qualifying rate', 'DebiCheck', 'debit order',
      'Pay in 4', 'Pay in 6', 'no credit checks',
    ];
    for (const s of FORBIDDEN_IN_SEEDS) {
      expect(SRC).not.toContain(s);
    }
    // Two seed rows present.
    const seeds = [...SRC.matchAll(/INSERT INTO crm_email_templates[\s\S]*?is_seed/g)];
    expect(seeds.length).toBeGreaterThanOrEqual(2);
  });
});

// ── Token encryption ──────────────────────────────────────────────

describe('token encryption — dedicated key + legacy fallback', () => {
  it('lib/crypto/tokenEncryption keys off TOKEN_ENCRYPTION_KEY (not the SA-ID key)', () => {
    const src = read('lib/crypto/tokenEncryption.ts');
    expect(src).toMatch(/PRIMARY_KEY_ENV\s*=\s*['"]TOKEN_ENCRYPTION_KEY['"]/);
    expect(src).toMatch(/LEGACY_KEY_ENV\s*=\s*['"]SA_ID_ENCRYPTION_KEY['"]/);
    expect(src).toMatch(/export function encryptToken/);
    expect(src).toMatch(/export function decryptToken/);
    // The dedicated module does NOT depend on lib/idEncryption anymore.
    expect(src).not.toMatch(/from\s+['"]@\/lib\/idEncryption['"]/);
  });

  it('encryptToken always writes under the primary key (no legacy path on write)', () => {
    const src = read('lib/crypto/tokenEncryption.ts');
    expect(src).toMatch(/export function encryptToken[\s\S]*?getPrimaryKey\(\)/);
    // encryptToken must not consult the legacy key on the write path.
    const enc = src.match(/export function encryptToken[\s\S]*?\n\}/)?.[0] ?? '';
    expect(enc).not.toMatch(/getLegacyKey/);
  });

  it('decryptToken returns { plaintext, usedLegacyKey } and logs a warning on legacy path', () => {
    const src = read('lib/crypto/tokenEncryption.ts');
    expect(src).toMatch(/DecryptResult/);
    expect(src).toMatch(/usedLegacyKey/);
    expect(src).toMatch(/console\.warn\([\s\S]*?legacy SA_ID_ENCRYPTION_KEY/);
  });

  it('gmailClient re-encrypts under the primary key on successful refresh (self-heal)', () => {
    const src = read('lib/gmail/gmailClient.ts');
    // decryptToken now returns an object with .plaintext / .usedLegacyKey
    expect(src).toMatch(/decryptToken\s*\(\s*account\.refresh_token_enc\s*\)/);
    expect(src).toMatch(/decrypted\.usedLegacyKey/);
    expect(src).toMatch(/refresh_token_enc\s*=\s*encryptToken\s*\(\s*decrypted\.plaintext\s*\)/);
  });

  it('the Gmail client uses encryptToken on save and NEVER exposes plaintext to callers', () => {
    const src = read('lib/gmail/gmailClient.ts');
    expect(src).toMatch(/import\s*\{[\s\S]*?encryptToken[\s\S]*?decryptToken[\s\S]*?\}\s*from\s+['"]@\/lib\/crypto\/tokenEncryption['"]/);
    expect(src).toMatch(/encryptToken\s*\(\s*input\.refreshToken\s*\)/);
  });
});

// ── OAuth flow ────────────────────────────────────────────────────

describe('Gmail OAuth flow', () => {
  it('requests only gmail.send + gmail.readonly scopes (nothing wider)', () => {
    const src = read('lib/gmail/gmailClient.ts');
    expect(src).toMatch(/gmail\.send/);
    expect(src).toMatch(/gmail\.readonly/);
    // Not full-access / send-only-with-modify:
    expect(src).not.toMatch(/gmail\.modify/);
    expect(src).not.toMatch(/mail\.google\.com\/'/);
    expect(src).not.toMatch(/https:\/\/www\.googleapis\.com\/auth\/gmail\.compose/);
  });

  it('forces offline access + prompt=consent so a refresh_token is issued', () => {
    const src = read('lib/gmail/gmailClient.ts');
    expect(src).toMatch(/access_type:\s*['"]offline['"]/);
    expect(src).toMatch(/prompt:\s*['"]consent['"]/);
  });

  it('connect + callback + disconnect routes all sales/admin-gate before touching state', () => {
    const connect    = read('app/api/crm/gmail/connect/route.ts');
    const callback   = read('app/api/crm/gmail/callback/route.ts');
    const disconnect = read('app/api/crm/gmail/disconnect/route.ts');
    for (const src of [connect, disconnect]) {
      expect(src).toMatch(/from\s+['"]@\/lib\/supabase\/server['"]/);
      expect(src).toMatch(/profile\?\.role/);
      expect(src).toMatch(/['"]sales['"]/);
      expect(src).toMatch(/['"]admin['"]/);
    }
    // Callback validates the state cookie matches ?state=.
    expect(callback).toMatch(/state_mismatch/);
    expect(callback).toMatch(/crm_gmail_state/);
  });
});

// ── Cron reply-poll (safety-net since 0072) ──────────────────────

describe('crm-reply-poll cron — safety-net + watch renewal (since 0072)', () => {
  const SRC = read('app/api/cron/crm-reply-poll/route.ts');
  const INGEST = read('lib/gmail/replyIngest.ts');

  it('is auth-gated by CRON_SECRET with timing-safe compare (matches collect-instalments)', () => {
    expect(SRC).toMatch(/process\.env\.CRON_SECRET/);
    expect(SRC).toMatch(/timingSafeEqual/);
  });

  it('idempotency lives in the shared reply-ingest module (dedupe on gmail_message_id)', () => {
    expect(INGEST).toMatch(/gmail_message_id/);
    expect(INGEST).toMatch(/duplicate/);
  });

  it('shared ingester skips closed-stage leads (signed / onboarded / lost)', () => {
    // Since Step 0's stage-vocabulary extraction, CLOSED_STAGES is
    // TERMINAL_STAGES imported from lib/crm/stages.ts rather than its
    // own literal Set — assert the import + re-export, not a literal.
    expect(INGEST).toMatch(/from\s+['"]@\/lib\/crm\/stages['"]/);
    expect(INGEST).toMatch(/CLOSED_STAGES\s*=\s*TERMINAL_STAGES/);
  });

  it('is registered in vercel.json crons with a daily safety-net cadence', () => {
    // Scoped to THIS cron's own entry. It used to assert that the string
    // "*/15 * * * *" appeared nowhere in vercel.json at all, which was a
    // fine proxy while nothing else needed a sub-hourly schedule and became
    // wrong the moment something did (the risk alert digest, 0143). The
    // claim being made is about the CRM poll's cadence, so it is now made
    // about the CRM poll's cadence.
    const config = JSON.parse(read('vercel.json'));
    const poll = config.crons.find(
      (c: { path: string }) => c.path === '/api/cron/crm-reply-poll',
    );
    expect(poll).toBeDefined();
    // Since 0072 the primary channel is Pub/Sub push; the cron is a
    // once-a-day safety-net sweep + watch renewal, no longer */15.
    expect(poll.schedule).toMatch(/^\d+ \d+ \* \* \*$/);
    expect(poll.schedule).not.toMatch(/\*\//);
  });
});

// ── Compose flow token surface ────────────────────────────────────

describe('compose sheet — token isolation', () => {
  it('the client compose sheet never imports a token / decrypt helper', () => {
    const src = read('app/crm/leads/[id]/ComposeEmailSheet.tsx');
    expect(src).toMatch(/'use client'/);
    expect(src).not.toMatch(/decryptToken/);
    expect(src).not.toMatch(/decryptId/);
    expect(src).not.toMatch(/refresh_token/);
    expect(src).not.toMatch(/refresh_token_enc/);
  });

  it('the compose server action reports needsReconnect on token failures', () => {
    const src = read('app/crm/leads/[id]/composeEmail.ts');
    expect(src).toMatch(/needsReconnect/);
    expect(src).toMatch(/gmail_reauth_required/);
  });
});

// ── Public /practices form ────────────────────────────────────────

describe('/practices public lead capture', () => {
  const ACTION = read('app/practices/publicLeadAction.ts');
  const FORM   = read('app/practices/PublicLeadForm.tsx');

  it('inserts with source=inbound + stage=new, via the service-role client only', () => {
    expect(ACTION).toMatch(/source:\s*['"]inbound['"]/);
    expect(ACTION).toMatch(/stage:\s*['"]new['"]/);
    expect(ACTION).toMatch(/createServiceClient/);
    // No read path is exposed by the action — no dedupe or existence
    // check that returns something identifying.
    expect(ACTION).not.toMatch(/return\s*\{\s*ok:\s*true,\s*existing/);
  });

  it('honeypot silently drops filled submissions (returns ok:true, no insert)', () => {
    expect(ACTION).toMatch(/if\s*\(input\.website\s*&&\s*input\.website\.trim\(\)\.length\s*>\s*0\)/);
  });

  it('applies per-IP rate limit + formula-injection neutralisation on every string field', () => {
    // Rate-limit state lives outside 'use server' (Next.js requires all
    // exports from an action file be async functions) — the action
    // consumes the helper from lib/crm/publicLeadRateLimit.
    expect(ACTION).toMatch(/checkAndRecordPublicLeadRate/);
    expect(ACTION).toMatch(/from\s+['"]@\/lib\/crm\/publicLeadRateLimit['"]/);
    const LIMIT = read('lib/crm/publicLeadRateLimit.ts');
    expect(LIMIT).toMatch(/RATE_LIMIT_MAX\s*=\s*5/);
    expect(LIMIT).toMatch(/export function checkAndRecord/);
    expect(LIMIT).toMatch(/export function resetForTests/);
    expect(ACTION).toMatch(/neutraliseFormula/);
    expect(ACTION).toMatch(/from\s+['"]@\/lib\/crm\/csv['"]/);
  });

  it('the form contains a hidden honeypot input named "website"', () => {
    expect(FORM).toMatch(/name="website"/);
    expect(FORM).toMatch(/data-testid="public-lead-honeypot"/);
    // Hidden via inline style (does not rely on Tailwind at build)
    expect(FORM).toMatch(/left:\s*['"]?-9999px['"]?/);
  });

  it('the /practices page renders the new form section', () => {
    const page = read('app/practices/PracticesPage.tsx');
    expect(page).toMatch(/<PublicLeadForm\s*\/>/);
    expect(page).toMatch(/from\s+['"]\.\/PublicLeadForm['"]/);
  });
});

// ── Map view ──────────────────────────────────────────────────────

describe('/crm/map — pins + route + no-coords tray', () => {
  const CLIENT = read('app/crm/map/MapClient.tsx');
  const PAGE   = read('app/crm/map/page.tsx');

  it('page-level role gate + coord split (with-coords vs no-coords)', () => {
    expect(PAGE).toMatch(/profile\?\.role\s*!==\s*['"]sales['"]/);
    expect(PAGE).toMatch(/profile\?\.role\s*!==\s*['"]admin['"]/);
    expect(PAGE).toMatch(/withCoords/);
    expect(PAGE).toMatch(/noCoords/);
  });

  it('client lazy-loads the Maps JS API and reports a keyless / script error state', () => {
    expect(CLIENT).toMatch(/maps\.googleapis\.com\/maps\/api\/js/);
    expect(CLIENT).toMatch(/data-testid="crm-map-error"/);
    expect(CLIENT).toMatch(/missing_key/);
  });

  it('renders filter chips (stage / specialty / overdue), a stage legend, and the route panel', () => {
    expect(CLIENT).toMatch(/data-testid="crm-map-filters"/);
    expect(CLIENT).toMatch(/data-testid="crm-map-legend"/);
    expect(CLIENT).toMatch(/data-testid="crm-map-overdue-filter"/);
    expect(CLIENT).toMatch(/data-testid="crm-map-route-panel"/);
  });

  it('renders a no-coords tray using the shared PlacesAutocomplete', () => {
    expect(CLIENT).toMatch(/data-testid="crm-map-no-coords-tray"/);
    expect(CLIENT).toMatch(/from\s+['"]@\/app\/_components\/PlacesAutocomplete['"]/);
    expect(CLIENT).toMatch(/parseAddressComponents/);
  });

  it('uses buildGoogleMapsDirUrl for the "Open in Google Maps" deep link (no Directions API)', () => {
    expect(CLIENT).toMatch(/buildGoogleMapsDirUrl/);
    // No Directions REST endpoint — the URL builder is the whole story.
    expect(CLIENT).not.toMatch(/maps\/api\/directions/);
  });
});

// ── My Day inbound tray ───────────────────────────────────────────

describe('/crm My Day — inbound tray', () => {
  it('lists unowned inbound leads above the buckets', () => {
    const src = read('app/crm/page.tsx');
    expect(src).toMatch(/eq\('source', 'inbound'\)/);
    expect(src).toMatch(/is\('owner_user_id', null\)/);
    expect(src).toMatch(/data-testid="crm-inbound-tray"/);
    // Inbound tray renders BEFORE the buckets.
    const idxTray    = src.indexOf('crm-inbound-tray');
    const idxBuckets = src.indexOf('<Bucket');
    expect(idxTray).toBeGreaterThan(-1);
    expect(idxBuckets).toBeGreaterThan(idxTray);
  });
});

// ── Nav wiring ────────────────────────────────────────────────────

describe('CRM nav — new routes', () => {
  const src = read('app/crm/CrmNav.tsx');
  it('adds /crm/settings link', () => {
    // /crm/map was a standalone nav link at Phase 2 time. Phase 3
    // collapses the nav to Today/Leads/Accounts/Settings — Map is now
    // a face of the Leads surface (List · Board · Map switcher on the
    // page), reachable via /crm/leads, not a top-level nav entry.
    expect(src).toMatch(/href:\s*['"]\/crm\/settings['"]/);
  });
});

// ── Files present ─────────────────────────────────────────────────

describe('CRM Phase 2 files exist', () => {
  const FILES = [
    'supabase/migrations/0071_crm_phase2.sql',
    'lib/crypto/tokenEncryption.ts',
    'lib/gmail/gmailClient.ts',
    'lib/gmail/mergeFields.ts',
    'lib/crm/mapPlanner.ts',
    'app/api/crm/gmail/connect/route.ts',
    'app/api/crm/gmail/callback/route.ts',
    'app/api/crm/gmail/disconnect/route.ts',
    'app/api/cron/crm-reply-poll/route.ts',
    'app/crm/settings/page.tsx',
    'app/crm/settings/GmailConnectionsCard.tsx',
    'app/crm/leads/[id]/composeEmail.ts',
    'app/crm/leads/[id]/ComposeEmailSheet.tsx',
    'app/crm/map/page.tsx',
    'app/crm/map/MapClient.tsx',
    'app/practices/publicLeadAction.ts',
    'app/practices/PublicLeadForm.tsx',
  ];
  it.each(FILES)('%s exists', (p) => {
    expect(existsSync(resolve(ROOT, p))).toBe(true);
  });
});
