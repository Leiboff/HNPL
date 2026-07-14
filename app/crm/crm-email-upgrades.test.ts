import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── CRM email upgrades — source-pin regressions ─────────────────────
//
// Covers the migration + gmail client + push endpoint + signature +
// admin oversight invariants. Behavioural tests live in the sibling
// *.test.ts files near the code under test; this file locks the
// contract shape (RLS, scopes, cron cadence, no-token-leak text).

const ROOT = resolve(process.cwd());
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

// ── Migration 0072 ────────────────────────────────────────────────

describe('0072 — crm_email_accounts multi-account + signatures + audit', () => {
  const SRC = read('supabase/migrations/0072_crm_email_upgrades.sql');

  it('drops the user_id UNIQUE and adds composite (user_id, gmail_address)', () => {
    expect(SRC).toMatch(/DROP CONSTRAINT IF EXISTS crm_email_accounts_user_id_key/);
    expect(SRC).toMatch(/ADD CONSTRAINT crm_email_accounts_user_address_key UNIQUE \(user_id, gmail_address\)/);
  });

  it('adds last_history_id, watch_expires_at, last_used_at', () => {
    expect(SRC).toMatch(/ADD COLUMN IF NOT EXISTS last_history_id\s+TEXT/);
    expect(SRC).toMatch(/ADD COLUMN IF NOT EXISTS watch_expires_at\s+TIMESTAMPTZ/);
    expect(SRC).toMatch(/ADD COLUMN IF NOT EXISTS last_used_at\s+TIMESTAMPTZ/);
  });

  it('adds crm_activities.sent_from', () => {
    expect(SRC).toMatch(/ALTER TABLE crm_activities\s+ADD COLUMN IF NOT EXISTS sent_from TEXT/);
  });

  it('creates crm_signatures with per-user RLS', () => {
    expect(SRC).toMatch(/CREATE TABLE IF NOT EXISTS crm_signatures/);
    expect(SRC).toMatch(/user_id\s+UUID\s+PRIMARY KEY REFERENCES profiles\(id\) ON DELETE CASCADE/);
    expect(SRC).toMatch(/ALTER TABLE crm_signatures ENABLE ROW LEVEL SECURITY/);
    expect(SRC).toMatch(/crm_signatures_self_select/);
    expect(SRC).toMatch(/user_id = auth\.uid\(\)/);
  });

  it('creates crm_audit_log with admin-only SELECT + no write policy (service-role only)', () => {
    expect(SRC).toMatch(/CREATE TABLE IF NOT EXISTS crm_audit_log/);
    expect(SRC).toMatch(/ALTER TABLE crm_audit_log ENABLE ROW LEVEL SECURITY/);
    expect(SRC).toMatch(/crm_audit_log_admin_select/);
    // NO INSERT/UPDATE/DELETE policy — writes only via service role.
    expect(SRC).not.toMatch(/crm_audit_log_admin_(insert|update|delete)/);
  });
});

// ── Gmail client — multi-account, watch API, no new scopes ────────

