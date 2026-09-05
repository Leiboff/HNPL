import { describe, it, expect } from 'vitest';
import {
  sanitizeSignatureHtml,
  applySignatureMergeFields,
  renderSignatureOverride,
  renderBrandSignatureHtml,
  renderBrandSignatureText,
  composeWithSignature,
  escapeHtml,
} from './signature';

// ─── Signature sanitiser + brand template — behavioural ──────────

describe('sanitizeSignatureHtml', () => {
  it('strips <script>…</script> pairs including their content', () => {
    const html = 'Hi <script>alert(1)</script> there';
    const out = sanitizeSignatureHtml(html);
    expect(out).not.toContain('<script');
    expect(out).not.toContain('alert(1)');
  });

  it('strips self-closing / broken <script> variants', () => {
    const html = 'Hi <script src="//evil" /> there';
    const out = sanitizeSignatureHtml(html);
    expect(out).not.toContain('<script');
    expect(out).not.toContain('evil');
  });

  it('strips <iframe>, <object>, <embed>, <link>, <meta>, <style>, <base>, <form>', () => {
    const html = `
      <iframe src="//evil"></iframe>
      <object data="//evil"></object>
      <embed src="//evil">
      <link rel="stylesheet" href="//evil">
      <meta http-equiv="refresh" content="0;//evil">
      <style>body{background:url(//evil)}</style>
      <base href="//evil">
      <form action="//evil"><input name="x"><button>go</button></form>
    `;
    const out = sanitizeSignatureHtml(html);
    for (const bad of ['iframe', 'object', 'embed', 'link', 'meta', 'style', 'base', 'form', 'input', 'button']) {
      expect(out.toLowerCase()).not.toContain(`<${bad}`);
    }
    expect(out).not.toContain('evil');
  });

  it('strips event-handler attributes (onclick, onerror, onload, onmouseover)', () => {
    const html = '<a href="/" onclick="alert(1)" onerror="alert(2)" onload=\'x()\' onmouseover=x>hi</a>';
    const out = sanitizeSignatureHtml(html);
    expect(out).not.toMatch(/on[a-z]+\s*=/i);
    expect(out).toContain('href');
    expect(out).toContain('hi');
  });

  it('neutralises javascript:/vbscript:/data: URLs on href, src, action', () => {
    const inputs = [
      '<a href="javascript:alert(1)">x</a>',
      '<a href="JAVASCRIPT:alert(1)">x</a>',
      '<a href="vbscript:bad()">x</a>',
      '<a href="data:text/html,x">x</a>',
      '<img src="javascript:alert(1)">',
      '<form action="javascript:go()"><input></form>',
    ];
    for (const html of inputs) {
      const out = sanitizeSignatureHtml(html);
      expect(out.toLowerCase()).not.toContain('javascript:');
      expect(out.toLowerCase()).not.toContain('vbscript:');
      expect(out.toLowerCase()).not.toContain('data:text');
    }
  });

  it('keeps safe formatting HTML (b/i/u/strong/em/table/img)', () => {
    const html = '<b>Alice</b> · <a href="https://betternow.co.za">web</a> <img src="https://cdn/x.png" alt="logo">';
    const out = sanitizeSignatureHtml(html);
    expect(out).toContain('<b>Alice</b>');
    expect(out).toContain('href="https://betternow.co.za"');
    expect(out).toContain('<img');
  });

  it('empty input → empty output (no error)', () => {
    expect(sanitizeSignatureHtml('')).toBe('');
  });
});

describe('applySignatureMergeFields', () => {
  it('substitutes display_name, title, phone, email and HTML-escapes the values', () => {
    const tmpl = 'Hi {{display_name}} — {{title}} · {{phone}} · {{email}}';
    const out = applySignatureMergeFields(tmpl, {
      displayName: '<Alice>',
      title:       'Sales & Ops',
      phone:       '+27 82 111 2222',
      email:       'a@b.co',
    });
    expect(out).toContain('&lt;Alice&gt;');
    expect(out).toContain('Sales &amp; Ops');
    expect(out).toContain('+27 82 111 2222');
    expect(out).toContain('a@b.co');
    // Raw brackets from the template have been consumed.
    expect(out).not.toContain('{{display_name}}');
  });
});

