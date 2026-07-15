import { describe, it, expect } from 'vitest';
import { decodeHtmlEntities, htmlToText, chooseIngestBody } from './extractBody';

describe('decodeHtmlEntities', () => {
  it('decodes named entities Gmail actually emits', () => {
    expect(decodeHtmlEntities('a &amp; b')).toBe('a & b');
    expect(decodeHtmlEntities('&lt;/tag&gt;')).toBe('</tag>');
    expect(decodeHtmlEntities('&quot;quoted&quot;')).toBe('"quoted"');
    expect(decodeHtmlEntities('&nbsp;')).toBe(' ');
    expect(decodeHtmlEntities('R&amp;D &ndash; &mdash;')).toBe('R&D – —');
  });

  it('decodes numeric decimal and hex entities', () => {
    expect(decodeHtmlEntities('&#8211;')).toBe('–');
    expect(decodeHtmlEntities('&#x2014;')).toBe('—');
  });

  it('leaves unknown entities as empty (defensive)', () => {
    expect(decodeHtmlEntities('&foo;')).toBe('&foo;');
  });

  it('empty input passes through', () => {
    expect(decodeHtmlEntities('')).toBe('');
  });
});

describe('htmlToText', () => {
  it('strips tags but preserves paragraph breaks', () => {
    const html = '<p>First paragraph.</p><p>Second paragraph.</p>';
    const text = htmlToText(html);
    expect(text).toContain('First paragraph.');
    expect(text).toContain('Second paragraph.');
    expect(text).toContain('\n');
  });

  it('turns <br> into newlines', () => {
    expect(htmlToText('line 1<br>line 2')).toContain('line 1\nline 2');
  });

  it('drops <script> and <style> contents wholesale', () => {
    const html = '<p>Hi</p><script>alert(1)</script><style>body{}</style>';
    const text = htmlToText(html);
    expect(text).not.toContain('alert(1)');
    expect(text).not.toContain('body{}');
    expect(text).toContain('Hi');
  });

  it('decodes entities AFTER tags are stripped', () => {
    const html = '<p>a &amp; b &lt;c&gt;</p>';
    expect(htmlToText(html)).toBe('a & b <c>');
  });

  it('collapses excessive blank lines to a paragraph break', () => {
    const html = '<p>a</p><p></p><p></p><p></p><p>b</p>';
    expect(htmlToText(html)).toBe('a\n\nb');
  });
});

describe('chooseIngestBody — plain preferred, html fallback, snippet last', () => {
  it('prefers plain text (decodes any stray entities)', () => {
    const body = chooseIngestBody({
      plain:   'Hi &amp; hello\n\nBody line',
      html:    '<p>ignored</p>',
      snippet: 'ignored snippet',
    });
    expect(body).toContain('Hi & hello');
    expect(body).toContain('Body line');
    expect(body).not.toContain('<p>');
  });

  it('falls back to HTML when plain is blank', () => {
    const body = chooseIngestBody({
      plain:   '',
      html:    '<p>Alice replied.</p><p>Thanks.</p>',
      snippet: 'ignored',
    });
    expect(body).toContain('Alice replied.');
    expect(body).toContain('Thanks.');
    expect(body).not.toMatch(/<[a-z]/i);
  });

  it('falls back to snippet last, entity-decoded', () => {
    const body = chooseIngestBody({
      plain:   null,
      html:    null,
      snippet: 'Sam wrote &lt;br&gt; here',
    });
    expect(body).toContain('<br>');
  });

  it('empty inputs → empty string (never returns entity gibberish)', () => {
    expect(chooseIngestBody({ plain: null, html: null, snippet: '' })).toBe('');
  });
});
