'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { getAccessToken, sendGmail, fetchMessageMetadata } from '@/lib/gmail/gmailClient';
import { substituteMergeFields } from '@/lib/gmail/mergeFields';
import { prefixReSubject, deriveSubjectFromOutboundTitle } from '@/lib/gmail/replySubject';
import {
  applySignatureMergeFields,
  composeWithSignature,
  renderBrandSignatureHtml,
  renderBrandSignatureText,
  sanitizeSignatureHtml,
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

type Guard = { ok: true; userId: string } | { ok: false; error: string };

async function guardSalesOrAdmin(): Promise<Guard> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: 'unauthenticated' };
  const { data: profile } = await supabase.from('profiles').select('role, first_name, last_name').eq('id', user.id).single();
  if (profile?.role !== 'sales' && profile?.role !== 'admin') return { ok: false, error: 'unauthorized' };
  return { ok: true, userId: user.id };
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
  id:           string;
  gmailAddress: string;
  isDefault:    boolean;
};

export async function listMyGmailAccounts(): Promise<ComposeAccount[]> {
  const g = await guardSalesOrAdmin();
  if (!g.ok) return [];
  const s = svc();
  const { data } = await s
    .from('crm_email_accounts')
    .select('id, gmail_address, last_used_at, connected_at, status')
    .eq('user_id', g.userId)
    .eq('status', 'connected')
    .order('last_used_at', { ascending: false, nullsFirst: false })
    .order('connected_at', { ascending: false });
  const rows = (data ?? []) as Array<{ id: string; gmail_address: string }>;
  return rows.map((r, i) => ({
    id:           r.id,
    gmailAddress: r.gmail_address,
    isDefault:    i === 0,
  }));
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
      html: applySignatureMergeFields(sanitizeSignatureHtml(row.html_override), vars),
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
  /** Present when the anchor row has a captured RFC Message-Id; falls
   *  back to threadId-only sends when null. */
  messageRfcId:    string | null;
  /** Prior References string, if any — passed through when we compose. */
  references:      string | null;
  /** Where the reply goes. */
  to:              string;
  /** Subject with "Re: " prefixed unless already present (case-insensitive). */
  subject:         string;
  /** The account that owns the thread (must be used to send). */
  lockedAccount: {
    id:            string;
    gmailAddress:  string;
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

  // Find the connected account that owns this thread. The reply MUST
  // go out from the same address — otherwise Gmail creates a new
  // thread for the counterparty and threading breaks for them.
  const ownerAddress = activity.sent_from;
  let lockedAccount: ReplyContext['lockedAccount'] = null;
  let ownerDisconnected = false;
  if (ownerAddress) {
    const { data: acct } = await s
      .from('crm_email_accounts')
      .select('id, gmail_address, status')
      .eq('user_id', g.userId)
      .ilike('gmail_address', ownerAddress)
      .maybeSingle();
    const row = (acct ?? null) as { id: string; gmail_address: string; status: string } | null;
    if (row && row.status === 'connected') {
      lockedAccount = { id: row.id, gmailAddress: row.gmail_address };
    } else {
      ownerDisconnected = true;
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
    if (row) lockedAccount = { id: row.id, gmailAddress: row.gmail_address };
  }

  // Subject: derive from the anchor's title if possible, else from
  // Gmail metadata (subject header). Prefix "Re: " idempotently.
  let subject = deriveSubjectFromOutboundTitle(activity.title) ?? '';
  if (!subject && lockedAccount && activity.gmail_message_id) {
    // Best-effort: reach into Gmail to fetch the anchor's Subject header.
    // If the token refresh fails, fall through with an empty subject
    // (the user can type one).
    const tokenRes = await getAccessToken({ userId: g.userId, accountId: lockedAccount.id });
    if ('accessToken' in tokenRes) {
      const meta = await fetchMessageMetadata(tokenRes.accessToken, activity.gmail_message_id).catch(() => null);
      if (meta?.subject) subject = meta.subject;
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

// ─── sendComposedEmail — Gmail send + activity log ─────────────────

export async function sendComposedEmail(input: {
  leadId:         string;
  subject:        string;
  body:           string;
  accountId?:     string;
  omitSignature?: boolean;
  /** Present in reply mode. When set the account is enforced against
   *  the anchor's sent_from — any mismatch is rejected. */
  replyToActivityId?: string;
}): Promise<{ error?: string; needsReconnect?: boolean }> {
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
  let priorReferences: string | null = null;
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

    // References: pull from the anchor's live Gmail metadata if we
    // have the message id. Missing metadata → fall back to just
    // In-Reply-To (Gmail-side threading still works via threadId).
    // We attempt this only when the anchor has a rfc id — otherwise
    // there's no header to build a References chain around anyway.
  }

  // Compute recipient: reply mode overrides.
  let recipient: string | null = lead.email;
  if (anchor) {
    recipient = anchor.type === 'email_reply' ? (anchor.reply_from || lead.email) : lead.email;
  }
  if (!recipient) return { error: 'lead_has_no_email' };

  // Compute account selector: reply mode locks to the thread owner.
  let selector: Parameters<typeof getAccessToken>[0];
  if (anchor) {
    if (!anchor.sent_from) return { error: 'reply_anchor_owner_unknown' };
    // Confirm the anchor's owning address is still connected for this user.
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
    selector = { userId: g.userId, accountId: row.id };
  } else {
    selector = input.accountId
      ? { userId: g.userId, accountId: input.accountId }
      : { userId: g.userId };
  }

  const { data: me } = await supabase.from('profiles').select('first_name, last_name').eq('id', g.userId).single();
  const fromName = [me?.first_name, me?.last_name].filter(Boolean).join(' ') || 'betternow';

  const tokenRes = await getAccessToken(selector);
  if ('error' in tokenRes) {
    if (tokenRes.error === 'gmail_not_connected' || tokenRes.error === 'gmail_reauth_required') {
      return { error: tokenRes.error, needsReconnect: true };
    }
    return { error: tokenRes.error };
  }

  // Pull the anchor's prior References from Gmail metadata if we're
  // replying and we have the rfc id — this happens AFTER token refresh
  // so we don't need to re-authenticate.
  if (anchor && anchor.message_rfc_id && anchor.gmail_message_id) {
    const meta = await fetchMessageMetadata(tokenRes.accessToken, anchor.gmail_message_id).catch(() => null);
    if (meta?.references) priorReferences = meta.references;
  }

  const sig = input.omitSignature ? null : await buildSignatureForUser(g.userId);
  const composed = composeWithSignature({
    bodyText:      input.body,
    signatureHtml: sig?.html ?? '',
    signatureText: sig?.text ?? '',
    omitSignature: !sig || input.omitSignature,
  });

  try {
    const { messageId, threadId } = await sendGmail({
      accessToken: tokenRes.accessToken,
      from:        tokenRes.account.gmail_address,
      fromName,
      to:          recipient,
      subject:     input.subject,
      bodyText:    composed.bodyText,
      bodyHtml:    composed.bodyHtml || undefined,
      threadId:    anchor?.gmail_thread_id ?? undefined,
      inReplyTo:   anchor?.message_rfc_id ?? undefined,
      references:  priorReferences ?? undefined,
    });

    // Log the outbound activity — same thread id so subsequent inbound
    // replies keep matching this lead.
    await s.from('crm_activities').insert({
      lead_id:          lead.id,
      type:             'email',
      title:            `Email sent: ${input.subject.slice(0, 60)}`,
      body:             input.body.slice(0, 4000),
      occurred_at:      new Date().toISOString(),
      created_by:       g.userId,
      gmail_thread_id:  threadId,
      gmail_message_id: messageId,
      sent_from:        tokenRes.account.gmail_address,
    });

    // Best-effort: capture our OWN Message-Id header via a metadata
    // lookback so future replies-to-us can stamp In-Reply-To. Failure
    // is non-fatal — send succeeded; the row just lacks message_rfc_id
    // and the reply-mode UI degrades to threadId-only.
    fetchMessageMetadata(tokenRes.accessToken, messageId)
      .then(async (meta) => {
        if (meta?.rfcMessageId) {
          await s.from('crm_activities')
            .update({ message_rfc_id: meta.rfcMessageId })
            .eq('gmail_message_id', messageId);
        }
      })
      .catch(err => console.warn('[sendComposedEmail] own message-id capture failed', err));

    await s.from('crm_email_accounts')
      .update({ last_used_at: new Date().toISOString() })
      .eq('id', tokenRes.account.id);

    revalidatePath(`/crm/leads/${lead.id}`);
    return {};
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
}
