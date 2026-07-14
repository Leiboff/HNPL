'use client';

import { useState, useTransition } from 'react';
import { saveMySignature, previewMySignature, type SavedSignature } from './signatureActions';

// ─── Signature editor ─────────────────────────────────────────────
//
// Simple form: structured fields (display_name / title / phone /
// email) drive the brand template. Advanced users can paste a raw
// HTML override — it's sanitised on save (scripts, event handlers,
// javascript: URLs stripped). Preview is server-side so it uses the
// SAME code path as compose.

type Props = {
  initial: SavedSignature;
};

export default function SignatureEditor({ initial }: Props) {
  const [displayName,  setDisplayName]  = useState(initial.displayName);
  const [title,        setTitle]        = useState(initial.title);
  const [phone,        setPhone]        = useState(initial.phone);
  const [email,        setEmail]        = useState(initial.email);
  const [htmlOverride, setHtmlOverride] = useState(initial.htmlOverride ?? '');
  const [textFallback, setTextFallback] = useState(initial.textFallback ?? '');

  const [preview,   setPreview] = useState<{ html: string; text: string } | null>(null);
  const [msg,       setMsg]     = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [pending,   startTransition] = useTransition();

  function refresh() {
    setMsg(null);
    startTransition(async () => {
      const res = await previewMySignature({
        displayName, title, phone, email,
        htmlOverride: htmlOverride || undefined,
        textFallback: textFallback || undefined,
      });
      if (res.error) { setMsg({ kind: 'err', text: res.error }); return; }
      setPreview({ html: res.html ?? '', text: res.text ?? '' });
    });
  }

  function save() {
    setMsg(null);
    startTransition(async () => {
      const res = await saveMySignature({
        displayName, title, phone, email,
        htmlOverride: htmlOverride || undefined,
        textFallback: textFallback || undefined,
      });
      if (!res.ok) { setMsg({ kind: 'err', text: res.error ?? 'save_failed' }); return; }
      setMsg({ kind: 'ok', text: 'Signature saved.' });
    });
  }

  return (
    <div className="bg-white rounded-2xl border border-gray-200 p-5 space-y-4" data-testid="signature-editor">
      <div>
        <h2 className="text-sm font-semibold text-gray-900">Email signature</h2>
        <p className="text-xs text-gray-500 mt-1">
          Auto-appended to every CRM email. Change any time. Personal Gmail signature (if set)
          is not used — the CRM controls brand consistency here.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="text-xs text-gray-700 block">
          Display name
          <input
            value={displayName} onChange={e => setDisplayName(e.target.value)}
            className="mt-1 w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm"
            data-testid="signature-display-name"
          />
        </label>
        <label className="text-xs text-gray-700 block">
          Title
          <input
            value={title} onChange={e => setTitle(e.target.value)}
            className="mt-1 w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm"
            data-testid="signature-title"
          />
        </label>
        <label className="text-xs text-gray-700 block">
          Phone
          <input
            value={phone} onChange={e => setPhone(e.target.value)}
            className="mt-1 w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm"
            data-testid="signature-phone"
          />
        </label>
        <label className="text-xs text-gray-700 block">
          Email
          <input
            value={email} onChange={e => setEmail(e.target.value)}
            className="mt-1 w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm"
            data-testid="signature-email"
          />
        </label>
      </div>

      <details className="text-xs">
        <summary className="cursor-pointer text-gray-700">Advanced — raw HTML override</summary>
        <div className="mt-3 space-y-3">
          <label className="text-xs text-gray-700 block">
            HTML
            <textarea
              value={htmlOverride} onChange={e => setHtmlOverride(e.target.value)}
              rows={6}
              className="mt-1 w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs font-mono"
              placeholder="Leave blank to use the brand template. Scripts and event handlers are stripped on save."
              data-testid="signature-html-override"
            />
          </label>
          <label className="text-xs text-gray-700 block">
            Plain-text fallback
            <textarea
              value={textFallback} onChange={e => setTextFallback(e.target.value)}
              rows={3}
              className="mt-1 w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs font-mono"
              placeholder="Auto-derived if blank."
              data-testid="signature-text-fallback"
            />
          </label>
        </div>
      </details>

      <div className="flex gap-2">
        <button
          type="button" onClick={refresh} disabled={pending}
          className="rounded-lg border border-gray-200 bg-white text-gray-700 px-3 py-2 text-sm"
          data-testid="signature-preview-btn"
        >
          {pending ? 'Working…' : 'Preview'}
        </button>
        <button
          type="button" onClick={save} disabled={pending}
          className="rounded-lg bg-[#13294B] text-white px-3 py-2 text-sm font-medium"
          data-testid="signature-save"
        >
          Save signature
        </button>
      </div>

      {msg && (
        <p
          role="alert"
          data-testid={msg.kind === 'ok' ? 'signature-saved' : 'signature-error'}
          className={msg.kind === 'ok' ? 'text-xs text-emerald-700' : 'text-xs text-red-700'}
        >
          {msg.text}
        </p>
      )}

      {preview && (
        <div className="rounded-lg border border-gray-200 bg-gray-50 p-3" data-testid="signature-preview">
          <p className="text-[11px] font-semibold text-gray-600 mb-2">Preview:</p>
          <div className="bg-white rounded p-3 border border-gray-100" dangerouslySetInnerHTML={{ __html: preview.html }} />
          <pre className="mt-3 text-[11px] whitespace-pre-wrap text-gray-600">{preview.text}</pre>
        </div>
      )}
    </div>
  );
}
