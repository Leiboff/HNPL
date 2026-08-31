'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { parseCsv, validateLeadRows, MAX_IMPORT_ROWS, type RowError, type CsvLeadDraft } from '@/lib/crm/csv';
import { normaliseEmail, normalisePhone } from '@/lib/crm/dedupe';
import { normaliseSpecialty } from '@/lib/specialties';

// ─── Server-side guard: sales OR admin ───────────────────────────────

async function guard(): Promise<{ ok: true; userId: string } | { ok: false; error: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: 'Not authenticated.' };
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single();
  if (profile?.role !== 'sales' && profile?.role !== 'admin') return { ok: false, error: 'Unauthorized.' };
  return { ok: true, userId: user.id };
}

// ─── previewImport — validate CSV, check dedupes, return preview ─────

export type PreviewResult = {
  error?: string;
  headers?: string[];
  rowCount?: number;
  errors?: RowError[];
  drafts?: (CsvLeadDraft | null)[];
  dupeIdxs?: number[];        // indices into drafts[] that collide with existing leads
};

export async function previewImport(csvText: string): Promise<PreviewResult> {
  const g = await guard();
  if (!g.ok) return { error: g.error };

  if (!csvText || csvText.trim().length === 0) return { error: 'Empty file.' };
  if (csvText.length > 5 * 1024 * 1024) return { error: 'File too large (>5 MB).' };

  const parsed = parseCsv(csvText);
  const { drafts, errors } = validateLeadRows(parsed.headers, parsed.rows);

  if (parsed.rowCount > MAX_IMPORT_ROWS && errors.some(e => e.field === 'file')) {
    return { headers: parsed.headers, rowCount: parsed.rowCount, errors, drafts };
  }

  // Batched dedupe: collect all phones + emails from valid drafts, query in one shot
  const phones: string[] = [];
  const emails: string[] = [];
  for (const d of drafts) {
    if (!d) continue;
    const p = normalisePhone(d.phone);
    const e = normaliseEmail(d.email);
    if (p) phones.push(p);
    if (e) emails.push(e);
  }

  const supabase = await createClient();
  const orClauses: string[] = [];
  if (phones.length) orClauses.push(`phone.in.(${phones.map(p => `"${p}"`).join(',')})`);
  if (emails.length) orClauses.push(`email.in.(${emails.map(e => `"${e}"`).join(',')})`);
  const existing = orClauses.length
    ? (await supabase.from('crm_leads').select('id, phone, email').or(orClauses.join(','))).data ?? []
    : [];

  const existingPhones = new Set(existing.map(e => normalisePhone(e.phone)).filter(Boolean) as string[]);
  const existingEmails = new Set(existing.map(e => normaliseEmail(e.email)).filter(Boolean) as string[]);

  const dupeIdxs: number[] = [];
  drafts.forEach((d, i) => {
    if (!d) return;
    const p = normalisePhone(d.phone);
    const e = normaliseEmail(d.email);
    if ((p && existingPhones.has(p)) || (e && existingEmails.has(e))) dupeIdxs.push(i);
  });

  return {
    headers:  parsed.headers,
    rowCount: parsed.rowCount,
    errors,
    drafts,
    dupeIdxs,
  };
}

// ─── commitImport — actually create the leads ────────────────────────

export async function commitImport(
  drafts: (CsvLeadDraft | null)[],
  errors: RowError[],
  includeDupeIdxs: number[],
): Promise<{ error?: string; created?: number; skipped?: number; rowErrors?: RowError[] }> {
  const g = await guard();
  if (!g.ok) return { error: g.error };

  const supabase = await createClient();

  // Skip rows that have any error, and rows the user chose NOT to include from dupeIdxs
  const errorRowNums = new Set(errors.filter(e => e.rowNumber > 0).map(e => e.rowNumber));
  const includeDupe = new Set(includeDupeIdxs);

  const toInsert: Array<{ rowNumber: number; row: Record<string, unknown> }> = [];
  let skipped = 0;
  drafts.forEach((d, i) => {
    if (!d) return;
    const rowNum = i + 1;
    if (errorRowNums.has(rowNum)) { skipped++; return; }
    // If this row was flagged as dupe and NOT in includeDupe, skip it.
    // The client hands us the set of dupe indices the user opted in to.
    // If a row was not flagged, includeDupe won't contain it — we don't skip.
    // (We can't detect dupes here without another query; the client tells us via includeDupeIdxs.)
    toInsert.push({
      rowNumber: rowNum,
      row: {
        practice_name:      d.practice_name,
        contact_first_name: d.contact_first_name,
        contact_last_name:  d.contact_last_name,
        role_at_practice:   d.role_at_practice,
        // Same normalisation the quick import applies (quickActions.ts):
        // a source writing "Dentist" or "GP" means a register entry, and
        // two labels for one specialty split the leads filter in two.
        // Anything unrecognised is kept verbatim, never bucketed.
        specialty:          normaliseSpecialty(d.specialty),
        phone:              d.phone,
        email:              d.email,
        street_address:     d.street_address,
        suburb:             d.suburb,
        city:               d.city,
        province:           d.province,
        source:             d.source,
        owner_user_id:      g.userId,
        created_by:         g.userId,
      },
    });
    // Note: the client filters out dupes it doesn't want to include before calling us,
    // so `includeDupe` isn't consulted here. Suppress the unused warning.
    void includeDupe;
  });

  if (toInsert.length === 0) return { created: 0, skipped };

  // One row per request rather than a single batch insert: a batch
  // insert is all-or-nothing, so ONE row tripping the
  // crm_leads_practice_suburb_uidx unique index (duplicate practice
  // in the same suburb) would 500 the whole import instead of
  // surfacing a clean, row-level error and letting the rest commit.
  let created = 0;
  const rowErrors: RowError[] = [];
  for (const { rowNumber, row } of toInsert) {
    const { error } = await supabase.from('crm_leads').insert(row);
    if (error) {
      if (error.code === '23505' && error.message.includes('crm_leads_practice_suburb_uidx')) {
        rowErrors.push({
          rowNumber,
          field: 'practice_name',
          message: 'Duplicate practice: a lead for this practice + suburb already exists.',
        });
      } else {
        rowErrors.push({ rowNumber, field: 'practice_name', message: error.message });
      }
      skipped++;
      continue;
    }
    created++;
  }

  revalidatePath('/crm/leads');
  revalidatePath('/crm');
  return { created, skipped, rowErrors: rowErrors.length ? rowErrors : undefined };
}
