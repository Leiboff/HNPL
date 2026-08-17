import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act, cleanup } from '@testing-library/react';
import DelayedSkeleton from './DelayedSkeleton';
import { SKELETON_DELAY_MS } from './timing';
import {
  SkeletonRegion,
  SkeletonLine,
  SkeletonBlock,
  SkeletonCircle,
  SkeletonRows,
  SkeletonStatTiles,
  SkeletonFormFields,
  Spinner,
} from './Skeleton';
import { DashboardShape, ListShape, DetailShape, FormShape } from './shapes';

// ─── The two things a skeleton has to get right ──────────────────────────
//
//  1. NOT FLASHING. A skeleton that appears for 80 ms and vanishes reads as
//     a rendering bug, which is worse than a still screen — a flicker is a
//     defect signal, a pause is merely slow.
//
//  2. NOT BEING THE ONLY SIGNAL. The pulse is motion-safe, so a
//     reduced-motion user sees static grey blocks. Grey blocks with nothing
//     else are the same frozen-app problem for a smaller audience, so every
//     skeleton must also announce itself as text.

async function advance(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('DelayedSkeleton — a fast response shows nothing', () => {
  it('renders NOTHING before the delay elapses', async () => {
    const { container } = render(
      <DelayedSkeleton><div data-testid="sk">skeleton</div></DelayedSkeleton>,
    );
    expect(container.innerHTML).toBe('');
    expect(screen.queryByTestId('sk')).toBeNull();
  });

  it('an 80ms response never sees a skeleton — the brief\'s example', async () => {
    render(<DelayedSkeleton><div data-testid="sk">skeleton</div></DelayedSkeleton>);
    await advance(80);
    expect(screen.queryByTestId('sk')).toBeNull();
  });

  it('still nothing one millisecond before the threshold', async () => {
    render(<DelayedSkeleton><div data-testid="sk">skeleton</div></DelayedSkeleton>);
    await advance(SKELETON_DELAY_MS - 1);
    expect(screen.queryByTestId('sk')).toBeNull();
  });

  it('appears once the threshold is crossed — it is a delay, not a suppression', async () => {
    // The other half of the requirement: a genuinely slow route MUST get
    // feedback. A delay that never resolved would be a worse bug than the
    // flash it prevents.
    render(<DelayedSkeleton><div data-testid="sk">skeleton</div></DelayedSkeleton>);
    await advance(SKELETON_DELAY_MS + 5);
    expect(screen.queryByTestId('sk')).not.toBeNull();
  });

  it('starts hidden on the FIRST render, so server and client agree', async () => {
    // If the initial state were derived from a clock, the server markup and
    // the first client render would differ and hydration would mismatch.
    const { container } = render(
      <DelayedSkeleton><div>x</div></DelayedSkeleton>,
    );
    expect(container.innerHTML).toBe('');
  });

  it('drops its timer on unmount', async () => {
    const errors: unknown[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...a) => { errors.push(a); });
    render(<DelayedSkeleton><div>x</div></DelayedSkeleton>);
    cleanup();
    await advance(SKELETON_DELAY_MS + 100);
    expect(errors).toEqual([]);
    spy.mockRestore();
  });

  it('honours an explicit override', async () => {
    render(<DelayedSkeleton delayMs={500}><div data-testid="sk">x</div></DelayedSkeleton>);
    await advance(SKELETON_DELAY_MS + 50);
    expect(screen.queryByTestId('sk')).toBeNull();
    await advance(400);
    expect(screen.queryByTestId('sk')).not.toBeNull();
  });
});

