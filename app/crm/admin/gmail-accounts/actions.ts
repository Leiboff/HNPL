'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { revokeGmailAccountById } from '@/lib/gmail/gmailClient';

// ─── Admin: revoke another user's Gmail connection ────────────────

function svc() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}

type Guard = { ok: true; adminId: string } | { ok: false; error: string };

async function guardAdmin(): Promise<Guard> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: 'unauthenticated' };
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single();
  if (profile?.role !== 'admin') return { ok: false, error: 'unauthorized' };
  return { ok: true, adminId: user.id };
}

export async function adminAddSendAsAlias(input: {
  connectionId: string;
  aliasEmail:   string;
  label?:       string;
  allowedRoles: Array<'sales' | 'admin'>;
}): Promise<{ ok: boolean; error?: string; aliasId?: string }> {
  const g = await guardAdmin();
  if (!g.ok) return { ok: false, error: g.error };

  const aliasEmail = (input.aliasEmail ?? '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(aliasEmail)) {
    return { ok: false, error: 'invalid_email' };
  }
  const rolesSet = new Set(input.allowedRoles ?? []);
  const roles = Array.from(rolesSet).filter(r => r === 'sales' || r === 'admin');
  if (roles.length === 0) return { ok: false, error: 'no_roles' };

  const s = svc();
  const { data: existingConn } = await s
    .from('crm_email_accounts')
    .select('id')
    .eq('id', input.connectionId)
    .maybeSingle();
  if (!existingConn) return { ok: false, error: 'connection_not_found' };

  const { data: insertRow, error } = await s
    .from('crm_sendas_aliases')
    .insert({
      connection_id: input.connectionId,
      alias_email:   aliasEmail,
      label:         (input.label ?? '').trim() || null,
      allowed_roles: roles,
      created_by:    g.adminId,
    })
    .select('id')
    .single();
  if (error) {
    if (/duplicate key/i.test(error.message)) return { ok: false, error: 'alias_already_exists' };
    return { ok: false, error: error.message };
  }
  const aliasId = (insertRow as { id: string } | null)?.id;

  await s.from('crm_audit_log').insert({
    actor_id:    g.adminId,
    action:      'gmail_account.alias_added',
    target_type: 'crm_email_account',
    target_id:   input.connectionId,
    details: {
      alias_email: aliasEmail,
      alias_id:    aliasId,
      allowed_roles: roles,
    },
  });

  revalidatePath('/crm/admin/gmail-accounts');
  return { ok: true, aliasId };
}

export async function adminRemoveSendAsAlias(input: {
  aliasId: string;
}): Promise<{ ok: boolean; error?: string }> {
  const g = await guardAdmin();
  if (!g.ok) return { ok: false, error: g.error };

  const s = svc();
  const { data: alias } = await s
    .from('crm_sendas_aliases')
    .select('id, connection_id, alias_email')
    .eq('id', input.aliasId)
    .maybeSingle();
  if (!alias) return { ok: false, error: 'not_found' };

  const { error } = await s.from('crm_sendas_aliases').delete().eq('id', input.aliasId);
  if (error) return { ok: false, error: error.message };

  await s.from('crm_audit_log').insert({
    actor_id:    g.adminId,
    action:      'gmail_account.alias_removed',
    target_type: 'crm_email_account',
    target_id:   (alias as { connection_id: string }).connection_id,
    details: {
      alias_email: (alias as { alias_email: string }).alias_email,
      alias_id:    input.aliasId,
    },
  });

  revalidatePath('/crm/admin/gmail-accounts');
  return { ok: true };
}

export async function adminRevokeGmailAccount(input: {
  accountId: string;
  reason?:   string;
}): Promise<{ ok: boolean; error?: string }> {
  const g = await guardAdmin();
  if (!g.ok) return { ok: false, error: g.error };

  const s = svc();
  // Load metadata BEFORE revocation so the audit record has context.
  const { data: acct } = await s
    .from('crm_email_accounts')
    .select('id, user_id, gmail_address')
    .eq('id', input.accountId)
    .maybeSingle();
  if (!acct) return { ok: false, error: 'not_found' };

  const res = await revokeGmailAccountById(input.accountId);

  // Audit — even if the revoke had a partial best-effort failure, the
  // admin's INTENT to revoke is worth logging. The `details` blob
  // includes the error string if any (never contains tokens).
  await s.from('crm_audit_log').insert({
    actor_id:    g.adminId,
    action:      'gmail_account.revoked',
    target_type: 'crm_email_account',
    target_id:   input.accountId,
    details: {
      target_user_id: acct.user_id,
      gmail_address:  acct.gmail_address,
      reason:         (input.reason ?? '').slice(0, 500) || null,
      revoke_result:  res.error ? { error: res.error } : { ok: true },
    },
  });

  revalidatePath('/crm/admin/gmail-accounts');
  return { ok: true };
}
