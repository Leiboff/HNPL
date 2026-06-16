'use client';

import { useState, useTransition } from 'react';
import type { AuditEntityType } from '../_lib/auditActions';

// Add-note input — calls the server action, surfaces errors, clears
// on success. The server action revalidates the page so the new note
// appears at the top of the timeline immediately.

type Props = {
  entityType: AuditEntityType;
  entityId:   string;
  addNote:    (entityType: AuditEntityType, entityId: string, text: string)
              => Promise<{ ok: true } | { ok: false; error: string }>;
};

export default function AddNoteForm({ entityType, entityId, addNote }: Props) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const trimmed = text.trim();
    if (!trimmed) return;
    startTransition(async () => {
      const result = await addNote(entityType, entityId, trimmed);
      if (result.ok) setText('');
      else           setError(result.error);
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-2">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Add an internal note — &quot;spoke to them about X…&quot;"
        rows={3}
        maxLength={2000}
        className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-[#15A89E]/40 focus:border-[#15A89E] resize-y"
      />
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs text-gray-400">
          {text.length}/2000 · visible only to admins · attributed + timestamped
        </span>
        <button
          type="submit"
          disabled={isPending || text.trim().length === 0}
          className="rounded-lg bg-[#13294B] text-white px-3 py-1.5 text-sm font-medium disabled:opacity-60"
        >
          {isPending ? 'Adding…' : 'Add note'}
        </button>
      </div>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </form>
  );
}
