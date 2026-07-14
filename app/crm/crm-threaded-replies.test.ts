import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { prefixReSubject } from '@/lib/gmail/replySubject';
import { extractEmailAddress } from '@/lib/gmail/replyIngest';

// ─── CRM threaded replies — source pins + pure-function behaviour ─────

const ROOT = resolve(process.cwd());
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

describe('0073 — crm_activities.message_rfc_id + reply_from', () => {
  const SRC = read('supabase/migrations/0073_crm_reply_headers.sql');

  it('adds message_rfc_id + reply_from as nullable text columns', () => {
    expect(SRC).toMatch(/ADD COLUMN IF NOT EXISTS message_rfc_id\s+TEXT/);
    expect(SRC).toMatch(/ADD COLUMN IF NOT EXISTS reply_from\s+TEXT/);
  });

  it('indexes message_rfc_id (partial, WHERE NOT NULL)', () => {
    expect(SRC).toMatch(/CREATE INDEX[\s\S]*?crm_activities_message_rfc_id_idx[\s\S]*?WHERE message_rfc_id IS NOT NULL/);
  });

  it('is additive only — no RLS or CHECK changes', () => {
    expect(SRC).not.toMatch(/ENABLE ROW LEVEL SECURITY/);
    expect(SRC).not.toMatch(/CREATE POLICY/);
    expect(SRC).not.toMatch(/DROP CONSTRAINT/);
  });
});

describe('gmailClient — threading headers on send', () => {
  const SRC = read('lib/gmail/gmailClient.ts');

  it('SendArgs accepts threadId, inReplyTo, references', () => {
    expect(SRC).toMatch(/threadId\?:\s*string/);
    expect(SRC).toMatch(/inReplyTo\?:\s*string/);
    expect(SRC).toMatch(/references\?:\s*string/);
  });

  it('emits In-Reply-To + References headers when inReplyTo is set', () => {
    expect(SRC).toMatch(/`In-Reply-To: \$\{args\.inReplyTo\}`/);
    expect(SRC).toMatch(/`References: \$\{refs\}`/);
    // References is prior-refs + inReplyTo when a prior chain exists.
    expect(SRC).toMatch(/args\.references[\s\S]*?\?\s*`\$\{args\.references\.trim\(\)\} \$\{args\.inReplyTo\}`/);
  });

  it('includes threadId on the send request body when passed', () => {
    expect(SRC).toMatch(/body\.threadId\s*=\s*args\.threadId/);
  });

  it('fetchThread + fetchMessageMetadata request Message-Id + Subject + References + In-Reply-To', () => {
    expect(SRC).toMatch(/metadataHeaders=Message-Id/);
    expect(SRC).toMatch(/metadataHeaders=Subject/);
    expect(SRC).toMatch(/metadataHeaders=References/);
    expect(SRC).toMatch(/metadataHeaders=In-Reply-To/);
  });

  it('ThreadMessage carries rfcMessageId + subject + references + inReplyTo', () => {
    expect(SRC).toMatch(/rfcMessageId:\s*string \| null/);
    expect(SRC).toMatch(/subject:\s*string/);
    expect(SRC).toMatch(/references:\s*string \| null/);
    expect(SRC).toMatch(/inReplyTo:\s*string \| null/);
  });
});

describe('replyIngest — captures rfc id + reply_from on new inbound', () => {
  const SRC = read('lib/gmail/replyIngest.ts');

  it('stores message_rfc_id + reply_from on the crm_activities insert', () => {
    expect(SRC).toMatch(/message_rfc_id:\s*message\.rfcMessageId/);
    expect(SRC).toMatch(/reply_from:\s*extractEmailAddress\(message\.from\)/);
  });
});

describe('extractEmailAddress — RFC 5322 From header parsing', () => {
  it('extracts angle-bracketed address', () => {
    expect(extractEmailAddress('"Alice Smith" <alice@example.com>')).toBe('alice@example.com');
    expect(extractEmailAddress('Alice <alice@example.com>')).toBe('alice@example.com');
  });

  it('returns bare address unchanged', () => {
    expect(extractEmailAddress('alice@example.com')).toBe('alice@example.com');
  });

  it('returns original if no @ (defensive)', () => {
    expect(extractEmailAddress('unclear')).toBe('unclear');
  });

  it('empty input → empty string', () => {
    expect(extractEmailAddress('')).toBe('');
  });
});

