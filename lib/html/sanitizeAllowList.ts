// ─── An allow-list HTML sanitiser that parses instead of deleting ──────────
//
// THE DEFECT THIS REPLACES (audit 2026-09-02, A-08)
//
// `sanitizeSignatureHtml` was a sequence of regex deletions: strip these tag
// names, strip `on*=` attributes, rewrite `javascript:` in href/src. Five
// bypasses were confirmed against it, and they are all the same bug:
//
//   <img/onerror=alert(1) src=x>   the on* patterns all require whitespace
//                                 before the attribute. `/` separates
//                                 attributes just as well as a space does.
//   <svg/onload=alert(1)>          `svg` was not in the tag list at all, and
//                                 the same `/` trick carries the handler.
//   <a href="j&#97;vascript:…">    the URL rewrite matches the literal text
//                                 "javascript". An HTML entity is decoded by
//                                 the browser AFTER the regex has run.
//   <a href="java&#10;script:…">   likewise: browsers strip control
//                                 characters from a URL scheme; a regex does
//                                 not know that.
//   <script src=…                  the paired pattern needs a closing tag and
//                                 the self-closing pattern needs a `>`. An
//                                 unterminated tag matches neither and
//                                 survives verbatim, and the browser happily
//                                 finishes it.
//
// A denylist over a string can always be beaten, because the attacker is
// writing for the browser's parser and the filter is written against a
// different, simpler grammar. The gap between those two grammars IS the
// vulnerability, and no amount of additional patterns closes it. Every fix
// above would have been a sixth pattern with a seventh bypass behind it.
//
// ─── WHAT THIS DOES INSTEAD ────────────────────────────────────────────────
//
// It tokenises the input into tags, attributes and text, then SERIALISES a
// fresh document from what it understood. Nothing is deleted from the input
// string and nothing from the input reaches the output uninspected:
//
//   • a tag is emitted only if its name is on the allow-list;
//   • an attribute is emitted only if its name is on that element's
//     allow-list AND its value passes the value check for its kind;
//   • text is HTML-escaped on the way out, so a stray `<` cannot become a
//     tag no matter how it got there;
//   • a tag that never terminates is dropped, not passed through;
//   • the output is well-formed: unclosed elements are closed, and a closing
//     tag for something never opened is discarded.
//
// The property that makes this a different KIND of defence: an input the
// tokeniser does not understand produces LESS output, never unfiltered
// output. A novel piece of syntax is a parse failure, not a bypass.
//
// ─── WHY NOT DOMPurify ─────────────────────────────────────────────────────
//
// It is the right library and it does not fit here. This function runs in
// three places: a Server Action at write time, a server-rendered preview,
// and a React client component's dangerouslySetInnerHTML. DOMPurify needs a
// DOM, so the server paths would need jsdom — a large dependency in the
// request path — and the two environments would then be running different
// sanitisers, which is its own class of bug. One implementation, both
// environments, no dependencies.
//
// ─── URL SCHEMES ───────────────────────────────────────────────────────────
//
// Checked by DECODING first — HTML entities, then percent-encoding, then
// stripping the whitespace and C0 control characters browsers ignore inside
// a scheme — and only then comparing the scheme against an allow-list. That
// is the order the browser resolves them in, and doing it in that order is
// what makes `j&#97;vascript:` and `java&#10;script:` fail here rather than
// somewhere later.

// ── The allow-list ─────────────────────────────────────────────────────────
//
// Scoped to what an email signature is: text formatting, a table layout,
// links, and an image. Nothing interactive, nothing that loads code,
// nothing that can navigate the page it is previewed on.

const GLOBAL_ATTRS = new Set(['style', 'title', 'dir', 'lang']);

const ALLOWED: Record<string, Set<string>> = {
  // Structure
  div:    new Set(),
  span:   new Set(),
  p:      new Set(),
  br:     new Set(),
  hr:     new Set(),
  // Formatting
  b:      new Set(),
  strong: new Set(),
  i:      new Set(),
  em:     new Set(),
  u:      new Set(),
  s:      new Set(),
  small:  new Set(),
  sub:    new Set(),
  sup:    new Set(),
  font:   new Set(['color', 'face', 'size']),
  // Lists — signatures use them for credential lines
  ul:     new Set(),
  ol:     new Set(),
  li:     new Set(),
  // Table layout, which is how every email signature on earth is built
  table:  new Set(['role', 'cellpadding', 'cellspacing', 'border', 'width', 'align', 'bgcolor']),
  thead:  new Set(),
  tbody:  new Set(),
  tfoot:  new Set(),
  tr:     new Set(['valign', 'align', 'bgcolor']),
  td:     new Set(['valign', 'align', 'colspan', 'rowspan', 'width', 'height', 'bgcolor', 'nowrap']),
  th:     new Set(['valign', 'align', 'colspan', 'rowspan', 'width', 'height', 'bgcolor', 'nowrap']),
  // Links and images
  a:      new Set(['href', 'target', 'rel']),
  img:    new Set(['src', 'alt', 'width', 'height', 'border']),
};

