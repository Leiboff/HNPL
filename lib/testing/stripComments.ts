// ─── Comment stripping for source-pin tests ───────────────────────────────
//
// Many tests in this repo assert things about SOURCE TEXT — that a file does
// not call `.single()`, does not name a deprecated column, does not hardcode a
// route. Those files legitimately DISCUSS the very thing they must not do
// (that is how the decision documents itself), so the prose has to go before
// the assertion runs.
//
// WHY THIS IS ONE SHARED HELPER AND NOT TWENTY COPIES
// ──────────────────────────────────────────────────
// It was twenty copies, and thirteen of them had the same bug: they stripped
// BLOCK comments before LINE comments.
//
//   // see app/practice/pos/devices/**  ← the `/*` here opens a block comment
//   const realCode = 1;                   as far as the block regex is
//   ...                                   concerned...
//   {/* a JSX comment */}              ← ...and this is where it thinks the
//                                         block ends.
//
// Everything between was deleted. On app/practice/settings/page.tsx that was
// 3,443 of 13,835 characters. The visible symptom is a presence assertion
// failing on code that is plainly there — but the dangerous half is silent:
// every ABSENCE assertion in an affected file passes trivially, because the
// text it is looking for was thrown away. Tests written specifically to catch
// drift stop catching anything and never say so.
//
// WHY A SINGLE PASS RATHER THAN SWAPPING THE ORDER
// ───────────────────────────────────────────────
// Swapping to line-then-block fixes that case but breaks the mirror image:
//
//   /* a block comment
//      whose last line ends with a // note */
//
// Stripping line comments first eats `*/` along with the note, leaving an
// unterminated `/*` — and the non-greedy block regex then matches nothing, so
// the ENTIRE comment survives into the "code". Neither order is correct,
// because the two comment forms are not independent: whichever opens FIRST
// wins, and only reading left-to-right knows which that is.
//
// So this walks the source once. `//` inside a block comment is text; `/*`
// inside a line comment is text. There is no order to get wrong.
//
// WHAT IT DELIBERATELY DOES NOT DO
// ────────────────────────────────
// It does not track string or template literals, so `'https://example.test'`
// loses everything after the `//` unless `preserveUrls` is set. That matches
// what every one of the twenty copies already did, which keeps this a pure
// bug fix: no call site changes behaviour except where the ordering was
// wrong. Two call sites that already guarded against it pass `preserveUrls`.

export type StripCommentsOptions = {
  /**
   * Also treat `-- …` as a line comment. For .sql sources.
   *
   * Note this matters for the same reason as the JS case: a `--` comment
   * mentioning a path with `/*` in it would otherwise open a block comment.
   */
  sql?: boolean;
  /**
   * Remove the braces wrapping a JSX comment too, so a `{`-comment-`}` leaves
   * nothing behind rather than an empty pair. Only braces immediately around a
   * comment are touched — a real empty object literal is left alone.
   */
  jsxBraces?: boolean;
  /**
   * Do not treat `//` as a line comment when it is preceded by `:`, so URLs in
   * string literals survive. Set by the call sites that already guarded for it.
   */
  preserveUrls?: boolean;
};

/**
 * Return `src` with its comments removed, reading left to right.
 *
 * Line comments are replaced by nothing but their terminating newline is kept,
 * so line structure survives. Block comments are removed entirely, newlines
 * included — matching what the helpers this replaces did, so that slice-based
 * assertions built around them keep the same offsets.
 */
export function stripComments(src: string, opts: StripCommentsOptions = {}): string {
  const { sql = false, jsxBraces = false, preserveUrls = false } = opts;

  // Built as an array of chunks; `out.join('')` at the end. Pushing per-char
  // is fine at these sizes (the largest source in the repo is ~55KB) and keeps
  // the state machine readable, which is the point of the whole exercise.
  const out: string[] = [];
  let i = 0;

  /** Index in `out` of the `{` that may be wrapping a JSX comment. */
  let pendingBrace = -1;

  while (i < src.length) {
    const two = src.slice(i, i + 2);

    // ── Line comment ──────────────────────────────────────────────────────
    const isLineStart =
      (two === '//' && !(preserveUrls && src[i - 1] === ':')) ||
      (sql && two === '--');

    if (isLineStart) {
      while (i < src.length && src[i] !== '\n') i++;
      // Keep the newline: dropping it would join the previous line to the
      // next, which can fabricate a match that spans two statements.
      if (i < src.length) { out.push('\n'); i++; }
      continue;
    }

    // ── Block comment ─────────────────────────────────────────────────────
    if (two === '/*') {
      // `{/* … */}` — remember the brace so it can go with the comment.
      if (jsxBraces) {
        let k = out.length - 1;
        while (k >= 0 && /^\s*$/.test(out[k])) k--;
        pendingBrace = k >= 0 && out[k] === '{' ? k : -1;
      }

      const end = src.indexOf('*/', i + 2);
      // An unterminated block comment runs to EOF. Treating the rest as
      // comment is the same thing the compiler would do.
      i = end === -1 ? src.length : end + 2;

      if (jsxBraces && pendingBrace !== -1) {
        // Drop the opening brace, and the matching closer if it is next.
        let j = i;
        while (j < src.length && /\s/.test(src[j])) j++;
        if (src[j] === '}') {
          out[pendingBrace] = '';
          i = j + 1;
        }
        pendingBrace = -1;
      }
      continue;
    }

    out.push(src[i]);
    i++;
  }

  return out.join('');
}
