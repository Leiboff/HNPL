import { describe, it, expect } from 'vitest';
import { utils, write } from 'xlsx';
import { xlsxToCsv, isExcelFile } from './xlsxToCsv';

function buildWorkbookBuffer(rows: string[][]): ArrayBuffer {
  const sheet    = utils.aoa_to_sheet(rows);
  const workbook = utils.book_new();
  utils.book_append_sheet(workbook, sheet, 'Sheet1');
  const out = write(workbook, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
  return out;
}

describe('xlsxToCsv', () => {
  it('converts the first sheet of a workbook to CSV text', () => {
    const buffer = buildWorkbookBuffer([
      ['page', 'name', 'specialty', 'location'],
      ['1', 'Dr Sunday Joseph Aigbodion', 'General Practitioner (GP)', 'Springs , Springs, Gauteng'],
    ]);
    const csv = xlsxToCsv(buffer);
    expect(csv).toContain('page,name,specialty,location');
    expect(csv).toContain('Dr Sunday Joseph Aigbodion');
    expect(csv).toContain('Springs , Springs, Gauteng');
  });

  it('quotes a cell that itself contains a comma', () => {
    const buffer = buildWorkbookBuffer([
      ['name', 'location'],
      ['Dr Zaheda Bhabha', 'Bedfordview, Germiston, Gauteng'],
    ]);
    const csv = xlsxToCsv(buffer);
    expect(csv).toContain('"Bedfordview, Germiston, Gauteng"');
  });

  it('only reads the first sheet, ignoring later ones', () => {
    const sheet1   = utils.aoa_to_sheet([['name'], ['Dr Janine Olivier']]);
    const sheet2   = utils.aoa_to_sheet([['name'], ['Dr Should Not Appear']]);
    const workbook = utils.book_new();
    utils.book_append_sheet(workbook, sheet1, 'First');
    utils.book_append_sheet(workbook, sheet2, 'Second');
    const buffer = write(workbook, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;

    const csv = xlsxToCsv(buffer);
    expect(csv).toContain('Dr Janine Olivier');
    expect(csv).not.toContain('Dr Should Not Appear');
  });
});

describe('isExcelFile', () => {
  it('matches .xlsx and .xls, case-insensitively', () => {
    expect(isExcelFile(new File([''], 'leads.xlsx'))).toBe(true);
    expect(isExcelFile(new File([''], 'leads.XLS'))).toBe(true);
  });

  it('does not match .csv or extensionless names', () => {
    expect(isExcelFile(new File([''], 'leads.csv'))).toBe(false);
    expect(isExcelFile(new File([''], 'leads'))).toBe(false);
  });
});
