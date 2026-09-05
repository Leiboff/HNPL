'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { getAccessToken, sendGmail, fetchMessageMetadata, fetchThread } from '@/lib/gmail/gmailClient';
import { substituteMergeFields } from '@/lib/gmail/mergeFields';
import { prefixReSubject, deriveSubjectFromOutboundTitle } from '@/lib/gmail/replySubject';
import {
  composeWithSignature,
  renderBrandSignatureHtml,
  renderBrandSignatureText,
  renderSignatureOverride,
  type SignatureData,
} from '@/lib/gmail/signature';

// ─── Compose + send + list templates + list accounts ─────────────────
//
// Since 0072: multiple Gmail addresses per user.
// Since 0073: reply mode — replying to a timeline activity lands in
// the same Gmail thread with proper In-Reply-To / References headers.

function svc() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}

type Guard = { ok: true; userId: string; role: 'sales' | 'admin' } | { ok: false; error: string };

async function guardSalesOrAdmin(): Promise<Guard> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: 'unauthenticated' };
  const { data: profile } = await supabase.from('profiles').select('role, first_name, last_name').eq('id', user.id).single();
  if (profile?.role !== 'sales' && profile?.role !== 'admin') return { ok: false, error: 'unauthorized' };
  return { ok: true, userId: user.id, role: profile.role as 'sales' | 'admin' };
}

// ─── listTemplates ───────────────────────────────────────────────────

export type TemplateRow = {
  id:      string;
  name:    string;
  subject: string;
  body:    string;
};

