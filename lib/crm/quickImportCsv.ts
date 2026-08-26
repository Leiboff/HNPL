import { neutraliseFormula } from './csv';

// ─── Lightweight "name + specialty + neighbourhood" import schema ───────
//
// For bulk sources that only carry a practitioner's full name, a free-
// text specialty label, and a rough neighbourhood string — no street
// address, no separate first/last name, no phone/email. Distinct from
// the full CSV_TEMPLATE_HEADERS schema in csv.ts (which assumes an
// address precise enough for the Places-autocomplete flow to have
// already resolved lat/lng). Any other column present (e.g. a "page"
// number from a directory-scrape export) is tolerated and ignored —
// only name/specialty/location are read.

export type QuickImportDraft = {
  fullName:    string;
  specialty:   string | null;
  locationRaw: string;
};

export type QuickRowError = { rowNumber: number; field: string; message: string };

export const MAX_QUICK_IMPORT_ROWS = 5000;

const REQUIRED_HEADERS = ['name', 'location'] as const;

function findHeaderIndex(headers: string[], name: string): number {
  return headers.findIndex(h => h.trim().toLowerCase() === name);
}

/**
 * Validate parsed rows against the quick-import schema. Mirrors
 * validateLeadRows' shape (lib/crm/csv.ts): one draft per row (even
 * error rows get a draft, so the preview UI can show them side by
 * side), plus a flat error list the commit step re-checks before
 * inserting.
 */
export function validateQuickImportRows(headers: string[], rows: string[][]): {
  drafts: (QuickImportDraft | null)[];
  errors: QuickRowError[];
} {
  const errors: QuickRowError[] = [];
  const drafts: (QuickImportDraft | null)[] = [];

  const nameIdx      = findHeaderIndex(headers, 'name');
  const specialtyIdx = findHeaderIndex(headers, 'specialty');
  const locationIdx  = findHeaderIndex(headers, 'location');

  const missing = REQUIRED_HEADERS.filter(h => findHeaderIndex(headers, h) < 0);
  if (missing.length > 0) {
    errors.push({ rowNumber: 0, field: 'header', message: `Missing required headers: ${missing.join(', ')}` });
    return { drafts, errors };
  }

  if (rows.length > MAX_QUICK_IMPORT_ROWS) {
    errors.push({
      rowNumber: 0,
      field: 'file',
      message: `Row count ${rows.length} exceeds cap of ${MAX_QUICK_IMPORT_ROWS}. Split into smaller files.`,
    });
    return { drafts, errors };
  }

  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    const rowNumber = r + 1;
    const fullName    = neutraliseFormula((row[nameIdx] ?? '').trim());
    const specialty   = specialtyIdx >= 0 ? neutraliseFormula((row[specialtyIdx] ?? '').trim()) : '';
    const locationRaw = neutraliseFormula((row[locationIdx] ?? '').trim());

    if (!fullName)    errors.push({ rowNumber, field: 'name',     message: 'Required.' });
    if (!locationRaw) errors.push({ rowNumber, field: 'location', message: 'Required.' });

    // Emit a draft even if there are errors — the commit step re-checks
    // and skips error rows, same pattern as the full CSV importer.
    drafts.push({ fullName, specialty: specialty || null, locationRaw });
  }

  return { drafts, errors };
}

export function buildQuickTemplateCsv(): string {
  return 'name,specialty,location\n';
}
