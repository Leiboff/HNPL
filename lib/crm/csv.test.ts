import { describe, it, expect } from 'vitest';
import {
  parseCsv,
  validateLeadRows,
  neutraliseFormula,
  MAX_IMPORT_ROWS,
  CSV_TEMPLATE_HEADERS,
} from './csv';

describe('parseCsv', () => {
  it('parses simple CSV with quoted commas + doubled-quote escapes', () => {
    const src = 'a,b,c\n"1,2",3,"4\n5"\n"He said ""hi""",b,c\n';
    const r = parseCsv(src);
    expect(r.headers).toEqual(['a', 'b', 'c']);
    expect(r.rows).toEqual([
      ['1,2', '3', '4\n5'],
      ['He said "hi"', 'b', 'c'],
    ]);
    expect(r.rowCount).toBe(2);
  });

  it('skips blank lines but preserves empty trailing fields', () => {
    const src = 'a,b\n\nx,\n,y\n';
    const r = parseCsv(src);
    expect(r.rows).toEqual([['x', ''], ['', 'y']]);
  });

  it('strips a BOM if present', () => {
    const src = '﻿a,b\n1,2\n';
    const r = parseCsv(src);
    expect(r.headers).toEqual(['a', 'b']);
  });
});

describe('neutraliseFormula (spreadsheet injection guard)', () => {
  it('prefixes an apostrophe to cells starting with =+-@', () => {
    expect(neutraliseFormula('=SUM(A1:A9)')).toBe("'=SUM(A1:A9)");
    expect(neutraliseFormula('+cmd|/c calc')).toBe("'+cmd|/c calc");
    expect(neutraliseFormula('-2+3')).toBe("'-2+3");
    expect(neutraliseFormula('@SUM')).toBe("'@SUM");
    expect(neutraliseFormula('=HYPERLINK("http://evil")')).toBe('\'=HYPERLINK("http://evil")');
  });

  it('leaves normal text intact', () => {
    expect(neutraliseFormula('Rosebank Dental')).toBe('Rosebank Dental');
    expect(neutraliseFormula('R25,000')).toBe('R25,000');
    expect(neutraliseFormula('')).toBe('');
  });

  it('catches tab/CR-prefixed formula injections', () => {
    expect(neutraliseFormula('\t=SUM(A1:A9)').startsWith("'")).toBe(true);
  });
});

describe('validateLeadRows', () => {
  const HEADERS = [...CSV_TEMPLATE_HEADERS];

  it('accepts a minimal valid row', () => {
    const rows = [[
      'Rosebank Dental', 'Alice', 'Smith', 'Owner', 'Dentistry',
      '+27 82 111 2222', 'alice@rosebank.co.za', 'Rosebank', 'JHB', 'Gauteng',
      'referral', '25000', 'Warm intro from Bob',
    ]];
    const { drafts, errors } = validateLeadRows(HEADERS, rows);
    expect(errors).toHaveLength(0);
    expect(drafts[0]?.practice_name).toBe('Rosebank Dental');
    expect(drafts[0]?.estimated_monthly_billings).toBe(25000);
    expect(drafts[0]?.source).toBe('referral');
  });

  it('flags missing required fields per row', () => {
    const rows = [[
      '', 'Alice', 'Smith', '', '', '', '', '', '', '',
      'other', '', '',
    ]];
    const { errors } = validateLeadRows(HEADERS, rows);
    expect(errors.some(e => e.field === 'practice_name')).toBe(true);
  });

  it('rejects invalid source', () => {
    const rows = [[
      'X', 'Alice', 'Smith', '', '', '', '', '', '', '',
      'newsletter', '', '',
    ]];
    const { errors } = validateLeadRows(HEADERS, rows);
    expect(errors.some(e => e.field === 'source')).toBe(true);
  });

  it('rejects invalid email format', () => {
    const rows = [[
      'X', 'Alice', 'Smith', '', '', '', 'not-an-email', '', '', '',
      'other', '', '',
    ]];
    const { errors } = validateLeadRows(HEADERS, rows);
    expect(errors.some(e => e.field === 'email')).toBe(true);
  });

  it('applies formula-injection guard to string fields in the draft', () => {
    const rows = [[
      '=cmd|/c calc', 'Alice', 'Smith', '', '', '', '', '', '', '',
      'other', '', '',
    ]];
    const { drafts } = validateLeadRows(HEADERS, rows);
    expect(drafts[0]?.practice_name.startsWith("'")).toBe(true);
  });

  it('rejects an over-cap import at the file level', () => {
    const rows = Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, i) => [
      `P${i}`, 'Alice', 'Smith', '', '', '', '', '', '', '', 'other', '', '',
    ]);
    const { errors } = validateLeadRows(HEADERS, rows);
    expect(errors.some(e => e.field === 'file')).toBe(true);
  });

  it('flags missing headers before doing anything else', () => {
    const bad = ['practice_name', 'contact_first_name']; // missing contact_last_name, source
    const { errors } = validateLeadRows(bad, [['a', 'b']]);
    expect(errors.some(e => e.field === 'header')).toBe(true);
  });
});
