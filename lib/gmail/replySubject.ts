// ─── Subject-line utilities for reply mode ────────────────────────
//
// Kept out of the 'use server' compose action file so we can export
// the sync helper directly (Next requires server-action files to
// export ONLY async functions).

/**
 * Idempotent "Re:" prefix. Case-insensitive: an existing `Re:` /
 * `RE:` / `re:` prefix is preserved as-typed. Empty input → empty
 * (no bare "Re:").
 *
 * Note: other prefixes like `Fwd:` are wrapped normally
 * (`Re: Fwd: intro`) — that's the standard mail-client behaviour.
 */
export function prefixReSubject(subject: string): string {
  const trimmed = (subject ?? '').trim();
  if (!trimmed) return '';
  if (/^re\s*:/i.test(trimmed)) return trimmed;
  return `Re: ${trimmed}`;
}

/**
 * Recover the original subject from an outbound activity's title.
 * Outbound rows carry `Email sent: ${subject.slice(0, 60)}` — for
 * subjects under 60 chars the recovered subject is exact; longer
 * subjects come back truncated (acceptable — the user can extend it
 * in the compose sheet before sending).
 */
export function deriveSubjectFromOutboundTitle(title: string | null): string | null {
  if (!title) return null;
  const m = title.match(/^Email sent:\s*(.+)$/);
  return m ? m[1].trim() : null;
}
