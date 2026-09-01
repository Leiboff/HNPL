import { describe, it, expect } from 'vitest';
import { sanitizeHtmlAllowList, isSafeUrl } from './sanitizeAllowList';

// ─── The sanitiser's own contract ─────────────────────────────────────────
//
// The five bypasses that motivated this file, and the wider payload
// repertoire, live in lib/gmail/signature.sanitizer-bypass.adversarial.test.ts
// — they belong with the function they were found against. This file is the
// contract of the sanitiser itself: what it emits, what it drops, what it
// unwraps, and the two properties that make it a different kind of defence
// from the regex blocklist it replaced.
//
//   TOTALITY      every input produces output. There is no input that makes
//                 it throw, hang, or return the input unfiltered.
//   WELL-FORMEDNESS  the output parses to the tree the sanitiser intended.
//                 Unclosed elements are closed and a stray closing tag is
//                 discarded — so this output can be interpolated into a
//                 wrapper without being able to break out of it.
//
// Those two together are what "parse, then serialise" buys over "delete from
// a string", and they are why an unfamiliar input yields LESS output rather
// than unfiltered output.

const s = (input: string) => sanitizeHtmlAllowList(input);

describe('what it keeps', () => {
  it('formatting tags a signature is made of', () => {
    expect(s('<b>b</b><i>i</i><u>u</u><em>e</em><strong>s</strong>'))
      .toBe('<b>b</b><i>i</i><u>u</u><em>e</em><strong>s</strong>');
  });

  it('a table layout, which is how every email signature is built', () => {
    const html = '<table role="presentation" cellpadding="0" border="0">'
      + '<tr><td valign="top" width="120">a</td><td align="left">b</td></tr></table>';
    expect(s(html)).toBe(html);
  });

  it('inline styles, without which a signature is unstyled text', () => {
    expect(s('<div style="color:#13294B;font-weight:600">x</div>'))
      .toBe('<div style="color:#13294B;font-weight:600">x</div>');
  });

  it('http, https, mailto and tel links', () => {
    for (const href of [
      'https://betternow.co.za', 'http://betternow.co.za',
      'mailto:dina@example.co.za', 'tel:+27821234567',
    ]) {
      expect(s(`<a href="${href}">x</a>`)).toContain(`href="${href}"`);
    }
  });

  it('relative and anchor hrefs', () => {
    expect(s('<a href="/about">x</a>')).toContain('href="/about"');
    expect(s('<a href="#top">x</a>')).toContain('href="#top"');
    // A colon after a slash is a path, not a scheme.
    expect(s('<a href="docs/a:b">x</a>')).toContain('href="docs/a:b"');
  });

  it('void elements, emitted without a closing tag', () => {
    expect(s('a<br>b<hr>')).toBe('a<br>b<hr>');
    expect(s('<img src="https://x.example/l.png" alt="Logo" width="120">'))
      .toBe('<img src="https://x.example/l.png" alt="Logo" width="120">');
  });

  it('a character reference already in the input, unchanged', () => {
    // Escaping it again would render "Smith &amp; Jones" as literal text and
    // would make this function non-idempotent.
    expect(s('Smith &amp; Jones')).toBe('Smith &amp; Jones');
    expect(s('caf&eacute;')).toBe('caf&eacute;');
    // A bare ampersand IS escaped.
    expect(s('Smith & Jones')).toBe('Smith &amp; Jones');
  });
});

describe('what it drops, content and all', () => {
  it.each([
    ['script',   '<script>alert(1)</script>'],
    ['style',    '<style>body{background:url(//evil)}</style>'],
    ['iframe',   '<iframe src="//evil"></iframe>'],
    ['object',   '<object data="//evil"></object>'],
    ['svg',      '<svg><circle onload="alert(1)"/></svg>'],
    ['math',     '<math><mtext></mtext></math>'],
    ['template', '<template><img src=x onerror=alert(1)></template>'],
    ['noscript', '<noscript><img src=x onerror=alert(1)></noscript>'],
  ])('%s — the tag AND its body', (_name, payload) => {
    expect(s(`before${payload}after`)).toBe('beforeafter');
  });

  it('nested instances of the same dropped element', () => {
    // The depth counter matters: a naive "skip until the next closing tag"
    // would resume emitting inside the outer element.
    expect(s('<style>a<style>b</style>c</style>keep')).toBe('keep');
  });

  it('comments, including ones hiding a tag', () => {
    expect(s('a<!-- <script>alert(1)</script> -->b')).toBe('ab');
    // An unterminated comment swallows the rest, exactly as a browser does.
    expect(s('a<!-- b')).toBe('a');
  });

  it('doctypes and processing instructions', () => {
    expect(s('<!DOCTYPE html>hi')).toBe('hi');
    expect(s('<?xml version="1.0"?>hi')).toBe('hi');
  });
});