describe('renderSignatureOverride — final sanitization after merge', () => {
  const base = { displayName: '', title: '', phone: '', email: '' };

  it.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'java\nscript:alert(1)',
    '%6a%61%76%61%73%63%72%69%70%74:alert(1)',
    'vbscript:msgbox(1)',
    'data:text/html,<script>alert(1)</script>',
  ])('removes an href completed by the unsafe merge value %s', (email) => {
    const out = renderSignatureOverride(
      '<div><a href="{{email}}">Email me</a></div>',
      { ...base, email },
    );
    expect(out).toContain('Email me');
    expect(out).not.toMatch(/href\s*=/i);
    expect(out).not.toMatch(/javascript:|vbscript:|data:text\/html/i);
  });

  it('keeps escaping as the first layer and sanitizes the completed document', () => {
    const out = renderSignatureOverride(
      '<a href="https://example.com/?name={{display_name}}">{{display_name}}</a>',
      { ...base, displayName: '\"><img src=x onerror=alert(1)>' },
    );
    expect(out).not.toContain('<img');
    expect(out).not.toContain('"><img');
    expect(out).toContain('&lt;img');
  });

  it('preserves an allowed completed URL', () => {
    const out = renderSignatureOverride(
      '<a href="mailto:{{email}}">{{email}}</a>',
      { ...base, email: 'hello@betternow.co.za' },
    );
    expect(out).toContain('href="mailto:hello@betternow.co.za"');
  });
});

describe('renderBrandSignatureHtml + Text', () => {
  it('HTML uses the betternow wordmark colours (#13294B + #15A89E)', () => {
    const html = renderBrandSignatureHtml({
      displayName: 'Alice', title: 'BD', phone: '+27 82 111 2222', email: 'a@b.co',
    });
    expect(html).toContain('#13294B');
    expect(html).toContain('#15A89E');
    expect(html).toContain('better');
    expect(html).toContain('now');
    expect(html).toContain('Alice');
  });

  it('text fallback lists P./E./W. lines', () => {
    const txt = renderBrandSignatureText({
      displayName: 'Alice', title: 'BD', phone: '+27 82 111 2222', email: 'a@b.co',
    });
    expect(txt).toContain('betternow');
    expect(txt).toContain('P. +27 82 111 2222');
    expect(txt).toContain('E. a@b.co');
    expect(txt).toContain('W. betternow.co.za');
  });

  it('gracefully renders when structured fields are empty', () => {
    const html = renderBrandSignatureHtml({ displayName: '', title: '', phone: '', email: '' });
    // No "undefined" or "null" spam.
    expect(html).not.toMatch(/undefined|null/i);
    // Wordmark still there.
    expect(html).toContain('better');
  });
});

describe('composeWithSignature', () => {
  it('appends signature HTML + text when omit=false', () => {
    const composed = composeWithSignature({
      bodyText:      'Hi Alice\nfollow-up',
      signatureHtml: '<div>sig-html</div>',
      signatureText: '-- sig-text',
      omitSignature: false,
    });
    expect(composed.bodyHtml).toContain('sig-html');
    expect(composed.bodyHtml).toContain('Hi Alice');
    expect(composed.bodyText).toContain('sig-text');
    expect(composed.bodyText).toContain('Hi Alice');
  });

  it('leaves body untouched (bodyHtml empty) when omit=true', () => {
    const composed = composeWithSignature({
      bodyText:      'Hi Alice',
      signatureHtml: '<div>sig-html</div>',
      signatureText: '-- sig-text',
      omitSignature: true,
    });
    expect(composed.bodyHtml).toBe('');
    expect(composed.bodyText).toBe('Hi Alice');
  });

  it('escapes HTML entities in the body when composing HTML', () => {
    const composed = composeWithSignature({
      bodyText:      'Alice & <Bob> — 5<10',
      signatureHtml: '',
      signatureText: '',
      omitSignature: false,
    });
    expect(composed.bodyHtml).toContain('Alice &amp; &lt;Bob&gt;');
  });
});

describe('escapeHtml', () => {
  it('handles &, <, >, ", \'', () => {
    expect(escapeHtml(`<a href="x" onclick='y'>&`)).toBe(
      '&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;',
    );
  });
});
