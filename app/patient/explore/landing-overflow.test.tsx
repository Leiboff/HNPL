import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── The bug this file exists for ──────────────────────────────────────
//
// Find care rendered 649px wide on a 390px phone. The page panned sideways
// into 259px of nothing, and browsers that shrink-to-fit an over-wide
// document rendered the whole screen zoomed out, like a desktop page that
// had wandered onto a phone.
//
// Nothing in the box tree was over-wide. The specialty pills live in a
// `overflow-x-auto` scroller, which clips them correctly, and every one of
// its ancestors measured exactly 390. The culprit was the `sr-only` span
// inside each pill — the one carrying "8 practitioners" for a screen
// reader, because the visible count is a bare aria-hidden number.
//
// `sr-only` is `position: absolute`. An absolutely positioned element
// resolves against its nearest POSITIONED ancestor, and the pill was
// `position: static`, as was everything above it — so the span's
// containing block was the viewport itself. A span belonging to a pill
// sitting at x≈650 INSIDE the scroller was therefore laid out at x≈650
// against the document, where no scroller was clipping anything. Eleven
// specialties, one of them 27 characters long, and the document was 259px
// wider than the phone.
//
// The fix is one word — `relative` on the pill — which gives the span a
// containing block inside the scroller, where the overflow is already
// handled. It is invisible, it looks like decoration, and deleting it
// brings the bug straight back. Hence this test.
//
// Asserted against the source rather than a rendered DOM on purpose:
// happy-dom has no layout engine, so it cannot measure scrollWidth, and a
// test that renders the component would pass whether or not the fix is
// there. The measurement that caught this was a real browser at 390px.

const ROOT = resolve(process.cwd());
const SRC  = readFileSync(resolve(ROOT, 'app/patient/explore/Landing.tsx'), 'utf8');

describe('the specialty pill row cannot widen the document', () => {
  // Narrow the source to the pill <Link>, so a `relative` somewhere else
  // in the file can't satisfy this.
  const pill = SRC.slice(
    SRC.indexOf('data-testid={`landing-category-'),
    SRC.indexOf('</Link>'),
  );

  it('the pill that holds an sr-only span is a positioned ancestor for it', () => {
    expect(pill).toContain('sr-only');
    expect(
      pill,
      'the pill must be `relative`, or its sr-only span escapes the ' +
      'horizontal scroller and widens the whole document — see the note ' +
      'at the top of this file',
    ).toMatch(/className="[^"]*\brelative\b/);
  });

  it('the row is still a horizontal scroller, not a wrap', () => {
    // The `relative` fix is only sound because the scroller clips. If the
    // row ever stops scrolling, the pills wrap and this whole class of bug
    // changes shape.
    expect(SRC).toMatch(/overflow-x-auto/);
    expect(SRC).toMatch(/whitespace-nowrap/);
  });
});
