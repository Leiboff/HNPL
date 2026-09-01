// ─── CLOSURE — audit 2026-09-02, finding A-08 ─────────────────────────────
//
// `sanitizeSignatureHtml` WAS a regex blocklist: a list of bad tags, a list
// of `on*=` attribute shapes, and a `javascript:`-in-href replacement. Its
// output is fed to `dangerouslySetInnerHTML` in two places
// (app/crm/settings/SignatureEditor.tsx, app/crm/leads/[id]/ComposeEmailSheet.tsx)
// and shipped in outbound email.
//
// Five bypasses were confirmed against it. This file was the proof of them
// and is now their closure — the payloads stay, the assertions are inverted,
// and each one still explains the trick it uses, because the reason a
// blocklist failed is more useful to a future reader than the fact that it
// did.
//
// ─── WHAT REPLACED IT ─────────────────────────────────────────────────────
//
// lib/html/sanitizeAllowList.ts: a tokeniser that parses the input and then
// SERIALISES a fresh document from what it understood. The original note on
// this file said "replace it with a parser-based allow-list (DOMPurify, or
// sanitize-html …) and delete the regexes", and the parser part is exactly
// what happened — but hand-written rather than imported, because this
// function runs in a Server Action, in a server-rendered preview AND in a
// client component's dangerouslySetInnerHTML. DOMPurify needs a DOM, so the
// server paths would need jsdom in the request path, and the two
// environments would then be running different sanitisers. See that file's
// header.
//
// The property worth stating plainly: these five payloads are not blocked by
// five new rules. They are blocked because nothing reaches the output that
// the tokeniser did not first understand and the allow-list did not then
// permit — so an input it does not understand yields LESS output rather than
// unfiltered output. A sixth trick nobody has thought of is a parse failure,
// not a bypass.

import { describe, it, expect } from 'vitest';
import { sanitizeSignatureHtml } from './signature';

describe('A-08 CLOSED — the five confirmed bypasses', () => {
  it('still does what it says on the obvious payloads', () => {
    expect(sanitizeSignatureHtml('<script>alert(1)</script>hi')).toBe('hi');
    expect(sanitizeSignatureHtml('<img src=x onerror="alert(1)">'))
      .not.toContain('onerror');
    expect(sanitizeSignatureHtml('<a href="javascript:alert(1)">x</a>'))
      .not.toContain('javascript:');
  });

  it('BYPASS 1 CLOSED — a slash-separated event handler', () => {
    // `/` separates attributes in HTML but is not `\s`, so the old
    // `\s+on[a-z]+` patterns never matched it. The tokeniser treats `/` as
    // the separator it is, and then refuses `on*` as a CLASS of attribute
    // name rather than matching a pattern around it.
    const out = sanitizeSignatureHtml('<img/onerror=alert(document.domain) src=x>');
    expect(out).not.toContain('onerror');
    expect(out).not.toContain('alert(document.domain)');
    // The safe part of the tag survives, which is the point of an allow-list
    // over a "reject the whole input" filter.
    expect(out).toBe('<img src="x">');
  });

  it('BYPASS 1b CLOSED — the same trick on an SVG', () => {
    // `svg` was not in the old tag list at all. It is not in the allow-list
    // either — but the difference is that now that means "dropped", and its
    // CONTENT is dropped with it, rather than "not mentioned, so kept".
    expect(sanitizeSignatureHtml('<svg/onload=alert(1)>')).toBe('');
    expect(sanitizeSignatureHtml('<svg><script>alert(1)</script></svg>')).toBe('');
  });

  it('BYPASS 2 CLOSED — an entity-encoded scheme', () => {
    // The old filter saw the literal text "j&#97;vascript:" and left it
    // alone; the browser's parser decodes the entity when it builds the
    // attribute value, and the resulting URL is javascript:alert(1). The
    // fix is ORDER: decode first, then check the scheme, which is the order
    // the browser resolves them in.
    const out = sanitizeSignatureHtml('<a href="j&#97;vascript:alert(1)">click</a>');
    expect(out).not.toContain('vascript');
    expect(out).not.toContain('href');
    // The link text is kept — the anchor is emitted without its href rather
    // than the whole element being thrown away.
    expect(out).toContain('click');
  });

  it('BYPASS 3 CLOSED — a control character inside the scheme', () => {
    // Browsers strip whitespace and C0 controls from a URL before matching
    // the scheme. The sanitiser now does the same, before it looks.
    for (const payload of [
      '<a href="java\nscript:alert(1)">click</a>',
      '<a href="java\tscript:alert(1)">click</a>',
      '<a href="java&#10;script:alert(1)">click</a>',
      '<a href="  javascript:alert(1)">click</a>',
      '<a href="JaVaScRiPt:alert(1)">click</a>',
    ]) {
      expect(sanitizeSignatureHtml(payload)).not.toContain('href');
    }
  });

  it('BYPASS 4 CLOSED — an unterminated tag', () => {
    // The old paired pattern needed a closing tag and the self-closing
    // pattern needed a `>`; an unterminated `<script` matched neither and
    // passed through verbatim, and browsers recover from it by opening the
    // element anyway.
    //
    // Now an unterminated tag ends the parse: nothing after it can be read
    // as trustworthy markup, so nothing after it is emitted.
    expect(sanitizeSignatureHtml('<script src="//evil.example/x.js"')).toBe('');
    expect(sanitizeSignatureHtml('safe<script src="//evil')).toBe('safe');
    expect(sanitizeSignatureHtml('<img src=x onerror=alert(1)')).toBe('');
  });
});