export async function listTemplates(): Promise<TemplateRow[]> {
  const g = await guardSalesOrAdmin();
  if (!g.ok) return [];
  const supabase = await createClient();
  const { data } = await supabase
    .from('crm_email_templates')
    .select('id, name, subject, body')
    .order('is_seed', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(50);
  return (data ?? []) as TemplateRow[];
}

// ─── listMyGmailAccounts — for the "Send as" selector ────────────────

export type ComposeAccount = {
  /** Discriminator: real connection vs shared alias. */
  kind:         'account' | 'alias';
  /** Stable id for the picker; sent back on send. Alias ids are the
   *  crm_sendas_aliases.id UUID; account ids are crm_email_accounts.id. */
  id:           string;
  /** The address the recipient will see (alias address for aliases). */
  gmailAddress: string;
  /** For aliases: the underlying connection's authenticated address
   *  ("via jess@…"). For real accounts: same as gmailAddress. */
  via:          string;
  /** Optional human label for aliases ("Support team"). */
  label:        string | null;
  isDefault:    boolean;
};

export async function listMyGmailAccounts(): Promise<ComposeAccount[]> {
  const g = await guardSalesOrAdmin();
  if (!g.ok) return [];
  const s = svc();

  // Real connections owned by this user.
  const { data: accounts } = await s
    .from('crm_email_accounts')
    .select('id, gmail_address, last_used_at, connected_at, status')
    .eq('user_id', g.userId)
    .eq('status', 'connected')
    .order('last_used_at', { ascending: false, nullsFirst: false })
    .order('connected_at', { ascending: false });

  const acctRows = (accounts ?? []) as Array<{ id: string; gmail_address: string }>;

  // Aliases eligible to this role. Joined with the underlying account
  // so we can render "alias@ via jess@" and validate the connection is
  // still connected.
  const { data: aliases } = await s
    .from('crm_sendas_aliases')
    .select(`
      id, alias_email, label, allowed_roles,
      crm_email_accounts!inner(id, gmail_address, status)
    `);

  type AliasRow = {
    id: string;
    alias_email: string;
    label: string | null;
    allowed_roles: string[];
    crm_email_accounts: { id: string; gmail_address: string; status: string } | { id: string; gmail_address: string; status: string }[];
  };
  const aliasRows = ((aliases ?? []) as AliasRow[]).filter(a => (a.allowed_roles ?? []).includes(g.role));

  const list: ComposeAccount[] = acctRows.map((r) => ({
    kind:         'account' as const,
    id:           r.id,
    gmailAddress: r.gmail_address,
    via:          r.gmail_address,
    label:        null,
    isDefault:    false,
  }));
  for (const a of aliasRows) {
    const conn = Array.isArray(a.crm_email_accounts) ? a.crm_email_accounts[0] : a.crm_email_accounts;
    if (!conn || conn.status !== 'connected') continue;
    list.push({
      kind:         'alias',
      id:           a.id,
      gmailAddress: a.alias_email,
      via:          conn.gmail_address,
      label:        a.label,
      isDefault:    false,
    });
  }
  if (list.length > 0) list[0].isDefault = true;
  return list;
}

// ─── previewCompose — pure merge preview (no send) ───────────────────

export type ComposePreview = {
  subject:  string;
  body:     string;
  signature?: { html: string; text: string } | null;
};

export async function previewCompose(input: {
  templateId?:    string | null;
  subject?:       string;
  body?:          string;
  leadId:         string;
  omitSignature?: boolean;
}): Promise<{ preview?: ComposePreview; error?: string }> {
  const g = await guardSalesOrAdmin();
  if (!g.ok) return { error: g.error };

  const supabase = await createClient();
  const { data: lead } = await supabase
    .from('crm_leads')
    .select('practice_name, contact_first_name, contact_last_name')
    .eq('id', input.leadId)
    .maybeSingle();
  if (!lead) return { error: 'lead_not_found' };

  const { data: me } = await supabase.from('profiles').select('first_name, last_name').eq('id', g.userId).single();

  let subject = input.subject ?? '';
  let body    = input.body    ?? '';
  if (input.templateId) {
    const { data: tpl } = await supabase
      .from('crm_email_templates')
      .select('subject, body')
      .eq('id', input.templateId)
      .maybeSingle();
    if (tpl) {
      subject = subject || (tpl.subject as string);
      body    = body    || (tpl.body    as string);
    }
  }

  const vars = {
    practice_name:      lead.practice_name       as string,
    contact_first_name: lead.contact_first_name  as string,
    contact_last_name:  lead.contact_last_name   as string,
    my_name:            [me?.first_name, me?.last_name].filter(Boolean).join(' ') || 'the betternow team',
  };

  const sig = input.omitSignature ? null : await buildSignatureForUser(g.userId);

  return {
    preview: {
      subject: substituteMergeFields(subject, vars),
      body:    substituteMergeFields(body,    vars),
      signature: sig,
    },
  };
}

async function buildSignatureForUser(
  userId: string,
): Promise<{ html: string; text: string } | null> {
  const s = svc();
  const { data } = await s
    .from('crm_signatures')
    .select('display_name, title, phone, email, html_override, text_fallback')
    .eq('user_id', userId)
    .maybeSingle();
  const row = (data ?? null) as {
    display_name:  string | null;
    title:         string | null;
    phone:         string | null;
    email:         string | null;
    html_override: string | null;
    text_fallback: string | null;
  } | null;
  const vars: SignatureData = {
    displayName: row?.display_name ?? '',
    title:       row?.title        ?? '',
    phone:       row?.phone        ?? '',
    email:       row?.email        ?? '',
  };
  if (row?.html_override) {
    return {
      html: renderSignatureOverride(row.html_override, vars),
      text: (row.text_fallback ?? '').trim() || renderBrandSignatureText(vars),
    };
  }
  if (!row) return null;
  return {
    html: renderBrandSignatureHtml(vars),
    text: (row.text_fallback ?? '').trim() || renderBrandSignatureText(vars),
  };
}

// ─── Reply mode: prefill context ─────────────────────────────────────

export type ReplyContext = {
  activityId:      string;
  leadId:          string;
  threadId:        string | null;
  /** Present when the anchor row has a captured RFC Message-Id.
   *  Missing (legacy pre-0073 rows) means the send path will resolve
   *  headers via a live thread fetch. */
  messageRfcId:    string | null;
  /** Prior References string, if any — resolved server-side on send. */
  references:      string | null;
  /** Where the reply goes. */
  to:              string;
  /** Subject with "Re: " prefixed unless already present (case-insensitive). */
  subject:         string;
  /** The sender the reply MUST go out from — either a real connection
   *  or a shared alias. Client cannot override; the send action re-
   *  verifies. */
  lockedAccount: {
    /** For real accounts: crm_email_accounts.id. For aliases:
     *  crm_sendas_aliases.id. */
    id:            string;
    /** The address the recipient will see (alias or authenticated). */
    gmailAddress:  string;
    /** "account" or "alias" — drives which id field the compose sheet
     *  sends back. */
    kind:          'account' | 'alias';
    /** For aliases: the authenticated Gmail address underneath
     *  ("via jess@…"). For real accounts: same as gmailAddress. */
    via:           string;
  } | null;
  /** Set when the account that owns the thread is no longer connected —
   *  the UI must NOT silently fall back to a different address. */
  ownerDisconnected: boolean;
};

/**
 * Resolve everything the compose sheet needs to open in reply mode
 * against a specific timeline activity. Sales/admin-guarded; returns
 * an error string on any failure. Never surfaces token material.
 */
export async function loadReplyContext(input: {
  activityId: string;
}): Promise<{ context?: ReplyContext; error?: string }> {
  const g = await guardSalesOrAdmin();
  if (!g.ok) return { error: g.error };

  const s = svc();
  const { data } = await s
    .from('crm_activities')
    .select('id, lead_id, type, title, gmail_thread_id, gmail_message_id, message_rfc_id, reply_from, sent_from')
    .eq('id', input.activityId)
    .maybeSingle();
  const activity = (data ?? null) as {
    id: string;
    lead_id: string;
    type: string;
    title: string | null;
    gmail_thread_id: string | null;
    gmail_message_id: string | null;
    message_rfc_id: string | null;
    reply_from: string | null;
    sent_from: string | null;
  } | null;
  if (!activity) return { error: 'activity_not_found' };
  if (activity.type !== 'email' && activity.type !== 'email_reply') {
    return { error: 'not_replyable' };
  }
  if (!activity.gmail_thread_id) return { error: 'thread_missing' };

  // Anchor recipient — depends on which side of the conversation the
  // anchor sits on.
  const { data: leadRow } = await s
    .from('crm_leads')
    .select('email')
    .eq('id', activity.lead_id)
    .maybeSingle();
  const leadEmail = (leadRow?.email as string | null) ?? null;

  let to: string | null;
  if (activity.type === 'email_reply') {
    to = activity.reply_from || leadEmail;
  } else {
    to = leadEmail;
  }
  if (!to) return { error: 'no_recipient' };

  // Find the sender that owns this thread — could be an alias or a
  // real connection. The reply MUST go out from the same address, or
  // Gmail creates a new thread for the counterparty.
  const ownerAddress = activity.sent_from;
  let lockedAccount: ReplyContext['lockedAccount'] = null;
  let ownerDisconnected = false;
  if (ownerAddress) {
    // Alias path first — aliases are usually the shared-team case.
    const { data: aliasRow } = await s
      .from('crm_sendas_aliases')
      .select(`
        id, alias_email, allowed_roles,
        crm_email_accounts!inner(id, gmail_address, status)
      `)
      .ilike('alias_email', ownerAddress)
      .maybeSingle();
    type AliasHit = {
      id: string;
      alias_email: string;
      allowed_roles: string[];
      crm_email_accounts: { id: string; gmail_address: string; status: string } | { id: string; gmail_address: string; status: string }[];
    };
    const alias = (aliasRow ?? null) as AliasHit | null;
    if (alias && (alias.allowed_roles ?? []).includes(g.role)) {
      const conn = Array.isArray(alias.crm_email_accounts) ? alias.crm_email_accounts[0] : alias.crm_email_accounts;
      if (conn && conn.status === 'connected') {
        lockedAccount = {
          id:           alias.id,
          gmailAddress: alias.alias_email,
          kind:         'alias',
          via:          conn.gmail_address,
        };
      } else {
        ownerDisconnected = true;
      }
    } else {
      const { data: acct } = await s
        .from('crm_email_accounts')
        .select('id, gmail_address, status')
        .eq('user_id', g.userId)
        .ilike('gmail_address', ownerAddress)
        .maybeSingle();
      const row = (acct ?? null) as { id: string; gmail_address: string; status: string } | null;
      if (row && row.status === 'connected') {
        lockedAccount = { id: row.id, gmailAddress: row.gmail_address, kind: 'account', via: row.gmail_address };
      } else {
        ownerDisconnected = true;
      }
    }
  } else {
    // Very old rows with no sent_from — no thread owner recorded. Fall
    // back to the user's default account; the UI still shows it as
    // locked to that address.
    const { data: acct } = await s
      .from('crm_email_accounts')
      .select('id, gmail_address, status, last_used_at, connected_at')
      .eq('user_id', g.userId)
      .eq('status', 'connected')
      .order('last_used_at', { ascending: false, nullsFirst: false })
      .order('connected_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    const row = (acct ?? null) as { id: string; gmail_address: string } | null;
    if (row) lockedAccount = { id: row.id, gmailAddress: row.gmail_address, kind: 'account', via: row.gmail_address };
  }

  // Subject: derive from the anchor's title if possible, else from
  // Gmail metadata (subject header). Prefix "Re: " idempotently.
  let subject = deriveSubjectFromOutboundTitle(activity.title) ?? '';
  if (!subject && lockedAccount && activity.gmail_message_id) {
    // Best-effort: reach into Gmail to fetch the anchor's Subject
    // header. Uses the underlying connection (aliases delegate here).
    const senderCheck = await resolveSender(g.userId, g.role,
      lockedAccount.kind === 'alias'
        ? { aliasId: lockedAccount.id }
        : { accountId: lockedAccount.id },
    );
    if (senderCheck.ok) {
      const tokenRes = await getAccessToken({ connectionId: senderCheck.connectionId });
      if ('accessToken' in tokenRes) {
        const meta = await fetchMessageMetadata(tokenRes.accessToken, activity.gmail_message_id).catch(() => null);
        if (meta?.subject) subject = meta.subject;
      }
    }
  }
  subject = prefixReSubject(subject);

  return {
    context: {
      activityId:        activity.id,
      leadId:            activity.lead_id,
      threadId:          activity.gmail_thread_id,
      messageRfcId:      activity.message_rfc_id,
      references:        null,   // References chain is passed through inside the send action from the anchor row.
      to,
      subject,
      lockedAccount,
      ownerDisconnected,
    },
  };
}

// ─── Sender resolver ────────────────────────────────────────────────
//
// Turns a compose payload's (accountId?, aliasId?) into the concrete
// { connectionId, fromEmail } used for the send. Enforces:
//   • Real accounts must belong to the caller (RLS + explicit check).
//   • Aliases must be role-eligible for the caller and attached to a
//     connected account.
// Never delegates to the client — this is the sole place send-as
// authority is granted.

type ResolvedSender = {
  ok:            true;
  connectionId:  string;
  gmailAddress:  string;   // authenticated address on the connection
  fromEmail:     string;   // what goes in the From header (alias or gmail)
  aliasId:       string | null;
  aliasLabel:    string | null;
} | {
  ok:    false;
  error: string;
};

async function resolveSender(
  userId:   string,
  role:     'sales' | 'admin',
  input:    { accountId?: string; aliasId?: string },
): Promise<ResolvedSender> {
  const s = svc();

  if (input.aliasId) {
    const { data } = await s
      .from('crm_sendas_aliases')
      .select(`
        id, alias_email, label, allowed_roles,
        crm_email_accounts!inner(id, gmail_address, status)
      `)
      .eq('id', input.aliasId)
      .maybeSingle();
    type AliasRow = {
      alias_email: string;
      label: string | null;
      allowed_roles: string[];
      crm_email_accounts: { id: string; gmail_address: string; status: string } | { id: string; gmail_address: string; status: string }[];
    };
    const row = (data ?? null) as AliasRow | null;
    if (!row) return { ok: false, error: 'alias_not_found' };
    if (!(row.allowed_roles ?? []).includes(role)) {
      return { ok: false, error: 'alias_not_allowed' };
    }
    const conn = Array.isArray(row.crm_email_accounts) ? row.crm_email_accounts[0] : row.crm_email_accounts;
    if (!conn) return { ok: false, error: 'alias_connection_missing' };
    if (conn.status !== 'connected') return { ok: false, error: 'alias_connection_disconnected' };
    return {
      ok:           true,
      connectionId: conn.id,
      gmailAddress: conn.gmail_address,
      fromEmail:    row.alias_email,
      aliasId:      input.aliasId,
      aliasLabel:   row.label,
    };
  }

  if (input.accountId) {
    // Explicit ownership check — do NOT rely on the earlier user_id
    // filter alone (returns null on mismatch, which upstream can't
    // distinguish from "not connected"). This surfaces a clear
    // `not_your_connection` error.
    const { data } = await s
      .from('crm_email_accounts')
      .select('id, user_id, gmail_address, status')
      .eq('id', input.accountId)
      .maybeSingle();
    const row = (data ?? null) as { id: string; user_id: string; gmail_address: string; status: string } | null;
    if (!row) return { ok: false, error: 'account_not_found' };
    if (row.user_id !== userId) return { ok: false, error: 'not_your_connection' };
    if (row.status !== 'connected') return { ok: false, error: 'gmail_reauth_required' };
    return {
      ok:           true,
      connectionId: row.id,
      gmailAddress: row.gmail_address,
      fromEmail:    row.gmail_address,
      aliasId:      null,
      aliasLabel:   null,
    };
  }

  // Fallback: user's most-recently-used connection.
  const { data } = await s
    .from('crm_email_accounts')
    .select('id, gmail_address, status')
    .eq('user_id', userId)
    .eq('status', 'connected')
    .order('last_used_at', { ascending: false, nullsFirst: false })
    .order('connected_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  const row = (data ?? null) as { id: string; gmail_address: string; status: string } | null;
  if (!row) return { ok: false, error: 'gmail_not_connected' };
  return {
    ok:           true,
    connectionId: row.id,
    gmailAddress: row.gmail_address,
    fromEmail:    row.gmail_address,
    aliasId:      null,
    aliasLabel:   null,
  };
}

// ─── Threading-header resolver (reply mode) ────────────────────────
//
// Given an anchor activity row and a live access token for the
// account that owns the thread, return the exact In-Reply-To +
// References strings to stamp onto the outbound reply. Never
// returns success with null values — the caller uses this result
// directly on sendGmail's args and Gmail requires the headers.

type ThreadingHeaders = {
  ok:              true;
  inReplyTo:       string;
  priorReferences: string | null;
} | {
  ok:    false;
  error: string;
};

type ReplyAnchorForResolver = {
  id:               string;
  gmail_thread_id:  string | null;
  gmail_message_id: string | null;
  message_rfc_id:   string | null;
};

async function resolveReplyThreadingHeaders(
  accessToken: string,
  anchor:      ReplyAnchorForResolver,
  s:           ReturnType<typeof svc>,
): Promise<ThreadingHeaders> {
  // Fast path — the anchor was ingested/sent after 0073 and has a
  // stored RFC id. Fetch its live References chain (optional) and
  // stamp.
  if (anchor.message_rfc_id && anchor.gmail_message_id) {
    let priorReferences: string | null = null;
    try {
      const meta = await fetchMessageMetadata(accessToken, anchor.gmail_message_id);
      if (meta?.references) priorReferences = meta.references;
    } catch (err) {
      // Metadata fetch failure is non-fatal here — we still have the
      // rfc id to stamp In-Reply-To. Log so we notice a systemic
      // issue.
      console.warn('[resolveReplyThreadingHeaders] rfc-id path metadata fetch failed', err);
    }
    return { ok: true, inReplyTo: anchor.message_rfc_id, priorReferences };
  }

  // Legacy path — the anchor row predates 0073 and has no rfc id.
  // We MUST resolve the headers live from Gmail; a threadId-only
  // send would fork the thread on the recipient side. This is the
  // production bug we're fixing.
  if (!anchor.gmail_thread_id) {
    // Should have been rejected earlier ("reply_anchor_no_thread")
    // but belt-and-braces.
    return { ok: false, error: 'reply_anchor_no_thread' };
  }

  let messages: Awaited<ReturnType<typeof fetchThread>>;
  try {
    messages = await fetchThread(accessToken, anchor.gmail_thread_id);
  } catch (err) {
    console.error('[resolveReplyThreadingHeaders] thread fetch failed', err);
    return { ok: false, error: 'reply_threading_headers_unavailable' };
  }
  if (!messages.length) {
    return { ok: false, error: 'reply_threading_headers_unavailable' };
  }

  // Take the LAST message on the thread — that's the tip we're
  // replying to.
  const tip = messages[messages.length - 1];
  if (!tip.rfcMessageId) {
    // Gmail returned messages but none carried a Message-Id header.
    // Refuse to send rather than emit a headerless reply.
    return { ok: false, error: 'reply_threading_headers_unavailable' };
  }

  // References chain: prior refs on the tip + tip's own message-id.
  const priorReferences = tip.references
    ? `${tip.references.trim()} ${tip.rfcMessageId}`
    : tip.rfcMessageId;

  // Backfill the anchor row so subsequent replies skip the live
  // fetch. If the tip we found happens to be a different message
  // than the anchor (multi-message thread), we still stamp the
  // anchor with ITS own resolved rfc id — but for legacy rows the
  // anchor's gmail_message_id points at a specific message, so we
  // want ITS Message-Id if we can find it, else the tip's.
  const anchorMsg = anchor.gmail_message_id
    ? messages.find(m => m.id === anchor.gmail_message_id)
    : undefined;
  const rfcForAnchor = anchorMsg?.rfcMessageId ?? tip.rfcMessageId;
  try {
    await s.from('crm_activities')
      .update({ message_rfc_id: rfcForAnchor })
      .eq('id', anchor.id);
  } catch (err) {
    console.warn('[resolveReplyThreadingHeaders] backfill failed', err);
  }

  return { ok: true, inReplyTo: tip.rfcMessageId, priorReferences };
}

// ─── Own Message-Id capture ────────────────────────────────────────
//
// After a successful send, we ALWAYS fetch messages.get(metadata) so
// the outbound activity row carries its Message-Id header. This is
// what future replies-to-us stamp into In-Reply-To — the reliable
// alternative to the previous "best-effort" fire-and-forget.

async function captureOwnMessageId(
  accessToken: string,
  messageId:   string,
  s:           ReturnType<typeof svc>,
  attempt:     number = 0,
): Promise<void> {
  const meta = await fetchMessageMetadata(accessToken, messageId);
  if (meta?.rfcMessageId) {
    await s.from('crm_activities')
      .update({ message_rfc_id: meta.rfcMessageId })
      .eq('gmail_message_id', messageId);
    return;
  }
  // Rare eventual-consistency window — retry once after a short
  // wait. A second miss is logged so we can notice a systemic issue.
  if (attempt < 1) {
    await new Promise(resolve => setTimeout(resolve, 300));
    return captureOwnMessageId(accessToken, messageId, s, attempt + 1);
  }
  console.warn('[captureOwnMessageId] Message-Id absent after retry', { messageId });
}

// ─── sendComposedEmail — Gmail send + activity log ─────────────────

export async function sendComposedEmail(input: {
  leadId:         string;
  subject:        string;
  body:           string;
  accountId?:     string;
  /** Send-as-alias picker id. Mutually exclusive with accountId. */
  aliasId?:       string;
  omitSignature?: boolean;
  /** Present in reply mode. When set the account is enforced against
   *  the anchor's sent_from — any mismatch is rejected. */
  replyToActivityId?: string;
  /** When set, override the lead's primary email as the recipient. Used
   *  by the practice-invite send (recipient = the picked contact, which
   *  may not be the mirrored primary). Ignored in reply mode. */
  recipientEmailOverride?: string;
}): Promise<{ error?: string; needsReconnect?: boolean; warning?: string }> {
  const g = await guardSalesOrAdmin();
  if (!g.ok) return { error: g.error };

  const supabase = await createClient();
  const { data: lead } = await supabase
    .from('crm_leads')
    .select('id, practice_name, email')
    .eq('id', input.leadId)
    .maybeSingle();
  if (!lead) return { error: 'lead_not_found' };

  const s = svc();

  // ── Reply-mode context lookup ────────────────────────────────────
  //
  // In reply mode we override the recipient with the anchor's
  // counterparty and lock the send account to the thread owner.
  // Threading headers are derived from the anchor row.
  type ReplyAnchor = {
    id: string;
    lead_id: string;
    gmail_thread_id: string | null;
    gmail_message_id: string | null;
    message_rfc_id: string | null;
    reply_from: string | null;
    sent_from: string | null;
    type: string;
  };
  let anchor: ReplyAnchor | null = null;
  if (input.replyToActivityId) {
    const { data } = await s
      .from('crm_activities')
      .select('id, lead_id, gmail_thread_id, gmail_message_id, message_rfc_id, reply_from, sent_from, type')
      .eq('id', input.replyToActivityId)
      .maybeSingle();
    anchor = (data ?? null) as ReplyAnchor | null;
    if (!anchor) return { error: 'reply_anchor_not_found' };
    if (anchor.lead_id !== lead.id) return { error: 'reply_anchor_mismatched_lead' };
    if (!anchor.gmail_thread_id) return { error: 'reply_anchor_no_thread' };
  }

  // Compute recipient: reply mode overrides. Otherwise, the caller may
  // pass recipientEmailOverride to target a non-primary contact (used
  // by the practice-invite flow).
  let recipient: string | null = lead.email;
  if (anchor) {
    recipient = anchor.type === 'email_reply' ? (anchor.reply_from || lead.email) : lead.email;
  } else if (input.recipientEmailOverride) {
    recipient = input.recipientEmailOverride;
  }
  if (!recipient) return { error: 'lead_has_no_email' };

  // Compute sender: reply mode locks to the thread owner, which may
  // be a real connection OR an alias (previous alias sends recorded
  // sent_from = alias_email).
  let senderIn: { accountId?: string; aliasId?: string };
  if (anchor) {
    if (!anchor.sent_from) return { error: 'reply_anchor_owner_unknown' };

    // Check for an alias first — alias addresses are usually shared
    // and there's exactly one alias row per (connection, email).
    const { data: aliasHit } = await s
      .from('crm_sendas_aliases')
      .select('id, allowed_roles, crm_email_accounts!inner(status)')
      .ilike('alias_email', anchor.sent_from)
      .maybeSingle();
    type AliasHit = {
      id: string;
      allowed_roles: string[];
      crm_email_accounts: { status: string } | { status: string }[];
    };
    const aliasRow = (aliasHit ?? null) as AliasHit | null;
    if (aliasRow) {
      if (!(aliasRow.allowed_roles ?? []).includes(g.role)) {
        return { error: 'reply_owner_locked' };
      }
      // Guard: the client cannot switch to a different account/alias.
      if (input.accountId) return { error: 'reply_owner_locked' };
      if (input.aliasId && input.aliasId !== aliasRow.id) return { error: 'reply_owner_locked' };
      senderIn = { aliasId: aliasRow.id };
    } else {
      // Real-connection owner. Must be the caller's own row.
      const { data: acct } = await s
        .from('crm_email_accounts')
        .select('id, status')
        .eq('user_id', g.userId)
        .ilike('gmail_address', anchor.sent_from)
        .maybeSingle();
      const row = (acct ?? null) as { id: string; status: string } | null;
      if (!row || row.status !== 'connected') {
        return { error: 'reply_owner_disconnected', needsReconnect: true };
      }
      // Guard against the client trying to override the account.
      if (input.accountId && input.accountId !== row.id) {
        return { error: 'reply_owner_locked' };
      }
      if (input.aliasId) return { error: 'reply_owner_locked' };
      senderIn = { accountId: row.id };
    }
  } else {
    senderIn = { accountId: input.accountId, aliasId: input.aliasId };
  }

  const sender = await resolveSender(g.userId, g.role, senderIn);
  if (!sender.ok) {
    if (sender.error === 'gmail_reauth_required' || sender.error === 'alias_connection_disconnected') {
      return { error: sender.error, needsReconnect: true };
    }
    return { error: sender.error };
  }
  // Bypass user_id ownership on the token fetch — an alias may point
  // at a connection owned by another user (e.g. admin sends via a
  // sales user's Gmail). resolveSender has already granted authority.
  const selector: Parameters<typeof getAccessToken>[0] = {
    connectionId: sender.connectionId,
  };

  const { data: me } = await supabase.from('profiles').select('first_name, last_name').eq('id', g.userId).single();
  const fromName = [me?.first_name, me?.last_name].filter(Boolean).join(' ') || 'betternow';

  const tokenRes = await getAccessToken(selector);
  if ('error' in tokenRes) {
    if (tokenRes.error === 'gmail_not_connected' || tokenRes.error === 'gmail_reauth_required') {
      return { error: tokenRes.error, needsReconnect: true };
    }
    return { error: tokenRes.error };
  }

  // ── Resolve threading headers in reply mode ──────────────────
  //
  // We NEVER send a reply without In-Reply-To + References. Two
  // paths:
  //
  //   • Anchor has message_rfc_id → use it directly; pull prior
  //     References via a metadata fetch on the anchor's message.
  //
  //   • Anchor lacks message_rfc_id (legacy pre-0073 row) → fetch
  //     the whole thread live, take the LAST message's Message-Id
  //     as In-Reply-To and its `References + Message-Id` chain as
  //     References. Backfill message_rfc_id onto the anchor row so
  //     the next reply skips the fetch.
  //
  // If the live fetch itself fails, we ABORT — no headerless send.
  let inReplyTo: string | null = null;
  let priorReferences: string | null = null;
  if (anchor) {
    const resolved = await resolveReplyThreadingHeaders(
      tokenRes.accessToken,
      anchor,
      s,
    );
    if (!resolved.ok) {
      return { error: resolved.error };
    }
    inReplyTo       = resolved.inReplyTo;
    priorReferences = resolved.priorReferences;
  }

  const sig = input.omitSignature ? null : await buildSignatureForUser(g.userId);
  const composed = composeWithSignature({
    bodyText:      input.body,
    signatureHtml: sig?.html ?? '',
    signatureText: sig?.text ?? '',
    omitSignature: !sig || input.omitSignature,
  });

  let sendResult: { messageId: string; threadId: string };
  try {
    sendResult = await sendGmail({
      accessToken: tokenRes.accessToken,
      from:        sender.fromEmail,                // alias-aware
      fromName,
      to:          recipient,
      subject:     input.subject,
      bodyText:    composed.bodyText,
      bodyHtml:    composed.bodyHtml || undefined,
      threadId:    anchor?.gmail_thread_id ?? undefined,
      inReplyTo:   inReplyTo ?? undefined,
      references:  priorReferences ?? undefined,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'send_failed';
    if (/401|invalid_grant|Invalid Credentials/i.test(msg)) {
      await s.from('crm_email_accounts')
        .update({ status: 'reauth_required' })
        .eq('id', tokenRes.account.id);
      return { error: 'gmail_reauth_required', needsReconnect: true };
    }
    return { error: msg.slice(0, 200) };
  }

  const { messageId, threadId } = sendResult;

  // ── Alias-rewrite detection ──────────────────────────────────────
  //
  // If the alias isn't registered under the Gmail account's own
  // "Send mail as" settings, Gmail silently rewrites the From header
  // to the authenticated address. Detect it: fetch the sent message's
  // From header and compare with sender.fromEmail. On mismatch, log
  // a warning note on the timeline and surface a clear message to the
  // caller. The send itself still happened, but the recipient saw the
  // wrong From — worth telling the admin explicitly.
  let aliasWarning: string | null = null;
  if (sender.aliasId) {
    try {
      const meta = await fetchMessageMetadata(tokenRes.accessToken, messageId);
      const actualFrom = extractBareEmail(meta?.from ?? '');
      const expected   = sender.fromEmail.toLowerCase();
      if (actualFrom && actualFrom.toLowerCase() !== expected) {
        aliasWarning = `alias_rewritten:${sender.fromEmail}:${actualFrom}`;
        console.warn('[sendComposedEmail] Gmail rewrote From — alias not registered under Send mail as', {
          expected, actual: actualFrom,
        });
        // Timeline note so admins see this in situ, not just in logs.
        await s.from('crm_activities').insert({
          lead_id:     lead.id,
          type:        'note',
          title:       'Alias not configured in Gmail',
          body:        `Attempted to send as ${sender.fromEmail} but Gmail sent as ${actualFrom}. `
                      + 'Register the alias under Gmail Settings → Accounts → Send mail as, then retry.',
          occurred_at: new Date().toISOString(),
          created_by:  g.userId,
        });
      }
    } catch (err) {
      console.warn('[sendComposedEmail] alias-rewrite verification failed', err);
    }
  }

  // Log the outbound activity — same thread id so subsequent inbound
  // replies keep matching this lead. sent_from carries the alias
  // address (what the recipient saw) — matches attribution rendering.
  await s.from('crm_activities').insert({
    lead_id:          lead.id,
    type:             'email',
    title:            `Email sent: ${input.subject.slice(0, 60)}`,
    body:             input.body.slice(0, 4000),
    occurred_at:      new Date().toISOString(),
    created_by:       g.userId,
    gmail_thread_id:  threadId,
    gmail_message_id: messageId,
    sent_from:        sender.fromEmail,
  });

  // Reliable own-Message-Id capture. Gmail's send response only
  // returns { id, threadId } (no header), so we always follow with
  // messages.get(format=metadata). One retry after 300ms handles
  // the rare eventual-consistency window; a final absence is logged
  // as a warning (the row simply lacks message_rfc_id and the next
  // reply-mode send resolves headers via the thread-fetch path).
  await captureOwnMessageId(tokenRes.accessToken, messageId, s).catch(err => {
    console.warn('[sendComposedEmail] own message-id capture failed', err);
  });

  await s.from('crm_email_accounts')
    .update({ last_used_at: new Date().toISOString() })
    .eq('id', tokenRes.account.id);

  revalidatePath(`/crm/leads/${lead.id}`);
  return aliasWarning ? { warning: aliasWarning } : {};
}

function extractBareEmail(fromHeader: string): string {
  if (!fromHeader) return '';
  const m = fromHeader.match(/<\s*([^<>\s]+@[^<>\s]+)\s*>/);
  if (m) return m[1];
  const bare = fromHeader.trim();
  return /@/.test(bare) ? bare : '';
}
