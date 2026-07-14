'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { getAccessToken, sendGmail } from '@/lib/gmail/gmailClient';
import { substituteMergeFields } from '@/lib/gmail/mergeFields';
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
// Since 0072: sales/admin users may connect several Gmail addresses.
// Compose accepts an accountId; if omitted, the user's most-recently-
// used connection is picked (last_used_at desc, connected_at fallback).
// Signature is auto-appended (per-send toggle to omit).

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

// ─── sendComposedEmail — actually send via Gmail + log activity ─────

export async function sendComposedEmail(input: {
  leadId:         string;
  subject:        string;
  body:           string;
  accountId?:     string;
  omitSignature?: boolean;
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
  if (!lead.email) return { error: 'lead_has_no_email' };

  const { data: me } = await supabase.from('profiles').select('first_name, last_name').eq('id', g.userId).single();
  const fromName = [me?.first_name, me?.last_name].filter(Boolean).join(' ') || 'betternow';

  const selector = input.accountId
    ? { userId: g.userId, accountId: input.accountId }
    : { userId: g.userId };
  const tokenRes = await getAccessToken(selector);
  if ('error' in tokenRes) {
    if (tokenRes.error === 'gmail_not_connected' || tokenRes.error === 'gmail_reauth_required') {
      return { error: tokenRes.error, needsReconnect: true };
    }
    return { error: tokenRes.error };
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
      to:          lead.email,
      subject:     input.subject,
      bodyText:    composed.bodyText,
      bodyHtml:    composed.bodyHtml || undefined,
    });

    // Log activity via service-role so the insert lands regardless of
    // RLS drift. If we sent an email we MUST have a row.
    const s = svc();
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
    await s.from('crm_email_accounts')
      .update({ last_used_at: new Date().toISOString() })
      .eq('id', tokenRes.account.id);

    revalidatePath(`/crm/leads/${lead.id}`);
    return {};
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'send_failed';
    if (/401|invalid_grant|Invalid Credentials/i.test(msg)) {
      const s = svc();
      await s.from('crm_email_accounts')
        .update({ status: 'reauth_required' })
        .eq('id', tokenRes.account.id);
      return { error: 'gmail_reauth_required', needsReconnect: true };
    }
    return { error: msg.slice(0, 200) };
  }
}
