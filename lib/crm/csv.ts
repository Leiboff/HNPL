import { isValidEmail } from '@/lib/validation/email';

// ─── CSV parser + validator for CRM lead import ──────────────────────────
//
// Pure client-side + server-side utility. Accepts a raw CSV string, returns
// { headers, rows, errors }. Two protections that matter here:
//
//   1. FORMULA INJECTION. A cell starting with `=`, `+`, `-`, `@`, or a
//      leading tab/newline can be interpreted as a formula when the file
//      is later opened in Excel/Sheets. We neutralise by prefixing a single
//      apostrophe. This defence applies at BOTH import and (future) export.
//   2. SIZE CAP. A hard row cap (default 500) protects the server from
//      blindly INSERTing an oversized batch. Reject with a clear error.
//
// Standard RFC 4180 quoting (double-quotes escape by doubling). We do
// NOT depend on an external CSV lib.

export type CsvParseResult = {
  headers:  string[];
  rows:     string[][];       // one row = one string[]; missing cells are ''
  rowCount: number;
};

const FORMULA_TRIGGERS = /^[=+\-@\t\r]/;

/**
 * Neutralise a single cell against CSV / spreadsheet formula injection.
 * Leaves normal text intact. Whitespace-only strings are returned as ''.
 */
export function neutraliseFormula(value: string): string {
  const v = value ?? '';
  if (v === '') return '';
  if (FORMULA_TRIGGERS.test(v)) return `'${v}`;
  return v;
}

export function parseCsv(input: string): CsvParseResult {
  // Normalise line endings; keep quoted \n intact by parsing char-by-char.
  const src = input.replace(/^﻿/, '');
  const rows: string[][] = [];
  let cur: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];

    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {          // escaped quote
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ',') {
      cur.push(field);
      field = '';
      continue;
    }
    if (ch === '\r') continue;
    if (ch === '\n') {
      cur.push(field);
      // Discard entirely blank lines
      if (!(cur.length === 1 && cur[0] === '')) rows.push(cur);
      cur = [];
      field = '';
      continue;
    }
    field += ch;
  }
  // Last field flush
  if (field !== '' || cur.length > 0) {
    cur.push(field);
    if (!(cur.length === 1 && cur[0] === '')) rows.push(cur);
  }

  const headers = (rows.shift() ?? []).map(h => h.trim());
  return { headers, rows, rowCount: rows.length };
}

// ── Lead-import schema ───────────────────────────────────────────────

export const CSV_TEMPLATE_HEADERS = [
  'practice_name',
  'contact_first_name',
  'contact_last_name',
  'role_at_practice',
  'specialty',
  'phone',
  'email',
  'suburb',
  'city',
  'province',
  'source',
  'estimated_monthly_billings',
  'notes',
] as const;

export type CsvLeadDraft = {
  practice_name:              string;
  contact_first_name:         string;
  contact_last_name:          string;
  role_at_practice:           string | null;
  specialty:                  string | null;
  phone:                      string | null;
  email:                      string | null;
  suburb:                     string | null;
  city:                       string | null;
  province:                   string | null;
  source:                     string;
  estimated_monthly_billings: number | null;
  notes:                      string | null;
};

export type RowError = {
  rowNumber: number;   // 1-indexed, data rows only (header is row 0)
  field:     string;
  message:   string;
};

export const MAX_IMPORT_ROWS = 500;
const VALID_SOURCES = new Set(['referral', 'cold_outreach', 'inbound', 'event', 'other']);

/**
 * Validate parsed rows against the lead-import schema. Returns
 * per-row drafts + errors. Formula-injection protection is applied
 * to EVERY string field before it leaves this function.
 */
export function validateLeadRows(headers: string[], rows: string[][]): {
  drafts: (CsvLeadDraft | null)[];
  errors: RowError[];
} {
  const errors: RowError[] = [];
  const drafts: (CsvLeadDraft | null)[] = [];

  // Header check
  const missingHeaders = CSV_TEMPLATE_HEADERS.filter(h =>
    !['role_at_practice', 'specialty', 'phone', 'email', 'suburb', 'city',
      'province', 'estimated_monthly_billings', 'notes'].includes(h)
    && !headers.includes(h),
  );
  if (missingHeaders.length > 0) {
    errors.push({
      rowNumber: 0,
      field: 'header',
      message: `Missing required headers: ${missingHeaders.join(', ')}`,
    });
    return { drafts, errors };
  }

  if (rows.length > MAX_IMPORT_ROWS) {
    errors.push({
      rowNumber: 0,
      field: 'file',
      message: `Row count ${rows.length} exceeds cap of ${MAX_IMPORT_ROWS}. Split into smaller files.`,
    });
    return { drafts, errors };
  }

  const idx: Record<string, number> = {};
  headers.forEach((h, i) => { idx[h] = i; });

  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    const rowNumber = r + 1;
    const get = (h: string): string => neutraliseFormula((row[idx[h]] ?? '').trim());

    const practice_name       = get('practice_name');
    const contact_first_name  = get('contact_first_name');
    const contact_last_name   = get('contact_last_name');
    if (!practice_name)      { errors.push({ rowNumber, field: 'practice_name',      message: 'Required.' }); }
    if (!contact_first_name) { errors.push({ rowNumber, field: 'contact_first_name', message: 'Required.' }); }
    if (!contact_last_name)  { errors.push({ rowNumber, field: 'contact_last_name',  message: 'Required.' }); }

    const sourceRaw = get('source').toLowerCase() || 'other';
    if (!VALID_SOURCES.has(sourceRaw)) {
      errors.push({
        rowNumber,
        field: 'source',
        message: `Source must be one of: referral, cold_outreach, inbound, event, other. Got: ${sourceRaw}`,
      });
    }

    const emb = get('estimated_monthly_billings');
    let emb_num: number | null = null;
    if (emb) {
      const n = Number(emb.replace(/[R,\s]/g, ''));
      if (Number.isNaN(n) || n < 0) {
        errors.push({ rowNumber, field: 'estimated_monthly_billings', message: `Invalid number: ${emb}` });
      } else {
        emb_num = n;
      }
    }

    const phone = get('phone') || null;
    const email = get('email') || null;
    if (email && !isValidEmail(email)) {
      errors.push({ rowNumber, field: 'email', message: `Invalid email: ${email}` });
    }

    // Emit a draft even if there are errors — the preview UI shows both
    // side by side. The commit step re-checks and skips error rows.
    drafts.push({
      practice_name,
      contact_first_name,
      contact_last_name,
      role_at_practice:           get('role_at_practice') || null,
      specialty:                  get('specialty')        || null,
      phone,
      email,
      suburb:                     get('suburb')   || null,
      city:                       get('city')     || null,
      province:                   get('province') || null,
      source:                     sourceRaw,
      estimated_monthly_billings: emb_num,
      notes:                      get('notes') || null,
    });
  }

  return { drafts, errors };
}

export function buildTemplateCsv(): string {
  return CSV_TEMPLATE_HEADERS.join(',') + '\n';
}
