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

export function xlsxToCsv(buffer: ArrayBuffer): string {
  const workbook   = read(buffer, { type: 'array' });
  const sheetName  = workbook.SheetNames[0];
  if (!sheetName) return '';
  const sheet = workbook.Sheets[sheetName];
  return utils.sheet_to_csv(sheet);
}

export function isExcelFile(file: File): boolean {
  return /\.(xlsx|xls)$/i.test(file.name);
}
