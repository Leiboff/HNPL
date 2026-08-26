'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { parseCsv } from '@/lib/crm/csv';
import {
  validateQuickImportRows,
  type QuickImportDraft,
  type QuickRowError,
} from '@/lib/crm/quickImportCsv';
import { splitFullName } from '@/lib/crm/nameSplit';
import { parseNeighbourhoodLocation } from '@/lib/crm/parseLocation';
import { normaliseSpecialty } from '@/lib/specialties';
import { resolveLocalitiesWithCache, normaliseLocalityQuery } from '@/lib/crm/localityGeocode';

// ─── Server-side guard: sales OR admin (same rule as actions.ts) ─────

async function guard(): Promise<{ ok: true; userId: string } | { ok: false; error: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: 'Not authenticated.' };
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single();
  if (profile?.role !== 'sales' && profile?.role !== 'admin') return { ok: false, error: 'Unauthorized.' };
  return { ok: true, userId: user.id };
}

// ─── previewQuickImport — parse, split name, geocode neighbourhood ───

export type QuickPreviewRow = {
  practiceName:     string;
  contactFirstName: string;
  contactLastName:  string;
  specialty:        string | null;
  suburb:           string | null;
  city:             string | null;
  province:         string | null;
  latitude:         number | null;
  longitude:        number | null;
  geocoded:         boolean; // false = no coords yet; still imports, backfilled later on /crm/map
};

export type QuickPreviewResult = {
  error?:    string;
  rowCount?: number;
  errors?:   QuickRowError[];
  rows?:     (QuickPreviewRow | null)[];
};

export async function previewQuickImport(csvText: string): Promise<QuickPreviewResult> {
  const g = await guard();
  if (!g.ok) return { error: g.error };

  if (!csvText || csvText.trim().length === 0) return { error: 'Empty file.' };
  if (csvText.length > 5 * 1024 * 1024) return { error: 'File too large (>5 MB).' };

  const parsed = parseCsv(csvText);
  const { drafts, errors } = validateQuickImportRows(parsed.headers, parsed.rows);
  if (errors.some(e => e.field === 'file' || e.field === 'header')) {
    return { rowCount: parsed.rowCount, errors, rows: [] };
  }

  // One Google call per DISTINCT neighbourhood string EVER, not per row
  // and not per import batch — crm_locality_geocode_cache remembers
  // every suburb this or any earlier import already resolved.
  const supabase  = await createClient();
  const locations = drafts.filter((d): d is QuickImportDraft => !!d).map(d => d.locationRaw);
  const geocoded  = await resolveLocalitiesWithCache(supabase, locations);

  const rows: (QuickPreviewRow | null)[] = drafts.map(d => {
    if (!d) return null;
    const { title, firstName, lastName } = splitFullName(d.fullName);
    const parsedLoc = parseNeighbourhoodLocation(d.locationRaw);
    const coords = geocoded.get(normaliseLocalityQuery(d.locationRaw)) ?? null;
    const practiceName = [title, firstName, lastName].filter(Boolean).join(' ').trim() || d.fullName;
    return {
      practiceName,
      contactFirstName: firstName,
      contactLastName:  lastName,
      specialty:        normaliseSpecialty(d.specialty),
      suburb:           parsedLoc.suburb,
      city:             parsedLoc.city,
      province:         parsedLoc.province,
      latitude:         coords?.lat ?? null,
      longitude:        coords?.lng ?? null,
      geocoded:         !!coords,
    };
  });

  return { rowCount: parsed.rowCount, errors, rows };
}

// ─── commitQuickImport — actually create the leads ────────────────────

export async function commitQuickImport(
  rows:   (QuickPreviewRow | null)[],
  errors: QuickRowError[],
): Promise<{ error?: string; created?: number; skipped?: number; rowErrors?: QuickRowError[] }> {
  const g = await guard();
  if (!g.ok) return { error: g.error };

  const supabase = await createClient();
  const errorRowNums = new Set(errors.filter(e => e.rowNumber > 0).map(e => e.rowNumber));

  const toInsert: Array<{ rowNumber: number; row: Record<string, unknown> }> = [];
  let skipped = 0;
  rows.forEach((r, i) => {
    if (!r) return;
    const rowNum = i + 1;
    if (errorRowNums.has(rowNum)) { skipped++; return; }
    toInsert.push({
      rowNumber: rowNum,
      row: {
        practice_name:      r.practiceName,
        contact_first_name: r.contactFirstName,
        contact_last_name:  r.contactLastName,
        specialty:          r.specialty,
        suburb:             r.suburb,
        city:               r.city,
        province:           r.province,
        latitude:           r.latitude,
        longitude:          r.longitude,
        source:             'other',
        owner_user_id:      g.userId,
        created_by:         g.userId,
      },
    });
  });

  if (toInsert.length === 0) return { created: 0, skipped };

  function duplicateRowError(rowNumber: number): QuickRowError {
    return {
      rowNumber,
      field: 'practiceName',
      message: 'Duplicate practice: a lead for this practice + suburb already exists.',
    };
  }

  // Chunk the insert — a single request carrying thousands of rows
  // risks the payload/statement-timeout limits of one Postgres round
  // trip. A whole chunk is all-or-nothing, so when a chunk fails we
  // fall back to inserting that chunk one row at a time so a single
  // duplicate-practice row doesn't take the rest of the chunk down
  // with it — the caller gets a row-level error instead of a 500.
  const CHUNK = 500;
  let created = 0;
  const rowErrors: QuickRowError[] = [];
  for (let i = 0; i < toInsert.length; i += CHUNK) {
    const chunk = toInsert.slice(i, i + CHUNK);
    const { error } = await supabase.from('crm_leads').insert(chunk.map(c => c.row));
    if (!error) {
      created += chunk.length;
      continue;
    }
    for (const { rowNumber, row } of chunk) {
      const { error: rowError } = await supabase.from('crm_leads').insert(row);
      if (rowError) {
        rowErrors.push(
          rowError.code === '23505' && rowError.message.includes('crm_leads_practice_suburb_uidx')
            ? duplicateRowError(rowNumber)
            : { rowNumber, field: 'practiceName', message: rowError.message },
        );
        skipped++;
        continue;
      }
      created++;
    }
  }

  revalidatePath('/crm/leads');
  revalidatePath('/crm/map');
  revalidatePath('/crm/board');
  revalidatePath('/crm');
  return { created, skipped, rowErrors: rowErrors.length ? rowErrors : undefined };
}