/** Void elements: no content, no closing tag. */
const VOID = new Set(['br', 'hr', 'img']);

/**
 * Elements whose CONTENT is discarded along with the tag.
 *
 * The distinction matters. `<marquee>hello</marquee>` is not on the
 * allow-list, and the friendly answer is to keep "hello" — a signature that
 * loses its text because of one unsupported wrapper is a bad outcome. But
 * `<script>alert(1)</script>` must lose its body too: unwrapping it would
 * write the attack straight into the document as text, which is exactly the
 * shape of the `<style>` and `<svg>` bypasses.
 */
const DROP_CONTENT = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'noscript', 'template',
  'svg', 'math', 'title', 'textarea', 'xmp', 'noembed', 'noframes',
  'frameset', 'frame', 'applet',
]);

/** Attributes carrying a URL, checked with `isSafeUrl` rather than by name. */
const URL_ATTRS = new Set(['href', 'src']);

const SAFE_SCHEMES = new Set(['http:', 'https:', 'mailto:', 'tel:']);

/**
 * Everything a browser removes from a URL before it resolves the scheme:
 * ASCII whitespace and the C0 control range, plus DEL. Written as explicit
 * escapes rather than literal characters, because a literal control byte in
 * a source file is invisible in review and one stray edit turns this into a
 * different class.
 */
const CONTROL_AND_SPACE = /[\u0000-\u0020\u007f]/g;

/** Newlines and tabs only — for CSS, where ordinary spaces are meaningful. */
const NEWLINES = /[\u0000-\u0009\u000b-\u001f\u007f]/g;

