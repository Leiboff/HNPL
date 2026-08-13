import { describe, it, expect } from 'vitest';
import { stripComments } from './stripComments';

// ─── The helper that twenty source-pin tests depend on ────────────────────
//
// Thirteen copies of this logic stripped BLOCK comments before LINE comments,
// so a `/*` inside a `//` line opened a block comment and everything through
// the next `*/` was deleted. The failure mode that matters is not the loud
// one: an ABSENCE assertion over a source that was silently truncated passes
// trivially, so a test written to catch drift stops catching anything.
//
// The fixtures below are the two real shapes, plus the mirror-image case that
// makes swapping the order not good enough on its own.

// ─── The bug, exactly as it appeared ──────────────────────────────────────

describe('a // comment containing /* must not open a block comment', () => {
  // Lifted from app/practice/settings/page.tsx, which lost 3,443 of its
  // 13,835 characters under the old order.
  const SRC = [
    '// The components stay where they are on disk',
    '// (app/practice/details/**, app/practice/pos/devices/**) because their own',
    '// test suites address them there.',
    'const canSeeAnySettingsSection = true;',
    'export default function Page() {',
    '  return (',
    '    <main>',
    '      {/* Read-only, set by BetterNow. */}',
    '      <BranchDetailsForm />',
    '    </main>',
    '  );',
    '}',
  ].join('\n');

  const code = stripComments(SRC);

  it('keeps the real code that followed the prose', () => {
    // Under block-then-line this whole span was deleted: the `/**` on line 2
    // opened a comment that the stripper thought closed at the JSX comment on
    // line 8, taking the const, the function signature and <main> with it.
    expect(code).toMatch(/const canSeeAnySettingsSection = true;/);
    expect(code).toMatch(/export default function Page\(\)/);
    expect(code).toMatch(/<main>/);
    expect(code).toMatch(/<BranchDetailsForm \/>/);
  });

  it('still removes the prose itself', () => {
    expect(code).not.toMatch(/test suites address them there/);
    expect(code).not.toMatch(/app\/practice\/pos\/devices/);
    expect(code).not.toMatch(/Read-only, set by BetterNow/);
  });

  it('demonstrates the OLD order actually loses that code', () => {
    // Not a hypothetical. If this ever stops being true, the bug this helper
    // exists for has changed shape and the reasoning above needs revisiting.
    const blockThenLine = (s: string) =>
      s.replace(/\/\*[\s\S]*?\*\//g, '')
       .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
    expect(blockThenLine(SRC)).not.toMatch(/const canSeeAnySettingsSection/);
    expect(blockThenLine(SRC).length).toBeLessThan(code.length);
  });
});

// ─── The mirror image, which swapping the order would break ───────────────

describe('a // inside a BLOCK comment must not eat the block terminator', () => {
  const SRC = [
    '/* Resolved on the caller\'s own client',
    '   and never widened — see practiceViewer.ts // note */',
    'const realCode = 42;',
  ].join('\n');

  it('removes the whole block and keeps the code', () => {
    const code = stripComments(SRC);
    expect(code).toMatch(/const realCode = 42;/);
    expect(code).not.toMatch(/practiceViewer/);
    expect(code).not.toMatch(/never widened/);
  });

  it('demonstrates that line-then-block would leak the comment as code', () => {
    // Why this helper is a single pass rather than the two passes in the other
    // order: stripping lines first eats the `*/`, leaving an unterminated
    // `/*` that the non-greedy block regex cannot match — so the entire
    // comment survives into the "code" and an absence assertion fires on
    // prose. Neither order is correct; only reading left to right is.
    const lineThenBlock = (s: string) =>
      s.split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n')
       .replace(/\/\*[\s\S]*?\*\//g, '');
    expect(lineThenBlock(SRC)).toMatch(/never widened/);
  });
});

// ─── Ordinary behaviour ───────────────────────────────────────────────────

describe('the everyday cases', () => {
  it('strips a trailing line comment but keeps the code before it', () => {
    expect(stripComments("const x = 1; // set to 2 later\nconst y = 2;"))
      .toBe('const x = 1; \nconst y = 2;');
  });

  it('keeps the newline that ended a line comment', () => {
    // Dropping it would join two statements and could fabricate a match that
    // spans them.
    const code = stripComments('a(); // note\nb();');
    expect(code.split('\n')).toHaveLength(2);
    expect(code).toMatch(/a\(\); *\nb\(\);/);
  });

  it('strips an inline block comment in place', () => {
    expect(stripComments('const x = /* four */ 4;')).toBe('const x =  4;');
  });

  it('strips a multi-line block comment entirely, newlines included', () => {
    // Matches what the helpers this replaces did, so slice-based assertions
    // built around them keep the same offsets.
    expect(stripComments('a();\n/* one\n   two */\nb();')).toBe('a();\n\nb();');
  });

  it('leaves a source with no comments untouched', () => {
    const src = 'export const A = 1;\nexport const B = 2;\n';
    expect(stripComments(src)).toBe(src);
  });

  it('treats an unterminated block comment as running to the end', () => {
    expect(stripComments('a();\n/* never closed\nb();')).toBe('a();\n');
  });

  it('handles a line comment on the last line with no trailing newline', () => {
    expect(stripComments('a(); // end')).toBe('a(); ');
  });

  it('does not confuse division or a regex literal for a comment', () => {
    expect(stripComments('const r = a / b;')).toBe('const r = a / b;');
    expect(stripComments("const re = /ab*c/;")).toBe("const re = /ab*c/;");
  });
});

// ─── sql ──────────────────────────────────────────────────────────────────

describe('sql: -- line comments', () => {
  const SRC = [
    '-- Attribution moved off plans.provider_id (see supabase/migrations/**)',
    'INSERT INTO plans (id, provider_member_id) VALUES (1, 2);',
  ].join('\n');

  it('strips -- comments and keeps the statement', () => {
    const code = stripComments(SRC, { sql: true });
    expect(code).toMatch(/INSERT INTO plans \(id, provider_member_id\)/);
    expect(code).not.toMatch(/Attribution moved/);
    // The same trap as the JS case: `/**` in a -- comment must not open a
    // block and swallow the statement below it.
    expect(code).not.toMatch(/provider_id \(see/);
  });

  it('leaves -- alone when the option is off', () => {
    expect(stripComments('a - -b;')).toBe('a - -b;');
    expect(stripComments('-- not a comment here')).toBe('-- not a comment here');
  });
});

// ─── jsxBraces ────────────────────────────────────────────────────────────

describe('jsxBraces', () => {
  it('removes the braces wrapping a JSX comment', () => {
    const code = stripComments('<div>\n  {/* hidden */}\n  <p />\n</div>', { jsxBraces: true });
    expect(code).not.toMatch(/[{}]/);
    expect(code).toMatch(/<p \/>/);
  });

  it('leaves a real empty object literal alone', () => {
    expect(stripComments('const o = {};', { jsxBraces: true })).toBe('const o = {};');
    expect(stripComments('useEffect(() => {}, []);', { jsxBraces: true }))
      .toBe('useEffect(() => {}, []);');
  });

  it('leaves the braces when the option is off', () => {
    expect(stripComments('<div>{/* x */}</div>')).toBe('<div>{}</div>');
  });

  it('does not swallow a brace that belongs to surrounding code', () => {
    // `{cond && /* why */ value}` — the brace is a JSX expression, not a
    // comment wrapper, and the `}` is not adjacent to the comment's end.
    const code = stripComments('<p>{cond && /* why */ value}</p>', { jsxBraces: true });
    expect(code).toBe('<p>{cond &&  value}</p>');
  });
});

// ─── preserveUrls ─────────────────────────────────────────────────────────

describe('preserveUrls', () => {
  it('keeps a URL in a string literal', () => {
    expect(stripComments("fetch('https://example.test/x');", { preserveUrls: true }))
      .toBe("fetch('https://example.test/x');");
  });

  it('still strips a genuine line comment on the same line', () => {
    expect(stripComments("const u = 'https://a.test'; // note", { preserveUrls: true }))
      .toBe("const u = 'https://a.test'; ");
  });

  it('truncates the URL when the option is off — the long-standing behaviour', () => {
    // Documented rather than fixed: every helper this replaces behaved this
    // way, and changing it for all of them at once would be a behaviour change
    // hiding inside a bug fix. The two call sites that care opt in.
    expect(stripComments("fetch('https://example.test/x');"))
      .toBe("fetch('https:");
  });
});
