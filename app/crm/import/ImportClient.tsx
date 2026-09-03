'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { buildTemplateCsv, CSV_TEMPLATE_HEADERS, type CsvLeadDraft, type RowError } from '@/lib/crm/csv';
import { readCsvFile } from '@/lib/crm/csvUpload';
import { previewImport, commitImport } from './actions';

export default function ImportClient() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [csvText, setCsvText] = useState('');
  const [preview, setPreview] = useState<null | {
    headers: string[];
    rowCount: number;
    errors: RowError[];
    drafts: (CsvLeadDraft | null)[];
    dupeIdxs: number[];
  }>(null);
  const [excludedDupes, setExcludedDupes] = useState<Set<number>>(new Set());
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  function onFile(f: File) {
    readCsvFile(f)
      .then(text => { setCsvText(text); setMsg(null); })
      .catch((err: unknown) => {
        setCsvText('');
        setMsg({
          kind: 'err',
          text: err instanceof Error ? err.message : 'We couldn\'t read that CSV file.',
        });
      });
  }

  function doPreview() {
    setMsg(null);
    startTransition(async () => {
      const res = await previewImport(csvText);
      if (res.error) { setMsg({ kind: 'err', text: res.error }); return; }
      setPreview({
        headers: res.headers ?? [],
        rowCount: res.rowCount ?? 0,
        errors: res.errors ?? [],
        drafts: res.drafts ?? [],
        dupeIdxs: res.dupeIdxs ?? [],
      });
      setExcludedDupes(new Set(res.dupeIdxs ?? []));
    });
  }

  function doCommit() {
    if (!preview) return;
    setMsg(null);
    // Client-side filter: leave out drafts the user excluded (dupes) and drafts with errors.
    const errorRowNums = new Set(preview.errors.filter(e => e.rowNumber > 0).map(e => e.rowNumber));
    const filtered = preview.drafts.map((d, i) => {
      if (!d) return null;
      if (errorRowNums.has(i + 1)) return null;
      if (excludedDupes.has(i))    return null;
      return d;
    });

    startTransition(async () => {
      const res = await commitImport(filtered, preview.errors, []);
      if (res.error) { setMsg({ kind: 'err', text: res.error }); return; }
      setMsg({ kind: 'ok', text: `Imported ${res.created ?? 0} leads. Skipped ${res.skipped ?? 0} error rows.` });
      setPreview(null);
      setCsvText('');
      router.refresh();
    });
  }

  function toggleDupe(i: number) {
    setExcludedDupes(prev => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i); else next.add(i);
      return next;
    });
  }

  function downloadTemplate() {
    const blob = new Blob([buildTemplateCsv()], { type: 'text/csv;charset=utf-8' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = 'crm-leads-template.csv'; a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-4">

      <div className="bg-white rounded-2xl border border-gray-200 p-4 space-y-3">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold text-gray-900">Upload</h2>
            <p className="text-xs text-gray-500 mt-1">
              Expected columns: {CSV_TEMPLATE_HEADERS.join(', ')}. Export spreadsheets as CSV before uploading.
            </p>
          </div>
          <button
            type="button"
            onClick={downloadTemplate}
            className="rounded-lg border border-gray-200 bg-white text-gray-700 px-3 py-1.5 text-xs font-medium"
          >
            Download template
          </button>
        </div>

        <input
          type="file"
          accept=".csv,text/csv"
          onChange={e => { const f = e.target.files?.[0]; if (f) onFile(f); }}
          className="block text-xs text-gray-600 file:mr-3 file:rounded-lg file:border-0 file:bg-[#13294B] file:text-white file:px-3 file:py-2 file:text-xs file:font-medium file:cursor-pointer"
        />

        <div className="flex gap-2">
          <button
            type="button"
            onClick={doPreview}
            disabled={pending || !csvText}
            className="rounded-lg bg-[#13294B] text-white px-3 py-2 text-sm font-medium disabled:opacity-60"
          >
            {pending ? 'Analysing…' : 'Preview'}
          </button>
        </div>
      </div>

      {msg && (
        <div role="alert" className={`text-xs rounded-lg px-3 py-2 ${msg.kind === 'ok'
          ? 'border border-green-200 bg-green-50 text-green-800'
          : 'border border-red-200 bg-red-50 text-red-700'}`}>
          {msg.text}
        </div>
      )}

      {preview && (
        <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-200 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
            <div>
              <p className="text-sm font-semibold text-gray-900">Preview — {preview.rowCount} rows</p>
              <p className="text-xs text-gray-500">
                {preview.errors.length > 0 && `${preview.errors.length} errors · `}
                {preview.dupeIdxs.length > 0 && `${preview.dupeIdxs.length} potential duplicates (unchecked = skip) · `}
                {preview.drafts.filter(Boolean).length} candidate rows
              </p>
            </div>
            <button
              type="button"
              onClick={doCommit}
              disabled={pending || preview.drafts.filter(Boolean).length === 0}
              className="rounded-lg bg-[#13294B] text-white px-3 py-2 text-sm font-medium disabled:opacity-60"
            >
              {pending ? 'Importing…' : `Commit import`}
            </button>
          </div>

          {preview.errors.length > 0 && (
            <div className="bg-red-50 border-b border-red-100 px-4 py-3 space-y-1">
              <p className="text-xs font-semibold text-red-800">Row errors — these rows will be skipped</p>
              <ul className="text-[11px] text-red-700 list-disc pl-5">
                {preview.errors.map((e, i) => (
                  <li key={i}>Row {e.rowNumber || '(file)'}: {e.field} — {e.message}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="overflow-x-auto max-h-[60vh] overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="bg-gray-50 border-b border-gray-200 sticky top-0">
                <tr>
                  <th className="px-2 py-2 text-left font-medium text-gray-500">#</th>
                  <th className="px-2 py-2 text-left font-medium text-gray-500">Import?</th>
                  <th className="px-2 py-2 text-left font-medium text-gray-500">Practice</th>
                  <th className="px-2 py-2 text-left font-medium text-gray-500">Contact</th>
                  <th className="px-2 py-2 text-left font-medium text-gray-500">Phone</th>
                  <th className="px-2 py-2 text-left font-medium text-gray-500">Email</th>
                  <th className="px-2 py-2 text-left font-medium text-gray-500">Suburb</th>
                  <th className="px-2 py-2 text-left font-medium text-gray-500">Source</th>
                  <th className="px-2 py-2 text-left font-medium text-gray-500">Notes</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {preview.drafts.map((d, i) => {
                  const rowNum = i + 1;
                  const hasError = preview.errors.some(e => e.rowNumber === rowNum);
                  const isDupe   = preview.dupeIdxs.includes(i);
                  const included = !hasError && (!isDupe || !excludedDupes.has(i));
                  if (!d) return null;
                  return (
                    <tr key={i} className={hasError ? 'bg-red-50/40' : isDupe ? 'bg-amber-50/40' : ''}>
                      <td className="px-2 py-1.5 text-gray-500 tabular-nums">{rowNum}</td>
                      <td className="px-2 py-1.5">
                        {hasError ? (
                          <span className="text-red-600 text-[10px]">skip (error)</span>
                        ) : isDupe ? (
                          <label className="text-[10px] text-amber-800 flex items-center gap-1">
                            <input type="checkbox" checked={!excludedDupes.has(i)} onChange={() => toggleDupe(i)} />
                            dupe
                          </label>
                        ) : (
                          <span className={included ? 'text-green-700 text-[10px]' : 'text-gray-500 text-[10px]'}>
                            {included ? 'yes' : '—'}
                          </span>
                        )}
                      </td>
                      <td className="px-2 py-1.5 text-gray-900">{d.practice_name}</td>
                      <td className="px-2 py-1.5 text-gray-700">{d.contact_first_name} {d.contact_last_name}</td>
                      <td className="px-2 py-1.5 text-gray-600">{d.phone ?? '—'}</td>
                      <td className="px-2 py-1.5 text-gray-600">{d.email ?? '—'}</td>
                      <td className="px-2 py-1.5 text-gray-600">{d.suburb ?? '—'}</td>
                      <td className="px-2 py-1.5 text-gray-600">{d.source}</td>
                      <td className="px-2 py-1.5 text-gray-500 truncate max-w-[220px]">{d.notes ?? '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
