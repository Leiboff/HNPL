/**
 * Admin-run backfill for crm_leads.building_name / crm_leads.unit.
 *
 * 0117 adds these columns NULL for every existing row — no parsing of
 * existing formatted_address values happens in the migration itself
 * (the brief is explicit: "leave existing rows alone in the
 * migration"). This script is the separate, re-runnable pass: given
 * how varied SA free-text addresses are ("Suite 4, Life Fourways
 * Hospital", "Netcare Sunninghill, Unit 12"), a best-effort regex
 * extraction still needs a human to skim the report before trusting
 * it — this NEVER writes a value it isn't reasonably confident about.
 *
 * SAFE TO RE-RUN. Only writes rows where building_name/unit are
 * currently NULL — never overwrites a value a rep has since entered
 * or corrected by hand.
 *
 * Usage:
 *   pnpm tsx --env-file=.env.local scripts/backfill-crm-address-fields.ts --dry-run
 *   pnpm tsx --env-file=.env.local scripts/backfill-crm-address-fields.ts
 *
 * Requires:
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY   (server key — bypasses RLS)
 */

import { createClient } from '@supabase/supabase-js';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DRY = process.argv.includes('--dry-run');

if (!URL || !KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local.');
  process.exit(1);
}

const supabase = createClient(URL, KEY, { auth: { persistSession: false } });

const PAGE = 500;

type Row = {
  id:                string;
  practice_name:     string;
  street_address:    string | null;
  formatted_address: string | null;
};

// Deliberately narrow: only extracts an UNIT when it's introduced by an
// unambiguous marker (Suite/Ste/Unit/#) — never guesses a bare number
// is a unit, since that's indistinguishable from a street number.
const UNIT_RE = /\b(?:suite|ste|unit)\s*[.:#-]?\s*(\w+)\b|#\s*(\w+)\b/i;

// A trailing ", <Name> Hospital|Medical Centre|Clinic|Mediclinic" segment
// is treated as the building name — the same class of noise words
// lib/crm/addressMatch.ts strips for matching purposes.
const BUILDING_RE = /,\s*([^,]*\b(?:hospital|medical centre|medical center|mediclinic|clinic|centre|center)\b[^,]*)(?:,|$)/i;

function extract(addressLine: string): { building: string | null; unit: string | null } {
  const unitMatch = addressLine.match(UNIT_RE);
  const unit = unitMatch ? (unitMatch[1] ?? unitMatch[2] ?? null) : null;
  const buildingMatch = addressLine.match(BUILDING_RE);
  const building = buildingMatch ? buildingMatch[1].trim() : null;
  return { building, unit };
}

async function fetchAll(): Promise<Row[]> {
  const out: Row[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('crm_leads')
      .select('id, practice_name, street_address, formatted_address')
      .is('building_name', null)
      .is('unit', null)
      .is('archived_at', null)
      .range(from, from + PAGE - 1);
    if (error) {
      console.error('[backfill] crm_leads read failed:', error.message);
      if (/building_name|unit/.test(error.message)) {
        console.error('[backfill] Has migration 0117 been applied to this project?');
      }
      process.exit(1);
    }
    const rows = (data ?? []) as Row[];
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
}

async function main() {
  console.log(`\n[backfill] crm_leads.building_name / unit${DRY ? '  (DRY RUN — no writes)' : ''}\n`);

  const rows = await fetchAll();
  console.log(`rows with building_name AND unit both NULL: ${rows.length}`);

  const extracted: Array<{ id: string; practice_name: string; building: string | null; unit: string | null }> = [];
  for (const row of rows) {
    const addressLine = row.street_address || row.formatted_address || '';
    if (!addressLine) continue;
    const { building, unit } = extract(addressLine);
    if (building || unit) extracted.push({ id: row.id, practice_name: row.practice_name, building, unit });
  }

  console.log(`rows with an extractable building and/or unit: ${extracted.length}`);
  console.log('\n── preview (first 20) ──');
  for (const r of extracted.slice(0, 20)) {
    console.log(`  ${r.practice_name}: building=${r.building ?? '—'} unit=${r.unit ?? '—'}`);
  }

  if (DRY) {
    console.log('\n[backfill] dry run — nothing written. Review the preview above before running for real.\n');
    return;
  }

  let written = 0;
  let writeErrors = 0;
  for (const r of extracted) {
    const patch: Record<string, string> = {};
    if (r.building) patch.building_name = r.building;
    if (r.unit)      patch.unit         = r.unit;
    const { error } = await supabase.from('crm_leads').update(patch).eq('id', r.id);
    if (error) { writeErrors += 1; console.error(`  write failed for ${r.id}: ${error.message}`); continue; }
    written += 1;
  }

  console.log(`\nwritten: ${written}   write errors: ${writeErrors}\n`);
}

main().catch((err) => {
  console.error('[backfill] unexpected failure:', err);
  process.exit(1);
});