describe('reduced motion is honoured — and is never left silent', () => {
  it('every animated primitive gates its animation on motion-safe', () => {
    // Asserted on the emitted class rather than by simulating the media
    // query, because the class IS the mechanism: Tailwind's motion-safe:
    // compiles to @media (prefers-reduced-motion: no-preference).
    const { container } = render(
      <SkeletonRegion label="Loading">
        <SkeletonLine />
        <SkeletonBlock />
        <SkeletonCircle />
        <SkeletonRows rows={2} />
        <SkeletonStatTiles tiles={2} />
        <SkeletonFormFields fields={2} />
      </SkeletonRegion>,
    );
    const animated = container.querySelectorAll('[class*="animate-"]');
    expect(animated.length).toBeGreaterThan(0);
    for (const el of animated) {
      expect(el.className, el.className).toMatch(/motion-safe:animate-/);
      // An ungated animate- class would run regardless of preference.
      expect(el.className, el.className).not.toMatch(/(^|\s)animate-/);
    }
  });

  it('the Spinner HIDES under reduced motion rather than freezing', () => {
    // A frozen spinner is a three-quarter grey arc — it reads as a
    // rendering artifact, not a status. Its meaning is entirely in the
    // motion, so with the motion gone there is nothing worth drawing.
    const { container } = render(<Spinner />);
    const svg = container.querySelector('svg')!;
    expect(svg.className).toMatch(/motion-safe:animate-spin/);
    expect(svg.className).toMatch(/motion-reduce:hidden/);
  });

  it('the region announces itself as TEXT, so motion is never the only cue', () => {
    render(<SkeletonRegion label="Loading your bills"><SkeletonLine /></SkeletonRegion>);
    const region = screen.getByRole('status');
    expect(region).toHaveAttribute('aria-busy', 'true');
    expect(region.textContent).toContain('Loading your bills');
  });

  it('uses role=status (polite), not role=alert', () => {
    // Polite so it does not interrupt whatever the user is hearing.
    // "This is loading" is not an alert.
    render(<SkeletonRegion label="Loading"><SkeletonLine /></SkeletonRegion>);
    const region = screen.getByRole('status');
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('the individual blocks are aria-hidden — the region speaks once', () => {
    // Announcing sixteen meaningless boxes is worse than announcing nothing.
    const { container } = render(
      <SkeletonRegion label="Loading"><SkeletonRows rows={4} /></SkeletonRegion>,
    );
    const blocks = container.querySelectorAll('[class*="animate-"]');
    expect(blocks.length).toBeGreaterThan(4);
    for (const b of blocks) expect(b).toHaveAttribute('aria-hidden');
  });
});

describe('the shared shapes render real content, not nothing', () => {
  const SHAPES = [
    ['DashboardShape', <DashboardShape key="d" label="Loading dashboard" />],
    ['ListShape',      <ListShape      key="l" label="Loading list" />],
    ['DetailShape',    <DetailShape    key="t" label="Loading detail" />],
    ['FormShape',      <FormShape      key="f" label="Loading form" />],
  ] as const;

  it.each(SHAPES)('%s renders a labelled status region with blocks', (_name, el) => {
    const { container } = render(el);
    const region = screen.getByRole('status');
    expect(region.textContent).toMatch(/Loading/);
    expect(container.querySelectorAll('[class*="animate-"]').length).toBeGreaterThan(3);
  });

  it('SkeletonRows produces the requested number of rows', () => {
    const { container } = render(
      <SkeletonRegion label="Loading"><SkeletonRows rows={7} /></SkeletonRegion>,
    );
    // Each row has a value block on the right; count the row wrappers.
    expect(container.querySelectorAll('.divide-y > div').length).toBe(7);
  });

  it('row widths are deterministic, not random', () => {
    // A randomised width differs between the server and client render and
    // produces a hydration mismatch. Same input must give same output.
    const a = render(<SkeletonRegion label="x"><SkeletonRows rows={5} /></SkeletonRegion>).container.innerHTML;
    cleanup();
    const b = render(<SkeletonRegion label="x"><SkeletonRows rows={5} /></SkeletonRegion>).container.innerHTML;
    expect(a).toBe(b);
  });
});
