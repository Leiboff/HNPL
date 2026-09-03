import { describe, expect, it } from 'vitest';
import { CsvFileRejectedError, MAX_CSV_FILE_BYTES, readCsvFile } from './csvUpload';

describe('readCsvFile', () => {
  it('reads a CSV file as text', async () => {
    await expect(readCsvFile(new File(['name\nAlice'], 'leads.CSV'))).resolves.toBe('name\nAlice');
  });

  it.each(['leads.xlsx', 'leads.xls', 'leads.csv.xlsx', 'leads'])('rejects a non-CSV filename: %s', async (name) => {
    await expect(readCsvFile(new File(['not parsed'], name))).rejects.toThrow(CsvFileRejectedError);
  });

  it('rejects a CSV above the server-side size limit before reading it', async () => {
    const file = new File([new Uint8Array(MAX_CSV_FILE_BYTES + 1)], 'leads.csv');
    await expect(readCsvFile(file)).rejects.toThrow(/limited to 5 MB/);
  });
});
