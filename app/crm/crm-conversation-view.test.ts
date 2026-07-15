import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── Source-pin regressions for the conversation-view pass ──────────

const ROOT = resolve(process.cwd());
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

describe('PART 1 — ingestion fetches full body + entity-decodes', () => {
  const SRC = read('lib/gmail/replyIngest.ts');
  const CLI = read('lib/gmail/gmailClient.ts');
  const EX  = read('lib/gmail/extractBody.ts');

  it('gmailClient exposes fetchMessageFull (format=full) — no metadata-only shortcut', () => {
    expect(CLI).toMatch(/export async function fetchMessageFull/);
    expect(CLI).toMatch(/\?format=full/);
    expect(CLI).toMatch(/bodyPlain:\s*string \| null/);
    expect(CLI).toMatch(/bodyHtml:\s*string \| null/);
  });

  it('ingestOneMessage receives an accessToken and stores the chosen body (not snippet)', () => {
    expect(SRC).toMatch(/accessToken:\s*string,?\s*\n\s*\):/);
    expect(SRC).toMatch(/chooseIngestBody\({/);
    expect(SRC).toMatch(/body:\s*bodyText/);
    // The pre-fix branch that wrote message.snippet is gone.
    expect(SRC).not.toMatch(/body:\s*message\.snippet,/);
  });

  it('sweepAllThreadsForAccount + push endpoint pass the accessToken through', () => {
    expect(SRC).toMatch(/ingestOneMessage\(account, m, accessToken\)/);
    const PUSH = read('app/api/crm/gmail/push/route.ts');
    expect(PUSH).toMatch(/ingestOneMessage\([\s\S]*?meta,\s*accessToken/);
  });

  it('entity decoder covers the entities Gmail actually emits', () => {
    expect(EX).toMatch(/amp/);
    expect(EX).toMatch(/lt/);
    expect(EX).toMatch(/gt/);
    expect(EX).toMatch(/nbsp/);
    expect(EX).toMatch(/mdash/);
  });

  it('occurred_at still derives from internalDate (Step 0 confirmed)', () => {
    expect(SRC).toMatch(/new Date\(Number\(message\.internalDate\)\)\.toISOString\(\)/);
  });
});

describe('PART 2 — splitQuoted rendering module', () => {
  const SRC = read('lib/gmail/quoteSplit.ts');

  it('exports splitQuoted, materialiseSplit, firstLine, findFirstQuoteCue', () => {
    expect(SRC).toMatch(/export function splitQuoted/);
    expect(SRC).toMatch(/export function materialiseSplit/);
    expect(SRC).toMatch(/export function firstLine/);
    expect(SRC).toMatch(/export function findFirstQuoteCue/);
  });

  it('detects all four quote cues (Gmail attribution, Outlook headers, > lines, signature)', () => {
    expect(SRC).toMatch(/On\\b/);
    expect(SRC).toMatch(/wrote\\s\*:/);
    expect(SRC).toMatch(/From\|Sent\|To\|Subject/);
    expect(SRC).toMatch(/QUOTE_LINE_RE/);
    expect(SRC).toMatch(/SIG_DELIM_RE/);
  });
});

describe('PART 3 — conversation view integration', () => {
  const GRP = read('app/crm/leads/[id]/conversationGrouper.ts');
  const CARD = read('app/crm/leads/[id]/ConversationCard.tsx');
  const LDC  = read('app/crm/leads/[id]/LeadDetailClient.tsx');
  const PAGE = read('app/crm/leads/[id]/page.tsx');

  it('page.tsx fetches the thread + message ids needed for grouping', () => {
    expect(PAGE).toMatch(/gmail_thread_id/);
    expect(PAGE).toMatch(/gmail_message_id/);
    expect(PAGE).toMatch(/reply_from/);
  });

  it('groupTimeline positions conversations by their latest message', () => {
    expect(GRP).toMatch(/export function groupTimeline/);
    expect(GRP).toMatch(/latest\.occurred_at/);
    expect(GRP).toMatch(/compareByPositionAtDesc/);
  });

  it('LeadDetailClient renders ConversationCard for grouped items and preserves standalone rows', () => {
    expect(LDC).toMatch(/import ConversationCard/);
    expect(LDC).toMatch(/groupTimeline/);
    expect(LDC).toMatch(/item\.kind === 'conversation'/);
  });

  it('ConversationCard shows collapsed summary + expand toggle + Reply button', () => {
    expect(CARD).toMatch(/data-testid="crm-conversation-count"/);
    expect(CARD).toMatch(/data-testid="crm-conversation-toggle"/);
    expect(CARD).toMatch(/data-testid=\{`crm-conversation-reply:/);
    expect(CARD).toMatch(/data-testid="crm-conversation-preview"/);
  });

  it('directional styling — sent vs received (data-direction) + brand-tinted avatars', () => {
    expect(CARD).toMatch(/data-direction=\{isSent \? 'sent' : 'received'\}/);
    expect(CARD).toMatch(/function Avatar/);
    expect(CARD).toMatch(/#13294B/);
    expect(CARD).toMatch(/#15A89E/);
  });

  it('••• quoted-text toggle uses the split shape and respects reduced motion', () => {
    expect(CARD).toMatch(/materialiseSplit/);
    expect(CARD).toMatch(/setQuotesOpen/);
    expect(CARD).toMatch(/•••/);
    expect(CARD).toMatch(/prefers-reduced-motion/);
  });

  it('latest message opens by default; older messages collapsed', () => {
    expect(CARD).toMatch(/isLatest/);
    expect(CARD).toMatch(/useState\(isLatest\)/);
  });

  it('SAST time formatting via Intl (Africa/Johannesburg)', () => {
    expect(CARD).toMatch(/Africa\/Johannesburg/);
    expect(CARD).toMatch(/en-ZA/);
  });
});

describe('no migration this pass', () => {
  it('does not add a 0075 migration', () => {
    expect(existsSync(resolve(ROOT, 'supabase/migrations/0075_conversation_view.sql'))).toBe(false);
  });
});
