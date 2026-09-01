import { read, utils } from 'xlsx';

// ─── Convert an uploaded Excel workbook to CSV text, client-side ────────
//
// Both /crm/import flows (full CSV template + quick name/specialty/
// neighbourhood import) accept a CSV string end-to-end — parsing,
// validation, and the server actions all expect that shape. Rather than
// teach every downstream piece a second, binary XLSX format, we convert
// once at upload time: read the first sheet, hand it to SheetJS's own
// CSV serialiser (which already handles quoting/escaping correctly),
// and feed the result into the exact same csvText pipeline a real .csv
// upload would produce.
//
// Only the first sheet is read — these imports are single-table data,
// and a multi-sheet workbook silently using sheet 2 would be far more
// confusing than an explicit "first sheet only" contract.
//
// ─── THE PARSER HAS TWO OPEN ADVISORIES (audit 2026-09-01, F-15) ───────
//
// xlsx@0.18.5 is the newest build on the npm registry and carries a
// prototype-pollution advisory (fixed in 0.19.3) and a ReDoS advisory
// (fixed in 0.20.2). SheetJS left npm at 0.20, so those fixes exist ONLY
// on the vendor's own CDN — moving to them changes where this project
// installs a dependency from, which is a supply-chain decision for a human
// to take rather than a lockfile edit to slip in. It is written up in
// docs/SECURITY-AUDIT-2026-09.md; until it is taken, this is what bounds
// the exposure.
//
// WHAT THE EXPOSURE ACTUALLY IS, so the bound can be judged: this function
// runs in the BROWSER, in a sales/admin CRM session, on a file that user
// chose. There is no server-side parse and no untrusted upload path. The
// realistic attack is a hostile workbook mailed to a rep who imports it —
// prototype pollution in their own tab, which in an authenticated CRM
// session is worth something to an attacker.
//
// TWO GUARDS, both cheap, neither a substitute for the version bump:
//
//   • A size cap. ReDoS needs a large enough input to be worth anything,
//     and a lead list that exceeds this is a mistake rather than an
//     import. Checked before a single byte is parsed.
//
//   • A prototype-pollution tripwire. SheetJS's pollution vectors work by
//     writing __proto__ / constructor / prototype keys while building the
//     sheet object; we snapshot a canary on Object.prototype and refuse
//     the result if parsing disturbed it. This cannot PREVENT the write —
//     by the time we look, it has happened — but it turns a silent
//     compromise into a refused import and a console error, which is the
//     difference between finding out and not.

/** 15 MB. A CRM lead list that exceeds this is a wrong file, not a big one. */
export const MAX_WORKBOOK_BYTES = 15 * 1024 * 1024;

export class WorkbookRejectedError extends Error {}

const CANARY = '__hnpl_proto_canary__';

export function xlsxToCsv(buffer: ArrayBuffer): string {
  if (buffer.byteLength > MAX_WORKBOOK_BYTES) {
    throw new WorkbookRejectedError(
      `That file is ${(buffer.byteLength / 1024 / 1024).toFixed(1)} MB. `
      + `Spreadsheet imports are limited to ${MAX_WORKBOOK_BYTES / 1024 / 1024} MB — `
      + 'split the list or export it as CSV.',
    );
  }

  // Snapshot: nothing should be able to add this key to Object.prototype,
  // so if it is defined after the parse, the parse defined it.
  const proto = Object.prototype as unknown as Record<string, unknown>;
  const hadCanary = CANARY in proto;

  let csv: string;
  try {
    const workbook  = read(buffer, { type: 'array' });
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) return '';
    const sheet = workbook.Sheets[sheetName];
    csv = utils.sheet_to_csv(sheet);
  } catch (err) {
    if (err instanceof WorkbookRejectedError) throw err;
    throw new WorkbookRejectedError(
      'We couldn\'t read that spreadsheet. Please re-save it as .xlsx or export it as CSV.',
    );
  }

  if (!hadCanary && CANARY in proto) {
    // Deliberately loud, and deliberately fatal to the import. A workbook
    // that reached Object.prototype has done the thing the advisory is
    // about, and the honest response is to refuse it rather than carry on
    // with a polluted realm.
    console.error('[xlsxToCsv] ALERT workbook mutated Object.prototype — refusing the import');
    delete proto[CANARY];
    throw new WorkbookRejectedError(
      'That spreadsheet did something unexpected while being read and wasn\'t imported. '
      + 'Please export it as CSV and try again.',
    );
  }

  return csv;
}

export function isExcelFile(file: File): boolean {
  return /\.(xlsx|xls)$/i.test(file.name);
}
