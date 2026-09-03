/** Keep browser memory use aligned with the server actions' 5 MB cap. */
export const MAX_CSV_FILE_BYTES = 5 * 1024 * 1024;

export class CsvFileRejectedError extends Error {}

export async function readCsvFile(file: File): Promise<string> {
  if (!/\.csv$/i.test(file.name)) {
    throw new CsvFileRejectedError(
      'Only CSV files are supported. Export the spreadsheet as CSV and try again.',
    );
  }
  if (file.size > MAX_CSV_FILE_BYTES) {
    throw new CsvFileRejectedError('CSV files are limited to 5 MB. Split the file and try again.');
  }
  return file.text();
}
