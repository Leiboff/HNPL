import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import StatusChip from './StatusChip';

// The whole point of StatusChip is dimensional consistency — same height,
// padding, radius, font size for every status. Verify the base classes
// are present regardless of the colour `cls` passed in.

const BASE_CLASSES = [
  /\binline-flex\b/,
  /\bitems-center\b/,
  /\brounded-full\b/,
  /\bpx-2\.5\b/,
  /\bpy-0\.5\b/,
  /\btext-xs\b/,
  /\bfont-medium\b/,
];

describe('StatusChip — dimensional consistency', () => {
  const cases: Array<[string, string]> = [
    ['Active',     'bg-green-100 text-green-700'],
    ['Scheduled',  'bg-blue-50 text-blue-700'],
    ['Collected',  'bg-green-100 text-green-700'],
    ['Failed',     'bg-red-100 text-red-700'],
    ['Completed',  'bg-gray-100 text-gray-600'],
    ['Cancelled',  'bg-gray-100 text-gray-500'],
  ];

  for (const [label, cls] of cases) {
    it(`"${label}" chip carries every base layout class`, () => {
      render(<StatusChip label={label} cls={cls} />);
      const chip = screen.getByText(label);
      for (const re of BASE_CLASSES) {
        expect(chip.className).toMatch(re);
      }
    });

    it(`"${label}" chip applies the colour cls verbatim`, () => {
      render(<StatusChip label={label} cls={cls} />);
      const chip = screen.getByText(label);
      // Every token in the cls string is present on the chip.
      for (const token of cls.split(/\s+/)) {
        expect(chip.className).toContain(token);
      }
    });
  }

  it('every chip rendered side-by-side has the same set of base layout classes', () => {
    render(
      <>
        <StatusChip label="A" cls="bg-green-100 text-green-700" />
        <StatusChip label="B" cls="bg-blue-50 text-blue-700" />
        <StatusChip label="C" cls="bg-gray-100 text-gray-600" />
      </>,
    );
    const a = screen.getByText('A').className;
    const b = screen.getByText('B').className;
    const c = screen.getByText('C').className;
    for (const re of BASE_CLASSES) {
      expect(a).toMatch(re);
      expect(b).toMatch(re);
      expect(c).toMatch(re);
    }
  });
});
