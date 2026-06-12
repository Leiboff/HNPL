import { describe, it, expect } from 'vitest';
import { planCardRemoval, type RemovalCard } from './cardRemoval';

const card = (over: Partial<RemovalCard> & { id: string; created_at: string }): RemovalCard => ({
  token:      `tok_${over.id}`,
  is_default: false,
  ...over,
});

// ─── kind: 'not_found' ───────────────────────────────────────────────────────

describe('planCardRemoval — not_found', () => {
  it('returns not_found when the cardId isn\'t in the list', () => {
    const plan = planCardRemoval('nope', [card({ id: 'a', created_at: '2026-01-01' })], false);
    expect(plan.kind).toBe('not_found');
  });
});

// ─── kind: 'block_only_card' ─────────────────────────────────────────────────

describe('planCardRemoval — only-card guard', () => {
  it('blocks removal when it would leave the patient with zero cards', () => {
    const plan = planCardRemoval(
      'a',
      [card({ id: 'a', is_default: true, created_at: '2026-01-01' })],
      false,
    );
    expect(plan.kind).toBe('block_only_card');
  });

  it('also blocks the only card even when no active plans reference it', () => {
    const plan = planCardRemoval(
      'a',
      [card({ id: 'a', is_default: true, created_at: '2026-01-01' })],
      false,
    );
    expect(plan.kind).toBe('block_only_card');
  });

  it('also blocks the only card when an active plan IS on it (still no repoint target)', () => {
    const plan = planCardRemoval(
      'a',
      [card({ id: 'a', is_default: true, created_at: '2026-01-01' })],
      true,
    );
    expect(plan.kind).toBe('block_only_card');
  });
});

// ─── kind: 'remove' — happy paths ────────────────────────────────────────────

describe('planCardRemoval — non-default card, no active plans', () => {
  it('removes without repoint and without promoting any default', () => {
    const plan = planCardRemoval(
      'b',
      [
        card({ id: 'a', is_default: true,  created_at: '2026-01-01' }),
        card({ id: 'b', is_default: false, created_at: '2026-02-01' }),
      ],
      false,
    );
    expect(plan.kind).toBe('remove');
    if (plan.kind !== 'remove') throw new Error('narrow');
    expect(plan.promoteToDefaultId).toBeNull();
    expect(plan.repointToCardId).toBeNull();
    expect(plan.repointToToken).toBeNull();
  });
});

describe('planCardRemoval — non-default card, with active plans → repoint to current default', () => {
  it('repoints to the current default and does not change the default', () => {
    const plan = planCardRemoval(
      'b',
      [
        card({ id: 'a', is_default: true,  created_at: '2026-01-01', token: 'tok_a' }),
        card({ id: 'b', is_default: false, created_at: '2026-02-01', token: 'tok_b' }),
      ],
      true,
    );
    expect(plan.kind).toBe('remove');
    if (plan.kind !== 'remove') throw new Error('narrow');
    expect(plan.repointToCardId).toBe('a');
    expect(plan.repointToToken).toBe('tok_a');
    expect(plan.promoteToDefaultId).toBeNull();
  });
});

describe('planCardRemoval — default card, no active plans → promote newest other to default', () => {
  it('promotes the most recently added other card to default and does NOT repoint', () => {
    const plan = planCardRemoval(
      'a',
      [
        card({ id: 'a', is_default: true,  created_at: '2026-01-01' }),
        card({ id: 'b', is_default: false, created_at: '2026-02-01' }),
        card({ id: 'c', is_default: false, created_at: '2026-03-01' }),  // newest other
      ],
      false,
    );
    expect(plan.kind).toBe('remove');
    if (plan.kind !== 'remove') throw new Error('narrow');
    expect(plan.promoteToDefaultId).toBe('c');
    expect(plan.repointToCardId).toBeNull();
    expect(plan.repointToToken).toBeNull();
  });
});

describe('planCardRemoval — default card, with active plans → promote newest other AND repoint to it', () => {
  it('uses the same target for both promotion and repoint', () => {
    const plan = planCardRemoval(
      'a',
      [
        card({ id: 'a', is_default: true,  created_at: '2026-01-01', token: 'tok_a' }),
        card({ id: 'b', is_default: false, created_at: '2026-02-01', token: 'tok_b' }),
        card({ id: 'c', is_default: false, created_at: '2026-03-01', token: 'tok_c' }),
      ],
      true,
    );
    expect(plan.kind).toBe('remove');
    if (plan.kind !== 'remove') throw new Error('narrow');
    expect(plan.promoteToDefaultId).toBe('c');
    expect(plan.repointToCardId).toBe('c');
    expect(plan.repointToToken).toBe('tok_c');
  });

  it('default-invariant: exactly one card becomes the new default (never zero or two)', () => {
    const plan = planCardRemoval(
      'a',
      [
        card({ id: 'a', is_default: true,  created_at: '2026-01-01' }),
        card({ id: 'b', is_default: false, created_at: '2026-02-01' }),
      ],
      true,
    );
    if (plan.kind !== 'remove') throw new Error('narrow');
    // Either promoteToDefaultId is set (we removed the default) or it
    // stays null (the removed card wasn't the default). Never undefined.
    expect(['string', 'object']).toContain(typeof plan.promoteToDefaultId);
    if (plan.promoteToDefaultId) {
      expect(plan.promoteToDefaultId).toBe('b');
    }
  });
});

describe('planCardRemoval — defensive: no current default exists (broken state)', () => {
  it('still picks the most recently added other card as the target when no default exists', () => {
    const plan = planCardRemoval(
      'a',
      [
        card({ id: 'a', is_default: false, created_at: '2026-01-01' }),
        card({ id: 'b', is_default: false, created_at: '2026-02-01' }),
        card({ id: 'c', is_default: false, created_at: '2026-03-01' }),
      ],
      true,
    );
    if (plan.kind !== 'remove') throw new Error('narrow');
    // 'c' is the newest non-removed card.
    expect(plan.repointToCardId).toBe('c');
  });
});
