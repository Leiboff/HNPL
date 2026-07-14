import { describe, it, expect } from 'vitest';
import {
  sanitizeSignatureHtml,
  applySignatureMergeFields,
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