describe('what it unwraps, keeping the text', () => {
  it('a tag nobody allow-listed but nothing dangerous either', () => {
    // The friendly answer. A signature that loses its text to one
    // unsupported wrapper is a bad outcome, and `marquee` cannot execute
    // anything.
    expect(s('<marquee>hello</marquee>')).toBe('hello');
    expect(s('<h1>Title</h1>')).toBe('Title');
    expect(s('<custom-element>text</custom-element>')).toBe('text');
  });

  it('but an unwrapped tag takes its attributes with it', () => {
    expect(s('<marquee onstart="alert(1)">hi</marquee>')).toBe('hi');
  });
});

describe('attributes', () => {
  it('drops every on* handler, on every element, quoted or not', () => {
    // Refused as a CLASS of attribute name rather than matched with a
    // pattern that needs whitespace in front of it.
    for (const payload of [
      '<div onclick="alert(1)">x</div>',
      "<div onclick='alert(1)'>x</div>",
      '<div onclick=alert(1)>x</div>',
      '<div ONCLICK=alert(1)>x</div>',
      '<div/onclick=alert(1)>x</div>',
      '<div onclick>x</div>',
      '<div onfoobarbaz=alert(1)>x</div>',
    ]) {
      expect(s(payload)).toBe('<div>x</div>');
    }
  });

  it('drops an attribute not on the element\'s own list', () => {
    // `href` is fine on `a` and meaningless on `div`; per-element lists mean
    // a future allow-listed element cannot inherit somebody else's surface.
    expect(s('<div href="https://x.example">x</div>')).toBe('<div>x</div>');
    expect(s('<img src="https://x.example/a.png" srcset="//evil 1x">'))
      .toBe('<img src="https://x.example/a.png">');
  });

  it('adds rel=noopener noreferrer to every emitted link', () => {
    // The preview renders inside the CRM, so a target=_blank link would
    // otherwise get a handle on the opener.
    expect(s('<a href="https://x.example">x</a>'))
      .toBe('<a href="https://x.example" rel="noopener noreferrer">x</a>');
  });

  it('respects an author-supplied rel rather than duplicating it', () => {
    expect(s('<a href="https://x.example" rel="nofollow">x</a>'))
      .toBe('<a href="https://x.example" rel="nofollow">x</a>');
  });

  it('allows target=_blank and nothing else', () => {
    expect(s('<a href="https://x.example" target="_blank">x</a>')).toContain('target="_blank"');
    // _self / _parent / _top would let a signature steer the tab it is
    // previewed in.
    for (const t of ['_self', '_parent', '_top', 'someframe']) {
      expect(s(`<a href="https://x.example" target="${t}">x</a>`)).not.toContain('target');
    }
  });

  it('escapes quotes in a value it does keep', () => {
    expect(s('<img src="https://x.example/a.png" alt=\'He said "hi"\'>'))
      .toContain('alt="He said &quot;hi&quot;"');
  });
});

describe('style values', () => {
  it('drops url(), which is how a signature becomes a tracking beacon', () => {
    expect(s('<div style="background:url(//evil/b.gif)">x</div>')).toBe('<div>x</div>');
    expect(s('<div style="background : URL( //evil )">x</div>')).toBe('<div>x</div>');
  });

  it('drops expression()', () => {
    expect(s('<div style="width:expression(alert(1))">x</div>')).toBe('<div>x</div>');
  });

  it('drops a CSS escape sequence, which is how the above get smuggled', () => {
    expect(s('<div style="background:\\75 rl(//evil)">x</div>')).toBe('<div>x</div>');
  });

  it('drops a scheme inside a style value', () => {
    expect(s('<div style="x:javascript:alert(1)">x</div>')).toBe('<div>x</div>');
  });

  it('but keeps the styling a signature is built from', () => {
    const style = 'font-family:Arial,sans-serif;color:#13294B;border-right:2px solid #15A89E';
    expect(s(`<td style="${style}">x</td>`)).toBe(`<td style="${style}">x</td>`);
  });
});

