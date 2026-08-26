import { describe, it, expect } from 'vitest';
import { parseCsv } from './csv';
import { validateQuickImportRows, MAX_QUICK_IMPORT_ROWS, buildQuickTemplateCsv } from './quickImportCsv';

function parseAndValidate(csv: string) {
  const parsed = parseCsv(csv);
  return validateQuickImportRows(parsed.headers, parsed.rows);
}

describe('validateQuickImportRows', () => {
  it('parses valid rows, ignoring an extra unrecognised column (e.g. "page")', () => {
    const csv = [
      'page,name,specialty,location',
      '1,Dr Sunday Joseph Aigbodion,General Practitioner (GP),"Springs , Springs, Gauteng"',
      '1,Dr Zaheda Bhabha,General Practitioner (GP),"Bedfordview , Germiston, Gauteng"',
    ].join('\n');
    const { drafts, errors } = parseAndValidate(csv);
    expect(errors).toEqual([]);
    expect(drafts).toEqual([
      { fullName: 'Dr Sunday Joseph Aigbodion', specialty: 'General Practitioner (GP)', locationRaw: 'Springs , Springs, Gauteng' },
      { fullName: 'Dr Zaheda Bhabha',           specialty: 'General Practitioner (GP)', locationRaw: 'Bedfordview , Germiston, Gauteng' },
    ]);
  });

  it('is case-insensitive on headers and tolerates any column order', () => {
    const csv = [
      'Location,Name',
      '"Pretoria, Gauteng",Dr Janine Olivier',
    ].join('\n');
    const { drafts, errors } = parseAndValidate(csv);
    expect(errors).toEqual([]);
    expect(drafts).toEqual([
      { fullName: 'Dr Janine Olivier', specialty: null, locationRaw: 'Pretoria, Gauteng' },
    ]);
  });

  it('flags missing required headers and returns no drafts', () => {
    const { drafts, errors } = parseAndValidate('specialty\nGP');
    expect(drafts).toEqual([]);
    expect(errors).toEqual([{ rowNumber: 0, field: 'header', message: 'Missing required headers: name, location' }]);
  });

  it('flags a row missing name or location, but still emits a draft for it', () => {
    const csv = [
      'name,specialty,location',
      ',GP,"Springs, Gauteng"',
      'Dr Janine Olivier,GP,',
    ].join('\n');
    const { drafts, errors } = parseAndValidate(csv);
    expect(errors).toEqual([
      { rowNumber: 1, field: 'name', message: 'Required.' },
      { rowNumber: 2, field: 'location', message: 'Required.' },
    ]);
    expect(drafts.length).toBe(2);
  });

  it('rejects a file over the row cap', () => {
    const rows = Array.from({ length: MAX_QUICK_IMPORT_ROWS + 1 }, (_, i) => `Dr Person ${i},GP,"Springs, Gauteng"`);
    const csv = ['name,specialty,location', ...rows].join('\n');
    const { drafts, errors } = parseAndValidate(csv);
    expect(drafts).toEqual([]);
    expect(errors[0].field).toBe('file');
  });

  it('neutralises formula-injection triggers in every field', () => {
    const csv = [
      'name,specialty,location',
      '=cmd(),+GP,"-Springs, Gauteng"',
    ].join('\n');
    const { drafts } = parseAndValidate(csv);
    expect(drafts[0]).toEqual({ fullName: "'=cmd()", specialty: "'+GP", locationRaw: "'-Springs, Gauteng" });
  });
});

describe('buildQuickTemplateCsv', () => {
  it('emits just the three-column header row', () => {
    expect(buildQuickTemplateCsv()).toBe('name,specialty,location\n');
  });
});
