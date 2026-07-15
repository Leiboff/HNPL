// ─── splitQuoted — separate fresh reply text from quoted tail ──────
//
// Pure function; no DOM, no dependencies. The timeline stores full
// message text (Part 1) and the UI hides quoted material with a
// Gmail-style ••• toggle. This module is the sole cutover point —
// we look for the earliest cue that quoted content starts, and
// everything from that cue onward goes to `quoted`.
//
// Cues, in the order they appear on the wire (we cut at the earliest):
//   • Gmail attribution: "On <date> [<name>] wrote:" — tolerating
//     the attribution wrapping across multiple lines and both raw
//     and entity-decoded forms.
//   • Outlook block: a run of "From:" / "Sent:" / "To:" / "Subject:"
//     header lines.
//   • Any "> "-prefixed line (or a run of them).
//   • The "-- " signature delimiter — everything from that line on
//     is treated as signature/quoted-tail (still surfaces via toggle).
//
// If the resulting `fresh` block is empty (reply-was-only-quotes,
// which we've seen from mobile Gmail one-tapping a "Reply" without
// typing), we DO NOT render an empty message. The caller re-uses
// the first paragraph of `quoted` as fresh text instead — see
// materialiseSplit().

export type QuoteSplit = {
  fresh:  string;
  quoted: string;
};

/**
 * Find the byte offset of the first quote cue in `text`, or -1 if
 * the entire message is fresh content. Fresh = [0, offset); quoted =
 * [offset, ...). Callers should trim the halves before rendering.
 */
export function findFirstQuoteCue(text: string): number {
  if (!text) return -1;
  // Normalise line endings for the scan; the actual slice uses the
  // original input's offsets so we don't shift indices around.
  const src = text.replace(/\r\n?/g, '\n');
  const lines = src.split('\n');

  // Rebuild an offset table so a line index maps back to a byte
  // position (inclusive of the trailing \n on preceding lines).
  const lineStart: number[] = new Array(lines.length);
  {
    let acc = 0;
    for (let i = 0; i < lines.length; i++) {
      lineStart[i] = acc;
      acc += lines[i].length + 1;   // +1 for the \n we split on
    }
  }

  const ATTRIB_RE = /^\s*On\b[\s\S]*?wrote\s*:\s*$/;
  const OUTLOOK_HDR_RE = /^\s*(?:From|Sent|To|Subject|Cc|Bcc)\s*:/i;
  const QUOTE_LINE_RE = /^\s*>/;
  const SIG_DELIM_RE = /^\s*--\s?$/;

  // Gmail's "On ... wrote:" attribution can span 1..N lines when
  // Gmail wraps the date/name. Detect it by looking for an "On <…"
  // start and scanning up to WRAP_MAX subsequent lines for "wrote:".
  const WRAP_MAX = 4;
  const ATTRIB_START_RE = /^\s*On\b/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // 1. Signature delimiter — the "-- " sentinel is fussy about the
    //    trailing space per RFC 3676, but we've all seen the space
    //    trimmed by clients. Accept both.
    if (SIG_DELIM_RE.test(line)) return lineStart[i];

    // 2. Quote-prefixed line (allow leading whitespace to be liberal
    //    with mobile Gmail quirks).
    if (QUOTE_LINE_RE.test(line)) return lineStart[i];

    // 3. Outlook From:/Sent:/etc. header block — require AT LEAST two
    //    consecutive header lines so we don't false-positive on a
    //    fresh "From: bosses of the world" body paragraph.
    if (OUTLOOK_HDR_RE.test(line) && i + 1 < lines.length && OUTLOOK_HDR_RE.test(lines[i + 1])) {
      return lineStart[i];
    }

    // 4. Gmail attribution — either single-line or wrapped.
    if (ATTRIB_RE.test(line)) return lineStart[i];
    if (ATTRIB_START_RE.test(line)) {
      // Look ahead a few lines for "wrote:".
      for (let j = 1; j <= WRAP_MAX && i + j < lines.length; j++) {
        if (/wrote\s*:\s*$/.test(lines[i + j])) {
          // Cut at the START of the attribution ("On …"), not the
          // wrapped "wrote:" line.
          return lineStart[i];
        }
        // If we hit a blank line first, this isn't a wrapped attribution.
        if (lines[i + j].trim().length === 0) break;
      }
    }
  }

  return -1;
}

/**
 * Split a message into fresh + quoted halves. Both are trimmed of
 * leading / trailing blank lines. `quoted` is the empty string when
 * no quote cue is found.
 */
export function splitQuoted(text: string): QuoteSplit {
  if (!text) return { fresh: '', quoted: '' };
  const cue = findFirstQuoteCue(text);
  if (cue < 0) return { fresh: stripEdges(text), quoted: '' };
  const fresh  = stripEdges(text.slice(0, cue));
  const quoted = stripEdges(text.slice(cue));
  return { fresh, quoted };
}

/**
 * Render-time helper: guarantees a non-empty fresh block. When the
 * detected fresh text is empty (mobile Gmail's "just quote" reply),
 * lift the first non-empty line of quoted into fresh so the timeline
 * never renders a message with no visible content.
 */
export function materialiseSplit(text: string): QuoteSplit {
  const s = splitQuoted(text);
  if (s.fresh.trim().length > 0 || s.quoted.length === 0) return s;
  const quotedLines = s.quoted.split('\n');
  const firstNonEmpty = quotedLines.findIndex(l => l.trim().length > 0);
  if (firstNonEmpty < 0) return s;
  // Take the first few lines as the "fresh" preview so the render
  // has something to show; leave the ORIGINAL quoted block intact
  // (still available via the ••• toggle).
  const previewCount = Math.min(3, quotedLines.length - firstNonEmpty);
  const fresh = quotedLines.slice(firstNonEmpty, firstNonEmpty + previewCount)
    .join('\n')
    .trim();
  return { fresh, quoted: s.quoted };
}

function stripEdges(s: string): string {
  return s.replace(/^\s+|\s+$/g, '');
}

/** One-line preview: first non-empty line, collapsed whitespace,
 *  truncated. Used as the collapsed-card summary. */
export function firstLine(text: string, maxLen = 140): string {
  if (!text) return '';
  const line = text
    .split('\n')
    .map(l => l.trim())
    .find(l => l.length > 0) ?? '';
  const collapsed = line.replace(/\s+/g, ' ');
  return collapsed.length > maxLen ? `${collapsed.slice(0, maxLen - 1)}…` : collapsed;
}
