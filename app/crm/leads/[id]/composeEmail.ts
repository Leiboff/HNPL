'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { getAccessToken, sendGmail } from '@/lib/gmail/gmailClient';
import { substituteMergeFields } from '@/lib/gmail/mergeFields';

// ─── Server actions: compose + send + list templates ─────────────────

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

// ─── previewCompose — pure merge preview (no send) ───────────────────

export type ComposePreview = {
  subject: string;
  body:    string;
};

export async function previewCompose(input: {
  templateId?:   string | null;
  subject?:      string;
  body?:         string;
  leadId:        string;
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
  return {
    preview: {
      subject: substituteMergeFields(subject, vars),
      body:    substituteMergeFields(body,    vars),
    },
  };
}

// ─── sendEmail — actually send via Gmail + log activity ─────────────

export async function sendComposedEmail(input: {
  leadId:  string;
  subject: string;
  body:    string;
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

  const tokenRes = await getAccessToken(g.userId);
  if ('error' in tokenRes) {
    if (tokenRes.error === 'gmail_not_connected' || tokenRes.error === 'gmail_reauth_required') {
      return { error: tokenRes.error, needsReconnect: true };
    }
    return { error: tokenRes.error };
  }

  try {
    const { messageId, threadId } = await sendGmail({
      accessToken: tokenRes.accessToken,
      from:        tokenRes.account.gmail_address,
      fromName,
      to:          lead.email,
      subject:     input.subject,
      bodyText:    input.body,
    });

    // Log the activity via the service-role client to guarantee the
    // insert lands (RLS is fine for sales/admin, but the send path is
    // considered atomic — if we just sent an email, we MUST record it).
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
    });

    revalidatePath(`/crm/leads/${lead.id}`);
    return {};
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'send_failed';
    // 401 from Gmail → reauth
    if (/401|invalid_grant|Invalid Credentials/i.test(msg)) {
      const s = svc();
      await s.from('crm_email_accounts').update({ status: 'reauth_required' }).eq('user_id', g.userId);
      return { error: 'gmail_reauth_required', needsReconnect: true };
    }
    return { error: msg.slice(0, 200) };
  }
}
