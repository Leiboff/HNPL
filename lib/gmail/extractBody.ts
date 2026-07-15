// ─── Message body extraction — plain text / HTML / snippet fallback
//
// The ingestion path stores whatever this returns as the activity's
// `body`. Never reaches the recipient — this is our internal record
// of what the inbound (or outbound) message said. We keep the full
// text INCLUDING any quoted tail; the UI is responsible for hiding
// quoted material at render time (see quoteSplit.ts).

/** Decode the small set of HTML numeric + named entities Gmail leaks
 *  into snippets and text/html bodies. Not a general-purpose HTML
 *  decoder — no DOM required. Handles &amp; &lt; &gt; &quot; &#39;
 *  &nbsp; and numeric forms &#NN;/&#xNN;. */
export function decodeHtmlEntities(input: string): string {
  if (!input) return '';
  return input
    // Numeric decimal
    .replace(/&#(\d+);/g, (_, n) => {
      const code = Number(n);
      return Number.isFinite(code) && code > 0 && code < 0x10FFFF
        ? String.fromCodePoint(code) : '';
    })
    // Numeric hex
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => {
      const code = parseInt(n, 16);
      return Number.isFinite(code) && code > 0 && code < 0x10FFFF
        ? String.fromCodePoint(code) : '';
    })
    // Named — small allow-list covers what Gmail actually emits.
    .replace(/&(amp|lt|gt|quot|apos|nbsp|copy|reg|hellip|mdash|ndash|rsquo|lsquo|ldquo|rdquo);/g, (_, n) => {
      switch (n) {
        case 'amp':    return '&';
        case 'lt':     return '<';
        case 'gt':     return '>';
        case 'quot':   return '"';
        case 'apos':   return "'";
        case 'nbsp':   return ' ';
        case 'copy':   return '©';
        case 'reg':    return '®';
        case 'hellip': return '…';
        case 'mdash':  return '—';
        case 'ndash':  return '–';
        case 'rsquo':  return '’';
        case 'lsquo':  return '‘';
        case 'ldquo':  return '“';
        case 'rdquo':  return '”';
      }
      return '';
    });
}

/** Convert an HTML string to reasonable plain text: strip tags,
 *  preserve paragraph and line breaks, collapse repeated blank lines,
 *  decode entities. Never touches attributes, script/style bodies are
 *  removed wholesale. */
export function htmlToText(html: string): string {
  if (!html) return '';
  let s = html;
  // Drop script/style bodies (contents included). Runs before any
  // tag-strip so the contents don't get preserved as text.
  s = s.replace(/<script\b[\s\S]*?<\/script>/gi, '');
  s = s.replace(/<style\b[\s\S]*?<\/style>/gi, '');
  // Break tags → newlines.
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n');
  s = s.replace(/<(p|div|li|tr|h[1-6])\b[^>]*>/gi, '\n');
  // Strip remaining tags.
  s = s.replace(/<[^>]+>/g, '');
  // Decode entities AFTER tags are gone so decoded < > aren't
  // interpreted as tags.
  s = decodeHtmlEntities(s);
  // Normalise whitespace: convert CRLF/CR → LF, collapse 3+ blank
  // lines to 2 (paragraph break), trim.
  s = s.replace(/\r\n?/g, '\n');
  s = s.replace(/[ \t]+\n/g, '\n');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

/**
 * Pick the body to store. Prefers text/plain (preserving its exact
 * whitespace), else falls back to HTML converted to text, else the
 * entity-decoded snippet — but never returns empty when there was
 * anything to work with.
 */
export function chooseIngestBody(input: {
  plain:   string | null;
  html:    string | null;
  snippet: string;
}): string {
  const { plain, html, snippet } = input;
  if (plain && plain.trim()) {
    // Plain text sometimes still ships with the odd encoded entity —
    // decode defensively.
    return decodeHtmlEntities(normaliseLineEndings(plain)).trim();
  }
  if (html && html.trim()) {
    return htmlToText(html);
  }
  return decodeHtmlEntities(snippet ?? '').trim();
}

function normaliseLineEndings(s: string): string {
  return s.replace(/\r\n?/g, '\n');
}