describe('isSafeUrl', () => {
  it.each([
    'https://x.example', 'http://x.example', 'mailto:a@b.co', 'tel:+27821234567',
    '/relative', '#anchor', 'relative/path', 'a/b:c',
  ])('accepts %s', (u) => expect(isSafeUrl(u)).toBe(true));

  it.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    '  javascript:alert(1)',
    'java\nscript:alert(1)',
    'java\tscript:alert(1)',
    'java&#10;script:alert(1)',
    'j&#97;vascript:alert(1)',
    'j&#x61;vascript:alert(1)',
    'vbscript:msgbox(1)',
    'data:text/html,<script>alert(1)</script>',
    'blob:https://evil.example/x',
    'file:///etc/passwd',
    '%6a%61%76%61%73%63%72%69%70%74:alert(1)',
    '',
  ])('refuses %s', (u) => expect(isSafeUrl(u)).toBe(false));
});

describe('well-formedness — the output cannot break out of its wrapper', () => {
  it('closes what the input left open', () => {
    expect(s('<div><b>text')).toBe('<div><b>text</b></div>');
  });

  it('discards a closing tag for something never opened', () => {
    // The property that matters when this output is interpolated into a
    // page: a stray `</div>` must not close the caller's wrapper.
    expect(s('</div>text')).toBe('text');
    expect(s('text</table></td>')).toBe('text');
  });

  it('unwinds correctly through mis-nesting', () => {
    expect(s('<div><b>a</div>b')).toBe('<div><b>a</b></div>b');
  });

  it('self-closing syntax on a non-void element emits a matched pair', () => {
    expect(s('<div/>after')).toBe('<div></div>after');
  });
});

describe('totality — nothing makes it throw or pass input through', () => {
  it.each([
    ['empty',                 ''],
    ['plain text',            'just words'],
    ['a bare less-than',      '5 < 6'],
    ['a bare greater-than',   '7 > 2'],
    ['a lone angle bracket',  '<'],
    ['a lone slash-bracket',  '</'],
    ['garbage',               '<<<>>><<'],
    ['unterminated tag',      '<div class="x'],
    ['unterminated quote',    '<a href="https://x'],
    ['a very deep nest',      '<div>'.repeat(500) + 'x'],
    ['null byte',             'a b'],
    ['an emoji',              '👋 hello'],
    ['a tag-like word',       '<3 you'],
  ])('%s', (_label, input) => {
    expect(() => s(input)).not.toThrow();
    const out = s(input);
    // Whatever comes out, it contains no unescaped angle bracket that is not
    // part of a tag the sanitiser itself emitted.
    expect(out).not.toMatch(/<(?![/a-zA-Z])/);
  });

  it('is idempotent on every one of those', () => {
    // The cheap check that the serialiser is not producing something its own
    // parser reads differently — the failure mode where one pass yields
    // safe-looking text that a second pass resolves back into markup.
    for (const input of [
      '', 'just words', '5 < 6', '<div class="x', '<a href="https://x',
      '<b>bold</b> &amp; <i>italic</i>', '<div/onclick=alert(1)>x</div>',
      '<svg/onload=alert(1)>', '👋 <b>hi</b>',
    ]) {
      const once = s(input);
      expect(s(once)).toBe(once);
    }
  });

  it('an unterminated tag ends the parse rather than leaking', () => {
    // The fifth bypass, at the level of the sanitiser rather than the
    // signature wrapper: nothing after an unterminated tag can be read as
    // trustworthy markup, so nothing after it is emitted.
    expect(s('keep<script src="//evil')).toBe('keep');
    expect(s('keep<div class="x')).toBe('keep');
  });
});

describe('extensibility, without widening the default', () => {
  it('extraTags adds a tag for one caller only', () => {
    expect(s('<h2>Heading</h2>')).toBe('Heading');
    expect(sanitizeHtmlAllowList('<h2 class="x">Heading</h2>', { extraTags: { h2: ['class'] } }))
      .toBe('<h2 class="x">Heading</h2>');
  });

  it('an extra tag still gets the on* refusal and the URL check', () => {
    // Opting a tag in must not opt it out of the value rules — that would
    // make every future extension a place to reintroduce the finding.
    expect(sanitizeHtmlAllowList('<h2 onclick="alert(1)">x</h2>', { extraTags: { h2: ['onclick'] } }))
      .toBe('<h2>x</h2>');
    expect(sanitizeHtmlAllowList('<h2 href="javascript:alert(1)">x</h2>', { extraTags: { h2: ['href'] } }))
      .toBe('<h2>x</h2>');
  });

  it('extraTags cannot re-enable a drop-content element', () => {
    // `script` is refused before the allow-list is consulted at all, so no
    // caller can configure its way back to executable HTML.
    expect(sanitizeHtmlAllowList('<script>alert(1)</script>', { extraTags: { script: ['src'] } }))
      .toBe('');
  });
});
