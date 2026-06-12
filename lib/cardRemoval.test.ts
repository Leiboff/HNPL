import { describe, it, expect } from 'vitest';
import { planCardRemoval, type RemovalCard } from './cardRemoval';

const card = (over: Partial<RemovalCard> & { id: string; created_at: string }): RemovalCard => ({
  is_default: false,
  ...over,
});

// ─── kind: 'not_found' ───────────────────────────────────────────────────────

describe('planCardRemoval — not_found', () => {
  it('returns not_found when the cardId isn\'t in the list', () => {
    const plan = planCardRemoval('nope', [card({ id: 'a', created_at: '2026-01-01' })]);
    expect(plan.kind).toBe('not_found');
  });
});

// ─── kind: 'block_only_card' ─────────────────────────────────────────────────

describe('planCardRemoval — only-card guard', () => {
  it('blocks removal when it would leave the patient with zero cards', () => {
    const plan = planCardRemoval(
      'a',
      [card({ id: 'a', is_default: true, created_at: '2026-01-01' })],
    );
    expect(plan.kind).toBe('block_only_card');
  });
});

// ─── kind: 'remove_non_default' ──────────────────────────────────────────────

describe('planCardRemoval — non-default card removes freely', () => {
  it('returns remove_non_default for a non-default card with siblings', () => {
    const plan = planCardRemoval(
      'b',
      [
        card({ id: 'a', is_default: true,  created_at: '2026-01-01' }),
        card({ id: 'b', is_default: false, created_at: '2026-02-01' }),
      ],
    );
    expect(plan.kind).toBe('remove_non_default');
  });

  it('does not require choosing a target — under the invariant no plans should point at this card', () => {
    const plan = planCardRemoval(
      'b',
      [
        card({ id: 'a', is_default: true,  created_at: '2026-01-01' }),
        card({ id: 'b', is_default: false, created_at: '2026-02-01' }),
        card({ id: 'c', is_default: false, created_at: '2026-03-01' }),
      ],
    );
    expect(plan.kind).toBe('remove_non_default');
  });
});

// ─── kind: 'remove_default' ──────────────────────────────────────────────────

describe('planCardRemoval — default card promotes newest other', () => {
  it('promotes the most recently added other card to default', () => {
    const plan = planCardRemoval(
      'a',
      [
        card({ id: 'a', is_default: true,  created_at: '2026-01-01' }),
        card({ id: 'b', is_default: false, created_at: '2026-02-01' }),
        card({ id: 'c', is_default: false, created_at: '2026-03-01' }),
      ],
    );
    expect(plan.kind).toBe('remove_default');
    if (plan.kind !== 'remove_default') throw new Error('narrow');
    expect(plan.promoteToDefaultId).toBe('c');
  });

  it('with exactly two cards, the other one is the promotion target', () => {
    const plan = planCardRemoval(
      'a',
      [
        card({ id: 'a', is_default: true,  created_at: '2026-01-01' }),
        card({ id: 'b', is_default: false, created_at: '2026-02-01' }),
      ],
    );
    if (plan.kind !== 'remove_default') throw new Error('narrow');
    expect(plan.promoteToDefaultId).toBe('b');
  });
});

// ─── Invariant: never leaves zero defaults ───────────────────────────────────

describe('planCardRemoval — default-invariant preservation', () => {
  it('removing the default ALWAYS names a successor (never null)', () => {
    const plan = planCardRemoval(
      'a',
      [
        card({ id: 'a', is_default: true,  created_at: '2026-01-01' }),
        card({ id: 'b', is_default: false, created_at: '2026-02-01' }),
      ],
    );
    if (plan.kind !== 'remove_default') throw new Error('narrow');
    expect(typeof plan.promoteToDefaultId).toBe('string');
    expect(plan.promoteToDefaultId.length).toBeGreaterThan(0);
  });

  it('removing a non-default card never changes the default (no promotion)', () => {
    const plan = planCardRemoval(
      'c',
      [
        card({ id: 'a', is_default: true,  created_at: '2026-01-01' }),
        card({ id: 'b', is_default: false, created_at: '2026-02-01' }),
        card({ id: 'c', is_default: false, created_at: '2026-03-01' }),
      ],
    );
    expect(plan.kind).toBe('remove_non_default');
    // remove_non_default carries no "promoteToDefaultId" key — the existing
    // default stays.
    expect((plan as Record<string, unknown>).promoteToDefaultId).toBeUndefined();
  });
});
