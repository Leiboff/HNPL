'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import {
  applySignatureMergeFields,
  renderBrandSignatureHtml,
  renderBrandSignatureText,
  sanitizeSignatureHtml,
  type SignatureData,
} from '@/lib/gmail/signature';

// ─── Signature server actions ─────────────────────────────────────
//
// Read + write on crm_signatures (RLS: user reads/writes their own).
// Raw-HTML overrides are sanitised at the SERVER (never trust the
// browser); structured fields are stored as text and rendered via
// the brand template at compose time.

type Guard = { ok: true; userId: string } | { ok: false; error: string };

async function guardSalesOrAdmin(): Promise<Guard> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: 'unauthenticated' };
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single();
  if (profile?.role !== 'sales' && profile?.role !== 'admin') return { ok: false, error: 'unauthorized' };
  return { ok: true, userId: user.id };
}

export type SignatureInput = {
  displayName?:   string;
  title?:         string;
  phone?:         string;
  email?:         string;
  htmlOverride?:  string;
  textFallback?:  string;
};

export type SavedSignature = {
  displayName:   string;
  title:         string;
  phone:         string;
  email:         string;
  htmlOverride:  string | null;
  textFallback:  string | null;
  updatedAt:     string | null;
};

export async function loadMySignature(): Promise<{ signature?: SavedSignature; error?: string }> {
  const g = await guardSalesOrAdmin();
  if (!g.ok) return { error: g.error };
  const supabase = await createClient();
  const { data } = await supabase
    .from('crm_signatures')
    .select('display_name, title, phone, email, html_override, text_fallback, updated_at')
    .eq('user_id', g.userId)
    .maybeSingle();
  if (!data) {
    return { signature: { displayName: '', title: '', phone: '', email: '', htmlOverride: null, textFallback: null, updatedAt: null } };
  }
  return {
    signature: {
      displayName:  (data.display_name  as string | null) ?? '',
      title:        (data.title         as string | null) ?? '',
      phone:        (data.phone         as string | null) ?? '',
      email:        (data.email         as string | null) ?? '',
      htmlOverride: (data.html_override as string | null),
      textFallback: (data.text_fallback as string | null),
      updatedAt:    (data.updated_at    as string | null),
    },
  };
}

export async function saveMySignature(
  input: SignatureInput,
): Promise<{ ok: boolean; error?: string }> {
  const g = await guardSalesOrAdmin();
  if (!g.ok) return { ok: false, error: g.error };

  const displayName = (input.displayName ?? '').trim().slice(0, 120);
  const title       = (input.title       ?? '').trim().slice(0, 120);
  const phone       = (input.phone       ?? '').trim().slice(0, 60);
  const email       = (input.email       ?? '').trim().slice(0, 254);

  const rawOverride  = (input.htmlOverride ?? '').slice(0, 40_000);
  const htmlOverride = rawOverride.trim() ? sanitizeSignatureHtml(rawOverride) : null;
  const textFallback = (input.textFallback ?? '').trim().slice(0, 4000) || null;

  const supabase = await createClient();
  const { error } = await supabase
    .from('crm_signatures')
    .upsert({
      user_id:       g.userId,
      display_name:  displayName,
      title,
      phone,
      email,
      html_override: htmlOverride,
      text_fallback: textFallback,
    }, { onConflict: 'user_id' });
  if (error) return { ok: false, error: error.message };

  revalidatePath('/crm/settings');
  return { ok: true };
}

/** Server-side preview — sanitises + merges + renders (structured or
 *  override branch). Kept as a server action so the editor can show a
 *  faithful preview using the same code compose uses. */
export async function previewMySignature(
  input: SignatureInput,
): Promise<{ html?: string; text?: string; error?: string }> {
  const g = await guardSalesOrAdmin();
  if (!g.ok) return { error: g.error };
  const vars: SignatureData = {
    displayName: (input.displayName ?? '').trim(),
    title:       (input.title       ?? '').trim(),
    phone:       (input.phone       ?? '').trim(),
    email:       (input.email       ?? '').trim(),
  };

  const override = (input.htmlOverride ?? '').trim();
  if (override) {
    const html = applySignatureMergeFields(sanitizeSignatureHtml(override), vars);
    const text = (input.textFallback ?? '').trim() || renderBrandSignatureText(vars);
    return { html, text };
  }
  return {
    html: renderBrandSignatureHtml(vars),
    text: (input.textFallback ?? '').trim() || renderBrandSignatureText(vars),
  };
}
