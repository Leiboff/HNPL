import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── Source-pin regressions for the threading fix + send-as work ─────

const ROOT = resolve(process.cwd());
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

describe('0074 — crm_sendas_aliases migration', () => {
  const SRC = read('supabase/migrations/0074_crm_sendas_aliases.sql');

  it('creates crm_sendas_aliases with connection_id FK, alias_email, allowed_roles', () => {
    expect(SRC).toMatch(/CREATE TABLE IF NOT EXISTS crm_sendas_aliases/);
    expect(SRC).toMatch(/connection_id\s+UUID\s+NOT NULL REFERENCES crm_email_accounts\(id\) ON DELETE CASCADE/);
    expect(SRC).toMatch(/alias_email\s+TEXT\s+NOT NULL/);
    expect(SRC).toMatch(/allowed_roles\s+TEXT\[\]\s+NOT NULL/);
  });

  it('enforces admin-only writes + role-in-allowed_roles reads via RLS', () => {
    expect(SRC).toMatch(/ALTER TABLE crm_sendas_aliases ENABLE ROW LEVEL SECURITY/);
    expect(SRC).toMatch(/sendas_aliases_admin_insert/);
    expect(SRC).toMatch(/sendas_aliases_admin_update/);
    expect(SRC).toMatch(/sendas_aliases_admin_delete/);
    expect(SRC).toMatch(/sendas_aliases_role_select/);
    expect(SRC).toMatch(/= ANY\(allowed_roles\)/);
  });

  it('case-insensitive unique on (connection_id, alias_email)', () => {
    expect(SRC).toMatch(/UNIQUE INDEX[\s\S]*crm_sendas_aliases_conn_email_key[\s\S]*lower\(alias_email\)/);
  });
});

// ── Threading fix (Part A) ─────────────────────────────────────────

describe('reply-mode send NEVER emits threadId-only requests (Part A)', () => {
  const SRC = read('app/crm/leads/[id]/composeEmail.ts');

  it('exports resolveReplyThreadingHeaders and uses it for BOTH rfc-id and legacy paths', () => {
    expect(SRC).toMatch(/async function resolveReplyThreadingHeaders/);
    // The reply-mode branch always calls the resolver — no bypass.
    expect(SRC).toMatch(/const resolved = await resolveReplyThreadingHeaders/);
  });

  it('legacy path falls back to fetchThread and refuses to send if the fetch fails', () => {
    expect(SRC).toMatch(/messages = await fetchThread\(accessToken, anchor\.gmail_thread_id\)/);
    expect(SRC).toMatch(/reply_threading_headers_unavailable/);
    // No headerless send path — inReplyTo comes from the resolver, not
    // from anchor.message_rfc_id directly.
    expect(SRC).toMatch(/inReplyTo:\s*inReplyTo \?\? undefined/);
    expect(SRC).not.toMatch(/inReplyTo:\s*anchor\?\.message_rfc_id/);
  });

  it('backfills message_rfc_id onto the anchor after a successful live fetch', () => {
    expect(SRC).toMatch(/backfill/);
    expect(SRC).toMatch(/message_rfc_id:\s*rfcForAnchor/);
    expect(SRC).toMatch(/from\('crm_activities'\)\s*\.update\(\{\s*message_rfc_id:\s*rfcForAnchor/);
  });

  it('captureOwnMessageId is awaited (not fire-and-forget) with a retry', () => {
    expect(SRC).toMatch(/async function captureOwnMessageId/);
    expect(SRC).toMatch(/attempt\s*<\s*1/);
    expect(SRC).toMatch(/setTimeout\(resolve, 300\)/);
    expect(SRC).toMatch(/await captureOwnMessageId/);
  });
});

// ── Sales routing (Part B) ─────────────────────────────────────────

describe('sales role login routing (Part B)', () => {
  it('dashboard dispatcher routes sales → /crm', () => {
    const src = read('app/dashboard/page.tsx');
    expect(src).toMatch(/case 'sales':[\s\S]*?redirect\('\/crm'\)/);
  });

  it('/patient layout bounces sales → /crm (no /login loop)', () => {
    const src = read('app/patient/layout.tsx');
    expect(src).toMatch(/profile\?\.role === 'sales'/);
    expect(src).toMatch(/redirect\('\/crm'\)/);
  });

  it('/onboarding router short-circuits non-patient roles to /dashboard', () => {
    const src = read('app/onboarding/page.tsx');
    expect(src).toMatch(/profile\.role[\s\S]*?!==\s*'patient'/);
    expect(src).toMatch(/redirect\('\/dashboard'\)/);
    // Fetches role column so the check can run.
    expect(src).toMatch(/\.select\('role,/);
  });
});

// ── Send-as enforcement + aliases (Part C) ─────────────────────────

describe('send-as: server enforces ownership + role, aliases via table', () => {
  const SRC = read('app/crm/leads/[id]/composeEmail.ts');

  it('resolveSender is the single authorisation gate', () => {
    expect(SRC).toMatch(/async function resolveSender/);
    // Explicit not_your_connection surfacing (not just "gmail_not_connected").
    expect(SRC).toMatch(/not_your_connection/);
  });

  it('accepts aliasId as a separate compose param', () => {
    expect(SRC).toMatch(/aliasId\?:\s*string/);
  });

  it('lists eligible aliases in the Send-as picker source (listMyGmailAccounts)', () => {
    expect(SRC).toMatch(/from\('crm_sendas_aliases'\)/);
    expect(SRC).toMatch(/allowed_roles/);
    expect(SRC).toMatch(/kind:\s*['"]alias['"]/);
    expect(SRC).toMatch(/via:/);
  });

  it('alias sends set From to alias_email + detect Gmail rewrites', () => {
    expect(SRC).toMatch(/from:\s*sender\.fromEmail/);
    expect(SRC).toMatch(/alias-rewrite detection/i);
    expect(SRC).toMatch(/alias_rewritten:\$\{sender\.fromEmail\}:\$\{actualFrom\}/);
    // The rewrite path logs a warning activity note.
    expect(SRC).toMatch(/title:\s*'Alias not configured in Gmail'/);
  });

  it('reply-mode lock recognises aliases (owner address matches an alias)', () => {
    expect(SRC).toMatch(/aliasHit/);
    expect(SRC).toMatch(/aliasRow\.allowed_roles/);
  });

  it('bypasses user_id ownership via connectionId selector for alias sends', () => {
    expect(SRC).toMatch(/selector[\s\S]*?connectionId:\s*sender\.connectionId/);
    const CLIENT = read('lib/gmail/gmailClient.ts');
    expect(CLIENT).toMatch(/\{ connectionId: string \}/);
    expect(CLIENT).toMatch(/if \('connectionId' in sel\)/);
  });

  it('admin oversight has add/remove alias actions (admin-gated + audit-logged)', () => {
    const ACT = read('app/crm/admin/gmail-accounts/actions.ts');
    expect(ACT).toMatch(/export async function adminAddSendAsAlias/);
    expect(ACT).toMatch(/export async function adminRemoveSendAsAlias/);
    expect(ACT).toMatch(/gmail_account\.alias_added/);
    expect(ACT).toMatch(/gmail_account\.alias_removed/);
    expect(ACT).toMatch(/guardAdmin/);
  });
});

describe('files present', () => {
  const FILES = [
    'supabase/migrations/0074_crm_sendas_aliases.sql',
  ];
  it.each(FILES)('%s exists', (p) => {
    expect(existsSync(resolve(ROOT, p))).toBe(true);
  });
});