describe('A-08 — the class, not just the five', () => {
  // The five above were what one afternoon of trying produced. These are the
  // rest of the standard repertoire, asserted here because the claim being
  // made is about the KIND of defence, and a claim like that should be
  // exposed to more than the payloads that motivated it.

  it.each([
    ['data: URL',              '<a href="data:text/html,<script>alert(1)</script>">x</a>'],
    ['vbscript:',              '<a href="vbscript:msgbox(1)">x</a>'],
    ['percent-encoded scheme', '<a href="%6a%61%76%61%73%63%72%69%70%74:alert(1)">x</a>'],
    ['blob:',                  '<a href="blob:https://evil.example/x">x</a>'],
    ['form action',            '<form action="//evil"><input name=x><button>go</button></form>'],
    ['base href',              '<base href="//evil">'],
    ['meta refresh',           '<meta http-equiv="refresh" content="0;//evil">'],
    ['link stylesheet',        '<link rel="stylesheet" href="//evil">'],
    ['object data',            '<object data="//evil"></object>'],
    ['iframe srcdoc',          '<iframe srcdoc="<script>alert(1)</script>"></iframe>'],
    ['style url()',            '<div style="background:url(//evil/beacon.gif)">x</div>'],
    ['style expression()',     '<div style="width:expression(alert(1))">x</div>'],
    ['CSS escape',             '<div style="background:\\75 rl(//evil)">x</div>'],
    ['comment-hidden tag',     '<!--><script>alert(1)</script>-->'],
    ['nested handler',         '<b><i onmouseover=alert(1)>x</i></b>'],
    ['uppercase handler',      '<img SRC=x ONERROR=alert(1)>'],
    ['handler, no value',      '<img src=x onerror>'],
    ['target hijack',          '<a href="https://ok.example" target="_self">x</a>'],
    ['unquoted javascript',    '<a href=javascript:alert(1)>x</a>'],
    ['srcset',                 '<img srcset="//evil 1x" src="//evil">'],
  ])('%s cannot get anything executable through', (_label, payload) => {
    const out = sanitizeSignatureHtml(payload);
    for (const forbidden of [
      'javascript', 'vbscript', 'data:', 'blob:', 'expression(', 'url(',
      '<script', '<iframe', '<object', '<form', '<base', '<meta', '<link',
      'srcdoc', 'srcset', '_self', 'alert(1)',
    ]) {
      expect(out.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
    // No attribute beginning `on` survives anywhere, whatever the element.
    expect(out).not.toMatch(/\son[a-z]+/i);
  });

  it('the output can always be re-sanitised to itself', () => {
    // Idempotence is the cheap check that the serialiser is not producing
    // something its own parser reads differently — the failure mode where
    // one pass yields safe-looking text that a second pass (or a browser)
    // resolves back into markup.
    for (const payload of [
      '<b>bold</b> &amp; <i>italic</i>',
      '<img/onerror=alert(1) src=x>',
      '<a href="j&#97;vascript:alert(1)">click</a>',
      '<div style="color:red">hi</div>',
      '5 < 6 and 7 > 2',
      '<script src="//evil',
    ]) {
      const once  = sanitizeSignatureHtml(payload);
      const twice = sanitizeSignatureHtml(once);
      expect(twice).toBe(once);
    }
  });

  it('and a real signature still comes through intact', () => {
    // The other half of the requirement. A sanitiser that ate signatures
    // would be replaced within a week by one that did not.
    const real =
      '<table role="presentation" cellpadding="0" cellspacing="0" border="0" '
      + 'style="font-family:Arial,sans-serif;color:#13294B;font-size:13px">'
      + '<tr><td valign="top" style="border-right:2px solid #15A89E;padding-right:16px">'
      + '<div style="font-weight:700"><span style="color:#13294B">better</span>'
      + '<span style="color:#15A89E">now</span></div></td>'
      + '<td valign="top" style="padding-left:16px">'
      + '<div style="font-weight:600">Dina Leiboff</div>'
      + '<div>Founder</div>'
      + '<div><a href="tel:+27821234567" style="color:#13294B">+27 82 123 4567</a></div>'
      + '<div><a href="mailto:dina@example.co.za" style="color:#13294B">dina@example.co.za</a></div>'
      + '<div><a href="https://betternow.co.za" style="color:#13294B">betternow.co.za</a></div>'
      + '</td></tr></table>';
    const out = sanitizeSignatureHtml(real);

    expect(out).toContain('Dina Leiboff');
    expect(out).toContain('href="tel:+27821234567"');
    expect(out).toContain('href="mailto:dina@example.co.za"');
    expect(out).toContain('href="https://betternow.co.za"');
    expect(out).toContain('border-right:2px solid #15A89E');
    expect(out).toContain('<table');
    expect(out).toContain('valign="top"');
    expect(out).toContain('role="presentation"');
  });
});
