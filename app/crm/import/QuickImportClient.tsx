'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { buildQuickTemplateCsv, type QuickRowError } from '@/lib/crm/quickImportCsv';
import { previewQuickImport, commitQuickImport, type QuickPreviewRow } from './quickActions';

// ─── Quick import: name + specialty + neighbourhood only ─────────────
//
// For directory-style sources that give a full name, a free-text
// specialty, and a rough neighbourhood string rather than a precise
// street address. The server splits the name, normalises the
// specialty, and geocodes the neighbourhood to an approximate centre
// (see app/crm/import/quickActions.ts) — good enough to plot on
// /crm/map immediately; anyone can later replace it with a precise
// address via the map's "missing coordinates" backfill flow, or a full
// CSV re-import doesn't overwrite anything since this only inserts.

export default function QuickImportClient() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [csvText, setCsvText] = useState('');
  const [preview, setPreview] = useState<null | {
    rowCount: number;
    errors:   QuickRowError[];
    rows:     (QuickPreviewRow | null)[];
  }>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  function onFile(f: File) {
    const reader = new FileReader();
    reader.onload = () => setCsvText(String(reader.result ?? ''));
    reader.readAsText(f);
  }

  function doPreview() {
    setMsg(null);
    startTransition(async () => {
      const res = await previewQuickImport(csvText);
      if (res.error) { setMsg({ kind: 'err', text: res.error }); return; }
      setPreview({ rowCount: res.rowCount ?? 0, errors: res.errors ?? [], rows: res.rows ?? [] });
    });
  }

  function doCommit() {
    if (!preview) return;
    setMsg(null);
    const errorRowNums = new Set(preview.errors.filter(e => e.rowNumber > 0).map(e => e.rowNumber));
    const filtered = preview.rows.map((r, i) => (errorRowNums.has(i + 1) ? null : r));

    startTransition(async () => {
      const res = await commitQuickImport(filtered, preview.errors);
      if (res.error) { setMsg({ kind: 'err', text: res.error }); return; }
      setMsg({ kind: 'ok', text: `Imported ${res.created ?? 0} leads. Skipped ${res.skipped ?? 0} error rows.` });
      setPreview(null);
      setCsvText('');
      router.refresh();
    });
  }

  function downloadTemplate() {
    const blob = new Blob([buildQuickTemplateCsv()], { type: 'text/csv;charset=utf-8' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = 'crm-leads-quick-template.csv'; a.click();
    URL.revokeObjectURL(url);
  }

  const candidateRows  = preview?.rows.filter((r): r is QuickPreviewRow => !!r) ?? [];
  const geocodedCount  = candidateRows.filter(r => r.geocoded).length;

  return (
    <div className="space-y-4">

      <div className="bg-white rounded-2xl border border-gray-200 p-4 space-y-3">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold text-gray-900">Upload</h2>
            <p className="text-xs text-gray-500 mt-1">
              Columns: name, specialty, location (e.g. &quot;Springs, Springs, Gauteng&quot;). Any other column
              (like a &quot;page&quot; number) is ignored. Location is geocoded to an approximate neighbourhood
              centre, not a precise street address — good enough to plot leads on the map today.
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
            {pending ? 'Analysing (geocoding neighbourhoods)…' : 'Preview'}
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
                {candidateRows.length} candidate rows · {geocodedCount} plotted on the map, {candidateRows.length - geocodedCount} without coords for now
              </p>
            </div>
            <button
              type="button"
              onClick={doCommit}
              disabled={pending || candidateRows.length === 0}
              className="rounded-lg bg-[#13294B] text-white px-3 py-2 text-sm font-medium disabled:opacity-60"
            >
              {pending ? 'Importing…' : 'Commit import'}
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
                  <th className="px-2 py-2 text-left font-medium text-gray-500">Name</th>
                  <th className="px-2 py-2 text-left font-medium text-gray-500">Specialty</th>
                  <th className="px-2 py-2 text-left font-medium text-gray-500">Suburb / City / Province</th>
                  <th className="px-2 py-2 text-left font-medium text-gray-500">Coords</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {preview.rows.map((r, i) => {
                  const rowNum = i + 1;
                  const hasError = preview.errors.some(e => e.rowNumber === rowNum);
                  if (!r) return null;
                  return (
                    <tr key={i} className={hasError ? 'bg-red-50/40' : ''}>
                      <td className="px-2 py-1.5 text-gray-500 tabular-nums">{rowNum}</td>
                      <td className="px-2 py-1.5 text-gray-900">
                        {hasError
                          ? <span className="text-red-600 text-[10px]">skip (error)</span>
                          : `${r.contactFirstName} ${r.contactLastName}`.trim()}
                      </td>
                      <td className="px-2 py-1.5 text-gray-600">{r.specialty ?? '—'}</td>
                      <td className="px-2 py-1.5 text-gray-600">{[r.suburb, r.city, r.province].filter(Boolean).join(', ') || '—'}</td>
                      <td className="px-2 py-1.5">
                        {r.geocoded
                          ? <span className="text-green-700 text-[10px]">✓ plotted</span>
                          : <span className="text-amber-700 text-[10px]">no match</span>}
                      </td>
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