describe('prefixReSubject — idempotent Re: prefix', () => {
  it('prefixes when Re: is absent', () => {
    expect(prefixReSubject('betternow follow-up')).toBe('Re: betternow follow-up');
  });

  it('does NOT double-prefix when Re: already present (case-insensitive)', () => {
    expect(prefixReSubject('Re: betternow follow-up')).toBe('Re: betternow follow-up');
    expect(prefixReSubject('RE: shouted')).toBe('RE: shouted');
    expect(prefixReSubject('re: lowercase')).toBe('re: lowercase');
    expect(prefixReSubject('Re:no space')).toBe('Re:no space');
  });

  it('trims whitespace but preserves inner spacing', () => {
    expect(prefixReSubject('   hello world  ')).toBe('Re: hello world');
    expect(prefixReSubject('  Re: hello  ')).toBe('Re: hello');
  });

  it('wraps other prefixes like Fwd: (not idempotent for them by design)', () => {
    expect(prefixReSubject('Fwd: intro')).toBe('Re: Fwd: intro');
  });

  it('empty subject → empty (no bare Re:)', () => {
    expect(prefixReSubject('')).toBe('');
    expect(prefixReSubject('    ')).toBe('');
  });
});

describe('composeEmail — reply-mode plumbing', () => {
  const SRC = read('app/crm/leads/[id]/composeEmail.ts');

  it('exports loadReplyContext (async) — prefixReSubject lives outside the use-server file', () => {
    expect(SRC).toMatch(/export async function loadReplyContext/);
    // prefixReSubject was extracted to lib/gmail/replySubject so the
    // 'use server' file exports only async functions.
    const RS = read('lib/gmail/replySubject.ts');
    expect(RS).toMatch(/export function prefixReSubject/);
    expect(SRC).toMatch(/from\s+['"]@\/lib\/gmail\/replySubject['"]/);
    expect(SRC).not.toMatch(/^export function /m);
  });

  it('sendComposedEmail accepts replyToActivityId', () => {
    expect(SRC).toMatch(/replyToActivityId\?:\s*string/);
  });

  it('reply mode passes threadId + inReplyTo + references to sendGmail', () => {
    // Since the threading-fix pass (Part A of the follow-up),
    // inReplyTo comes from resolveReplyThreadingHeaders — not
    // directly from anchor.message_rfc_id — so legacy rows also get
    // proper headers via a live thread fetch.
    expect(SRC).toMatch(/threadId:\s*anchor\?\.gmail_thread_id/);
    expect(SRC).toMatch(/inReplyTo:\s*inReplyTo \?\? undefined/);
    expect(SRC).toMatch(/references:\s*priorReferences/);
    expect(SRC).toMatch(/resolveReplyThreadingHeaders/);
  });

  it('rejects a client-supplied accountId that mismatches the thread owner', () => {
    expect(SRC).toMatch(/reply_owner_locked/);
  });

  it('returns reply_owner_disconnected when the anchor sender is not (or no longer) connected', () => {
    expect(SRC).toMatch(/reply_owner_disconnected/);
    expect(SRC).toMatch(/needsReconnect:\s*true/);
  });

  it('captures our own Message-Id via fetchMessageMetadata lookback (best-effort)', () => {
    expect(SRC).toMatch(/fetchMessageMetadata\(tokenRes\.accessToken,\s*messageId\)/);
    expect(SRC).toMatch(/message_rfc_id:\s*meta\.rfcMessageId/);
  });
});

describe('ComposeEmailSheet — reply-mode UI', () => {
  const SRC = read('app/crm/leads/[id]/ComposeEmailSheet.tsx');

  it('accepts replyToActivityId prop and calls loadReplyContext when set', () => {
    expect(SRC).toMatch(/replyToActivityId\?:\s*string \| null/);
    expect(SRC).toMatch(/loadReplyContext\(\s*\{\s*activityId:\s*replyToActivityId\s*\}\s*\)/);
  });

  it('renders compose-locked-sender in reply mode (Send-as picker hidden)', () => {
    expect(SRC).toMatch(/data-testid="compose-locked-sender"/);
    expect(SRC).toMatch(/replyMode \?/);
  });

  it('shows owner-disconnected banner + disables Send when reply owner is offline', () => {
    expect(SRC).toMatch(/data-testid="compose-owner-disconnected"/);
    expect(SRC).toMatch(/ownerDisconnected/);
  });
});

describe('LeadDetailClient — Reply buttons on email + email_reply', () => {
  const SRC = read('app/crm/leads/[id]/LeadDetailClient.tsx');

  it('renders a Reply button on email + email_reply rows only', () => {
    expect(SRC).toMatch(/a\.type === 'email' \|\| a\.type === 'email_reply'/);
    expect(SRC).toMatch(/data-testid=\{`crm-activity-reply:\$\{a\.id\}`\}/);
  });

  it('opens the compose sheet in reply mode via replyToActivityId', () => {
    expect(SRC).toMatch(/setReplyToActivityId\(a\.id\)/);
    expect(SRC).toMatch(/replyToActivityId=\{replyToActivityId\}/);
  });

  it('the fresh-compose button resets replyToActivityId first (so it opens in normal mode)', () => {
    expect(SRC).toMatch(/setReplyToActivityId\(null\);\s*setShowCompose\(true\)/);
  });
});

describe('files present', () => {
  const FILES = [
    'supabase/migrations/0073_crm_reply_headers.sql',
  ];
  it.each(FILES)('%s exists', (p) => {
    expect(existsSync(resolve(ROOT, p))).toBe(true);
  });
});