// ── Escaping ───────────────────────────────────────────────────────────────
//
// `&` is escaped only when it does NOT already begin a well-formed character
// reference. Escaping every `&` would be marginally simpler and wrong twice
// over: `Smith &amp; Jones` in a stored signature would render as the literal
// text "Smith &amp; Jones", and sanitising an already-sanitised string would
// grow it on every pass — so this function would not be idempotent, and a
// preview that sanitises what the writer already sanitised would corrupt it.
//
// It costs nothing in safety. A `&` cannot open a tag under any decoding, and
// the two characters that can — `<` and `>` — are escaped unconditionally
// below. Attribute values that MEAN something (URLs, styles) are validated
// against their fully decoded form before they reach here, so a preserved
// entity cannot smuggle a scheme past the check.
const BARE_AMP = /&(?!(?:#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]{1,31});)/g;

function escapeText(s: string): string {
  return s.replace(BARE_AMP, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(s: string): string {
  return s
    .replace(BARE_AMP, '&amp;')
    .replace(/"/g,  '&quot;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;');
}

// ── URL safety ─────────────────────────────────────────────────────────────

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'",
};

/**
 * Decode HTML character references the way a browser would before it looks
 * at a URL. Deliberately liberal — over-decoding can only make a hostile
 * value MORE recognisable, never less.
 */
function decodeEntities(s: string): string {
  return s.replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);?/g, (whole, body: string) => {
    if (body[0] === '#') {
      const hex  = body[1] === 'x' || body[1] === 'X';
      const code = parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
      try { return String.fromCodePoint(code); } catch { return whole; }
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named ?? whole;
  });
}

/**
 * Is this attribute value a URL we are willing to emit?
 *
 * Anchors and relative paths pass. Anything with a scheme must have one on
 * SAFE_SCHEMES — so `data:`, `blob:`, `javascript:` and `vbscript:` all fail,
 * including every encoded spelling of them, because the decode happens first.
 */
export function isSafeUrl(raw: string): boolean {
  // Browsers ignore leading/trailing whitespace and C0 controls, and strip
  // tabs, newlines and carriage returns from ANYWHERE in a URL before
  // resolving the scheme. `java&#10;script:` is the whole reason this line
  // exists.
  const decoded = decodeEntities(raw);
  const cleaned = decoded.replace(CONTROL_AND_SPACE, '');
  if (cleaned === '') return false;

  // Percent-encoding of the scheme itself — %6a%61%76… — resolved once more.
  let unescaped = cleaned;
  try {
    const once = decodeURIComponent(cleaned);
    unescaped = once.replace(CONTROL_AND_SPACE, '');
  } catch {
    // A malformed sequence is not a reason to accept the value; keep the
    // pre-decode form and let the scheme check below run on it.
  }

  for (const candidate of [cleaned, unescaped]) {
    if (candidate.startsWith('#') || candidate.startsWith('/')) continue;
    const colon = candidate.indexOf(':');
    if (colon === -1) continue;                       // relative, no scheme
    // A colon after the first `/` or `?` is inside a path or query, not a
    // scheme: "foo/bar:baz" is relative.
    const slash = candidate.indexOf('/');
    const query = candidate.indexOf('?');
    if (slash !== -1 && slash < colon) continue;
    if (query !== -1 && query < colon) continue;
    const scheme = candidate.slice(0, colon + 1).toLowerCase();
    if (!SAFE_SCHEMES.has(scheme)) return false;
  }
  return true;
}

/**
 * `style` is allowed because a signature is unstyled without it, and it is
 * the one attribute whose VALUE can still execute or exfiltrate. Blocked:
 * `expression()` (legacy IE), any `url(...)` (a background can beacon), and
 * anything containing a scheme-like construct.
 */
function safeStyle(raw: string): string | null {
  const decoded = decodeEntities(raw).replace(NEWLINES, '');
  if (/expression\s*\(/i.test(decoded)) return null;
  if (/url\s*\(/i.test(decoded))        return null;
  if (/(javascript|vbscript|data)\s*:/i.test(decoded)) return null;
  // Escapes like \6a\61… are how the above get smuggled past a text check.
  if (/\\[0-9a-fA-F]/.test(decoded))    return null;
  return decoded;
}

// ── The tokeniser ──────────────────────────────────────────────────────────

type Attr = { name: string; value: string | null };

type Token =
  | { t: 'text'; text: string }
  | { t: 'open'; name: string; attrs: Attr[]; selfClosing: boolean }
  | { t: 'close'; name: string };

const NAME_START = /[a-zA-Z]/;
const NAME_CHAR  = /[a-zA-Z0-9:_.-]/;

function tokenize(input: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  let text = '';

  const flushText = () => { if (text) { out.push({ t: 'text', text }); text = ''; } };

  while (i < input.length) {
    const ch = input[i];

    if (ch !== '<') { text += ch; i++; continue; }

    // ── Comment / declaration / processing instruction ────────────────
    if (input.startsWith('<!--', i)) {
      const end = input.indexOf('-->', i + 4);
      // An unterminated comment swallows the rest of the input, exactly as a
      // browser would — and dropping it is the safe reading either way.
      i = end === -1 ? input.length : end + 3;
      continue;
    }
    if (input[i + 1] === '!' || input[i + 1] === '?') {
      const end = input.indexOf('>', i + 1);
      i = end === -1 ? input.length : end + 1;
      continue;
    }

    // ── Closing tag ───────────────────────────────────────────────────
    if (input[i + 1] === '/') {
      let j = i + 2;
      let name = '';
      while (j < input.length && NAME_CHAR.test(input[j])) { name += input[j]; j++; }
      const gt = input.indexOf('>', j);
      if (gt === -1) { i = input.length; continue; }     // unterminated: drop
      if (name) { flushText(); out.push({ t: 'close', name: name.toLowerCase() }); }
      i = gt + 1;
      continue;
    }

    // ── Not a tag at all: a bare `<` in prose ─────────────────────────
    // `< 3` and `<-` are text to a browser too. Kept as text and escaped on
    // output, so it can never become markup later.
    if (!NAME_START.test(input[i + 1] ?? '')) { text += ch; i++; continue; }

    // ── Opening tag ───────────────────────────────────────────────────
    let j = i + 1;
    let name = '';
    while (j < input.length && NAME_CHAR.test(input[j])) { name += input[j]; j++; }

    const attrs: Attr[] = [];
    let selfClosing = false;
    let terminated  = false;

    while (j < input.length) {
      // Attribute separators. `/` is one of them, which is the entire
      // <img/onerror=…> bypass: the old filter required whitespace.
      while (j < input.length && /[\s/]/.test(input[j])) {
        if (input[j] === '/' && input[j + 1] === '>') break;
        j++;
      }
      if (j >= input.length) break;

      if (input[j] === '>') { terminated = true; j++; break; }
      if (input[j] === '/' && input[j + 1] === '>') {
        selfClosing = true; terminated = true; j += 2; break;
      }

      // Attribute name. Anything that is not a separator, `=` or `>`.
      let aName = '';
      while (j < input.length && !/[\s/>=]/.test(input[j])) { aName += input[j]; j++; }
      if (!aName) { j++; continue; }

      while (j < input.length && /\s/.test(input[j])) j++;

      let aValue: string | null = null;
      if (input[j] === '=') {
        j++;
        while (j < input.length && /\s/.test(input[j])) j++;
        const quote = input[j];
        if (quote === '"' || quote === "'") {
          j++;
          const end = input.indexOf(quote, j);
          if (end === -1) {
            // Unterminated quoted value. The rest of the input is inside an
            // attribute as far as the browser is concerned, so there is no
            // more markup to trust: stop, and let the tag be dropped below.
            j = input.length;
            break;
          }
          aValue = input.slice(j, end);
          j = end + 1;
        } else {
          let v = '';
          while (j < input.length && !/[\s>]/.test(input[j])) { v += input[j]; j++; }
          aValue = v;
        }
      }
      attrs.push({ name: aName.toLowerCase(), value: aValue });
    }

    if (!terminated) {
      // `<script src=x` with no `>` — the case that survived the old regex
      // verbatim and that the browser finishes for the attacker. Dropped,
      // along with everything after it, because nothing after an
      // unterminated tag can be read as trustworthy markup.
      flushText();
      return out;
    }

    flushText();
    out.push({ t: 'open', name: name.toLowerCase(), attrs, selfClosing });
    i = j;
  }

  flushText();
  return out;
}

// ── The serialiser ─────────────────────────────────────────────────────────

export type SanitizeOptions = {
  /** Extra tag names to allow, with their permitted attributes. */
  extraTags?: Record<string, string[]>;
  /**
   * What to put on every emitted `<a>`. Defaults to noopener/noreferrer,
   * because a signature preview renders inside the CRM.
   */
  linkRel?: string;
};

/**
 * Sanitise `input` to the allow-list above and return well-formed HTML.
 *
 * Total function: every input produces output, and no input produces markup
 * that was not explicitly permitted.
 */
export function sanitizeHtmlAllowList(input: string, opts: SanitizeOptions = {}): string {
  if (!input) return '';

  const allowed: Record<string, Set<string>> = { ...ALLOWED };
  for (const [tag, attrs] of Object.entries(opts.extraTags ?? {})) {
    allowed[tag.toLowerCase()] = new Set(attrs.map((a) => a.toLowerCase()));
  }
  const linkRel = opts.linkRel ?? 'noopener noreferrer';

  const tokens = tokenize(input);
  const out: string[] = [];
  /** Emitted, still-open elements, innermost last. */
  const open: string[] = [];
  /**
   * Depth inside a drop-content element. While non-zero everything —
   * text and tags alike — is discarded.
   */
  let dropping = 0;
  let dropName = '';

  for (const tok of tokens) {
    if (dropping > 0) {
      if (tok.t === 'open' && tok.name === dropName && !tok.selfClosing) dropping++;
      else if (tok.t === 'close' && tok.name === dropName) dropping--;
      continue;
    }

    if (tok.t === 'text') { out.push(escapeText(tok.text)); continue; }

    if (tok.t === 'close') {
      // Only close something we actually opened, and unwind anything left
      // dangling inside it — otherwise a stray `</div>` could close a
      // wrapper the caller put around this output.
      const idx = open.lastIndexOf(tok.name);
      if (idx === -1) continue;
      while (open.length > idx) out.push(`</${open.pop()}>`);
      continue;
    }

    // open
    if (DROP_CONTENT.has(tok.name)) {
      if (!tok.selfClosing) { dropping = 1; dropName = tok.name; }
      continue;
    }

    const attrAllow = allowed[tok.name];
    if (!attrAllow) continue;      // unwrapped: children survive, tag does not

    const rendered: string[] = [];
    for (const attr of tok.attrs) {
      // `on*` is refused as a CLASS rather than matched as a pattern, and it
      // is refused for every element including ones nobody thought about.
      // The old filter's `\s+on[a-z]+=` needed a space in front of it.
      if (attr.name.startsWith('on')) continue;
      if (!attrAllow.has(attr.name) && !GLOBAL_ATTRS.has(attr.name)) continue;

      const value = attr.value ?? '';
      if (URL_ATTRS.has(attr.name)) {
        if (!isSafeUrl(value)) continue;
      } else if (attr.name === 'style') {
        const safe = safeStyle(value);
        if (safe === null) continue;
        rendered.push(`style="${escapeAttr(safe)}"`);
        continue;
      } else if (attr.name === 'target') {
        // A signature has no business steering the current tab.
        if (value !== '_blank') continue;
      }
      rendered.push(attr.value === null ? attr.name : `${attr.name}="${escapeAttr(value)}"`);
    }

    if (tok.name === 'a' && !rendered.some((a) => a.startsWith('rel='))) {
      rendered.push(`rel="${escapeAttr(linkRel)}"`);
    }

    const attrText = rendered.length ? ` ${rendered.join(' ')}` : '';
    if (VOID.has(tok.name)) { out.push(`<${tok.name}${attrText}>`); continue; }

    out.push(`<${tok.name}${attrText}>`);
    if (!tok.selfClosing) open.push(tok.name);
    else out.push(`</${tok.name}>`);
  }

  while (open.length) out.push(`</${open.pop()}>`);
  return out.join('').trim();
}
