import { describe, it, expect } from 'vitest';
import { splitQuoted, materialiseSplit, firstLine, findFirstQuoteCue } from './quoteSplit';

// ─── splitQuoted — pure behavioural tests ──────────────────────────

describe('splitQuoted — Gmail "On …, X wrote:" attribution', () => {
  it('splits at a single-line attribution', () => {
    const text = [
      'Hi Sam,',
      '',
      'Sounds great. Let\'s do Wednesday.',
      '',
      'On Tue, 14 Jul 2026 at 09:12, Sam <sam@x.com> wrote:',
      '> Original from Sam',
    ].join('\n');
    const s = splitQuoted(text);
    expect(s.fresh).toContain('Sounds great');
    expect(s.quoted).toMatch(/^On Tue, 14 Jul 2026/);
    expect(s.quoted).toContain('Original from Sam');
    expect(s.fresh).not.toContain('Original from Sam');
  });

  it('splits at a wrapped attribution (attribution spanning 2 lines)', () => {
    const text = [
      'Hi Sam,',
      '',
      'Sure — see you then.',
      '',
      'On Tue, 14 Jul 2026 at 09:12, Sam Smith',
      '<sam@betternow.co.za> wrote:',
      '> old content',
    ].join('\n');
    const s = splitQuoted(text);
    expect(s.fresh).toContain('Sure — see you then.');
    expect(s.quoted).toMatch(/^On Tue, 14 Jul 2026/);
    expect(s.quoted).toContain('old content');
    expect(s.fresh).not.toContain('Sam Smith');
  });

  it('splits at a 3-line-wrapped attribution', () => {
    const text = [
      'Reply body here.',
      '',
      'On Tuesday,',
      '14 July 2026 at 09:12,',
      'Sam Smith <sam@x.com> wrote:',
      '> old',
    ].join('\n');
    const s = splitQuoted(text);
    expect(s.fresh).toBe('Reply body here.');
    expect(s.quoted).toMatch(/^On Tuesday/);
  });

  it('handles entity-decoded attribution punctuation (previously "wroteâ¯:" via mojibake)', () => {
    // We only claim to split on real "wrote:" — this test locks the
    // requirement that a well-decoded attribution splits properly.
    const text = 'Fresh line\n\nOn Mon, 12 Jul 2026 at 10:00, Alice <a@x> wrote:\n> Old';
    const s = splitQuoted(text);
    expect(s.fresh).toBe('Fresh line');
    expect(s.quoted).toContain('On Mon');
  });
});

describe('splitQuoted — Outlook "From: … Sent: …" block', () => {
  it('splits at a two-line-header block', () => {
    const text = [
      'Hi,',
      '',
      'Confirmed. See you then.',
      '',
      'From: Alice Smith <alice@example.com>',
      'Sent: Monday, 12 July 2026 10:00',
      'To: sam@betternow.co.za',
      'Subject: Re: Intro',
      '',
      'Original body from Alice.',
    ].join('\n');
    const s = splitQuoted(text);
    expect(s.fresh).toContain('Confirmed');
    expect(s.quoted).toMatch(/^From: Alice/);
    expect(s.quoted).toContain('Original body from Alice');
  });

  it('does NOT split on a single "From:" line inside fresh text', () => {
    // If someone writes "From: my perspective, …" as regular prose we
    // shouldn't chop it off. Require at least two consecutive header lines.
    const text = [
      'Hi Sam,',
      '',
      'From: my perspective, this makes sense.',
      '',
      'Cheers.',
    ].join('\n');
    const s = splitQuoted(text);
    expect(s.quoted).toBe('');
    expect(s.fresh).toContain('perspective');
  });
});

describe('splitQuoted — "> " prefixed runs', () => {
  it('splits at the first quoted line even with no attribution', () => {
    const text = 'thanks!\n\n> earlier body\n> even earlier\n> tail';
    const s = splitQuoted(text);
    expect(s.fresh).toBe('thanks!');
    expect(s.quoted).toMatch(/^> earlier body/);
  });

  it('handles leading whitespace before the ">"', () => {
    const text = 'hi\n\n   > quoted stuff';
    const s = splitQuoted(text);
    expect(s.fresh).toBe('hi');
    expect(s.quoted).toMatch(/^\s*>/);
  });
});

describe('splitQuoted — signature delimiter', () => {
  it('cuts at the "-- " sentinel (RFC 3676)', () => {
    const text = 'Cheers,\nSam\n\n-- \nSam Smith\nHead of Sales';
    const s = splitQuoted(text);
    expect(s.fresh).toContain('Cheers');
    expect(s.fresh).toContain('Sam');
    expect(s.quoted).toMatch(/^--/);
    expect(s.quoted).toContain('Head of Sales');
  });

  it('accepts "--" without the trailing space (clients strip it)', () => {
    const text = 'Cheers\n\n--\nSam\n\nOh and PS';
    const s = splitQuoted(text);
    expect(s.fresh).toBe('Cheers');
    expect(s.quoted).toContain('Sam');
  });
});

describe('splitQuoted — no quote', () => {
  it('passes through when there is no cue', () => {
    const text = 'Just a fresh short reply, no quoted tail here.\n\nCheers.';
    const s = splitQuoted(text);
    expect(s.fresh).toBe(text.trim());
    expect(s.quoted).toBe('');
  });

  it('empty input → both halves empty', () => {
    const s = splitQuoted('');
    expect(s.fresh).toBe('');
    expect(s.quoted).toBe('');
  });
});

describe('materialiseSplit — quotes-only reply fallback', () => {
  it('lifts first quoted lines into fresh when the reply is only quotes', () => {
    // User replied with nothing but the quoted body. splitQuoted's
    // fresh would be empty; materialiseSplit surfaces the first
    // quoted lines as fresh so the timeline never renders blank.
    const text = [
      '> earlier from us',
      '> continues',
      '> and more',
    ].join('\n');
    const s = materialiseSplit(text);
    expect(s.fresh.length).toBeGreaterThan(0);
    // Original quoted block is still available for the ••• toggle.
    expect(s.quoted).toContain('earlier from us');
  });

  it('does NOT lift when fresh is already non-empty', () => {
    const text = 'thanks\n\n> earlier';
    const s = materialiseSplit(text);
    expect(s.fresh).toBe('thanks');
    expect(s.quoted).toContain('earlier');
  });
});

describe('firstLine helper', () => {
  it('returns the first non-empty line collapsed to a single row', () => {
    expect(firstLine('\n\n  hello   world  \nline 2')).toBe('hello world');
  });

  it('truncates long lines with an ellipsis', () => {
    expect(firstLine('a'.repeat(200), 20)).toMatch(/…$/);
    expect(firstLine('a'.repeat(200), 20).length).toBe(20);
  });

  it('empty input → empty string', () => {
    expect(firstLine('')).toBe('');
    expect(firstLine('   ')).toBe('');
  });
});

describe('findFirstQuoteCue — returns -1 on no cue, byte offset otherwise', () => {
  it('returns -1 on all-fresh text', () => {
    expect(findFirstQuoteCue('hi there\nno quote here')).toBe(-1);
  });

  it('returns a positive offset when cue exists', () => {
    const text = 'fresh\n> quoted';
    const off = findFirstQuoteCue(text);
    expect(off).toBeGreaterThan(0);
    expect(text.slice(off)).toMatch(/^> quoted/);
  });
});