describe('gmailClient — multi-account + watch/history/stop', () => {
  const SRC = read('lib/gmail/gmailClient.ts');

  it('keeps the same two OAuth scopes — gmail.send + gmail.readonly (no new scopes)', () => {
    expect(SRC).toMatch(/gmail\.send/);
    expect(SRC).toMatch(/gmail\.readonly/);
    // Explicit anti-scope pins:
    expect(SRC).not.toMatch(/gmail\.modify/);
    expect(SRC).not.toMatch(/gmail\.settings/);
    expect(SRC).not.toMatch(/mail\.google\.com/);
  });

  it('exports startGmailWatch + stopGmailWatch + listHistoryFrom + fetchMessageMetadata', () => {
    expect(SRC).toMatch(/export async function startGmailWatch/);
    expect(SRC).toMatch(/export async function stopGmailWatch/);
    expect(SRC).toMatch(/export async function listHistoryFrom/);
    expect(SRC).toMatch(/export async function fetchMessageMetadata/);
  });

  it('getAccessToken accepts a selector shape (userId + accountId or gmailAddress)', () => {
    expect(SRC).toMatch(/getAccessToken\([\s\S]*?AccountSelector/);
    expect(SRC).toMatch(/type AccountSelector/);
  });

  it('saveGmailAccount upserts on (user_id, gmail_address)', () => {
    expect(SRC).toMatch(/onConflict:\s*['"]user_id,gmail_address['"]/);
  });

  it('startGmailWatch requests INBOX-only push', () => {
    expect(SRC).toMatch(/labelIds:\s*\[['"]INBOX['"]\]/);
    expect(SRC).toMatch(/labelFilterAction:\s*['"]include['"]/);
  });

  it('listHistoryFrom returns { kind: expired } on 404 (Google historyId too old)', () => {
    expect(SRC).toMatch(/kind:\s*['"]expired['"]/);
    expect(SRC).toMatch(/if\s*\(res\.status\s*===\s*404\)/);
  });
});

// ── Push endpoint — OIDC required, idempotent, feature-flag-safe ──

describe('/api/crm/gmail/push — OIDC + idempotency', () => {
  const SRC = read('app/api/crm/gmail/push/route.ts');

  it('rejects requests with a missing / bad OIDC bearer token', () => {
    expect(SRC).toMatch(/verifyGoogleIdToken/);
    expect(SRC).toMatch(/if\s*\(!verify\.ok\)/);
    expect(SRC).toMatch(/status:\s*401/);
  });

  it('reads GMAIL_PUSH_AUDIENCE and GMAIL_PUSH_SA_EMAIL from env (fails loudly if unset)', () => {
    expect(SRC).toMatch(/GMAIL_PUSH_AUDIENCE/);
    expect(SRC).toMatch(/GMAIL_PUSH_SA_EMAIL/);
    expect(SRC).toMatch(/push_not_configured/);
  });

  it('delegates to the shared reply-ingest module (idempotency lives there)', () => {
    expect(SRC).toMatch(/from\s+['"]@\/lib\/gmail\/replyIngest['"]/);
    expect(SRC).toMatch(/ingestOneMessage/);
    expect(SRC).toMatch(/sweepAllThreadsForAccount/);
  });

  it('handles historyId-too-old via full sweep + cursor reset', () => {
    expect(SRC).toMatch(/history\.kind\s*===\s*['"]expired['"]/);
    expect(SRC).toMatch(/sweepAllThreadsForAccount/);
    expect(SRC).toMatch(/last_history_id:\s*newHistoryId/);
  });
});

// ── OIDC verifier — shape ────────────────────────────────────────

describe('oidcVerify — Google JWT verification', () => {
  const SRC = read('lib/gmail/oidcVerify.ts');

  it('enforces issuer, audience, email, exp, and RS256 signature', () => {
    expect(SRC).toMatch(/GOOGLE_ISSUERS/);
    expect(SRC).toMatch(/expectedAudience/);
    expect(SRC).toMatch(/expectedEmail/);
    expect(SRC).toMatch(/expired/);
    expect(SRC).toMatch(/RS256/);
    expect(SRC).toMatch(/RSA-SHA256/);
  });

  it('fetches JWKS from Google (no bundled keys)', () => {
    expect(SRC).toMatch(/oauth2\/v3\/certs/);
  });
});

// ── Cron cadence — daily safety-net, watch renewal + poll ─────────

describe('vercel.json — reply-poll downgraded to daily safety-net', () => {
  const SRC = read('vercel.json');

  it('crm-reply-poll runs daily (not every 15 min)', () => {
    const cfg = JSON.parse(SRC);
    const cron = (cfg.crons as Array<{ path: string; schedule: string }>).find(c => c.path === '/api/cron/crm-reply-poll');
    expect(cron).toBeDefined();
    // Every-15-min is */15 * * * * — enforce the new cadence is NOT that.
    expect(cron!.schedule).not.toMatch(/\*\/15/);
    // Should be a once-a-day-ish shape.
    expect(cron!.schedule).toMatch(/^\d+ \d+ \* \* \*$/);
  });
});

describe('crm-reply-poll — safety-net sweep + watch renewal', () => {
  const SRC = read('app/api/cron/crm-reply-poll/route.ts');

  it('renews expiring watches when GMAIL_PUBSUB_TOPIC is set', () => {
    expect(SRC).toMatch(/GMAIL_PUBSUB_TOPIC/);
    expect(SRC).toMatch(/startGmailWatch/);
    expect(SRC).toMatch(/watch_expires_at/);
  });

  it('shares the ingest code path with the push endpoint', () => {
    expect(SRC).toMatch(/from\s+['"]@\/lib\/gmail\/replyIngest['"]/);
    expect(SRC).toMatch(/sweepAllThreadsForAccount/);
  });
});

// ── Admin oversight — RLS + audit ────────────────────────────────

describe('admin gmail-accounts — oversight page + audit', () => {
  const PAGE = read('app/crm/admin/gmail-accounts/page.tsx');
  const ACT  = read('app/crm/admin/gmail-accounts/actions.ts');

  it('page is admin-only (sales redirected)', () => {
    expect(PAGE).toMatch(/role\s*!==\s*['"]admin['"]/);
    expect(PAGE).toMatch(/role\s*===\s*['"]sales['"]/);
  });

  it('revoke action writes a crm_audit_log row with revocation intent', () => {
    expect(ACT).toMatch(/gmail_account\.revoked/);
    expect(ACT).toMatch(/from\('crm_audit_log'\)\.insert/);
    expect(ACT).toMatch(/actor_id:\s*g\.adminId/);
  });

  it('revoke action calls revokeGmailAccountById (best-effort Google + row delete)', () => {
    expect(ACT).toMatch(/revokeGmailAccountById/);
  });
});

// ── Signature — no scripts / no event handlers ────────────────────

describe('signature — sanitiser + brand template', () => {
  const SRC = read('lib/gmail/signature.ts');

  it('strips <script>, <style>, <iframe>, on*="…" attributes, and javascript: URLs', () => {
    expect(SRC).toMatch(/BAD_TAGS.*script/);
    expect(SRC).toMatch(/on\[a-z\]\+/);
    expect(SRC).toMatch(/javascript|vbscript/);
  });

  it('renders brand template with betternow wordmark colours and teal rule', () => {
    expect(SRC).toMatch(/#13294B/);
    expect(SRC).toMatch(/#15A89E/);
    expect(SRC).toMatch(/renderBrandSignatureHtml/);
    expect(SRC).toMatch(/renderBrandSignatureText/);
  });

  it('supports merge fields display_name / title / phone / email', () => {
    // The merge-field names appear in the source as regex literals
    // inside `.replace(/\{\{\s*NAME\s*\}\}/g, ...)`. Pin on the names
    // themselves — the escaped braces are the .replace mechanism.
    expect(SRC).toMatch(/display_name/);
    expect(SRC).toMatch(/\\s\*title\\s\*/);
    expect(SRC).toMatch(/\\s\*phone\\s\*/);
    expect(SRC).toMatch(/\\s\*email\\s\*/);
  });
});

// ── Compose action — accountId, sent_from attribution, signature ──

describe('composeEmail — accountId + sent_from + signature append', () => {
  const SRC = read('app/crm/leads/[id]/composeEmail.ts');

  it('accepts optional accountId and passes it through to getAccessToken', () => {
    expect(SRC).toMatch(/accountId\??:/);
    expect(SRC).toMatch(/getAccessToken\(selector\)/);
  });

  it('records sent_from on the crm_activities insert', () => {
    // Since 0074 sent_from can be an alias — the send path uses the
    // sender resolver's fromEmail rather than the raw account address.
    expect(SRC).toMatch(/sent_from:\s*sender\.fromEmail/);
  });

  it('updates last_used_at on the account after successful send', () => {
    expect(SRC).toMatch(/last_used_at:\s*new Date\(\)\.toISOString\(\)/);
  });

  it('auto-appends signature via composeWithSignature (with omit toggle)', () => {
    expect(SRC).toMatch(/composeWithSignature/);
    expect(SRC).toMatch(/omitSignature/);
  });

  it('lists user accounts via listMyGmailAccounts (Send-as picker source)', () => {
    expect(SRC).toMatch(/export async function listMyGmailAccounts/);
  });
});

// ── Files present ─────────────────────────────────────────────────

describe('CRM email-upgrade files exist', () => {
  const FILES = [
    'supabase/migrations/0072_crm_email_upgrades.sql',
    'lib/gmail/gmailClient.ts',
    'lib/gmail/replyIngest.ts',
    'lib/gmail/oidcVerify.ts',
    'lib/gmail/signature.ts',
    'app/api/crm/gmail/push/route.ts',
    'app/crm/admin/gmail-accounts/page.tsx',
    'app/crm/admin/gmail-accounts/GmailAccountsAdminTable.tsx',
    'app/crm/admin/gmail-accounts/actions.ts',
    'app/crm/settings/GmailConnectionsCard.tsx',
    'app/crm/settings/SignatureEditor.tsx',
    'app/crm/settings/signatureActions.ts',
  ];
  it.each(FILES)('%s exists', (p) => {
    expect(existsSync(resolve(ROOT, p))).toBe(true);
  });
});
