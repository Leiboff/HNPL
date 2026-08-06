import { describe, it, expect } from 'vitest';
import { planCardRemoval, type RemovalCard } from './cardRemoval';

const card = (over: Partial<RemovalCard> & { id: string; created_at: string }): RemovalCard => ({
  is_default:         false,
  collectsActivePlan: false,
  ...over,
});

// ─── kind: 'not_found' ───────────────────────────────────────────────────────

describe('planCardRemoval — not_found', () => {
  it('returns not_found when the cardId isn\'t in the list', () => {
    const plan = planCardRemoval('nope', [card({ id: 'a', created_at: '2026-01-01' })]);
    expect(plan.kind).toBe('not_found');
  });
});

// ─── kind: 'block_collecting' — the single, conditional block ────────────────

describe('planCardRemoval — blocks a card collecting an active plan', () => {
  it('blocks when the card is collecting an active plan (even if non-default)', () => {
    const plan = planCardRemoval(
      'b',
      [
        card({ id: 'a', is_default: true,  created_at: '2026-01-01' }),
        card({ id: 'b', is_default: false, created_at: '2026-02-01', collectsActivePlan: true }),
      ],
    );
    expect(plan.kind).toBe('block_collecting');
  });

  it('blocks the default card too when it is collecting an active plan', () => {
    const plan = planCardRemoval(
      'a',
      [
        card({ id: 'a', is_default: true, created_at: '2026-01-01', collectsActivePlan: true }),
        card({ id: 'b', is_default: false, created_at: '2026-02-01' }),
      ],
    );
    expect(plan.kind).toBe('block_collecting');
  });
});

// ─── kind: 'archive_non_default' ─────────────────────────────────────────────

describe('planCardRemoval — non-default card archives freely', () => {
  it('returns archive_non_default for a non-default card not collecting anything', () => {
    const plan = planCardRemoval(
      'b',
      [
        card({ id: 'a', is_default: true,  created_at: '2026-01-01' }),
        card({ id: 'b', is_default: false, created_at: '2026-02-01' }),
      ],
    );
    expect(plan.kind).toBe('archive_non_default');
  });
});

// ─── kind: 'archive_default' ─────────────────────────────────────────────────

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
    expect(plan.kind).toBe('archive_default');
    if (plan.kind !== 'archive_default') throw new Error('narrow');
    expect(plan.promoteToDefaultId).toBe('c');
  });

  it('promoteToDefaultId is null when the default is the only card', () => {
    const plan = planCardRemoval(
      'a',
      [card({ id: 'a', is_default: true, created_at: '2026-01-01' })],
    );
    expect(plan.kind).toBe('archive_default');
    if (plan.kind !== 'archive_default') throw new Error('narrow');
    expect(plan.promoteToDefaultId).toBeNull();
  });
});

// ─── Removability is conditional, not blanket ────────────────────────────────

describe('planCardRemoval — not a blanket block', () => {
  it('a lone card that collects nothing active is still archivable', () => {
    const plan = planCardRemoval(
      'a',
      [card({ id: 'a', is_default: true, created_at: '2026-01-01', collectsActivePlan: false })],
    );
    // archivable (default → archive_default with no successor), NOT blocked.
    expect(plan.kind).toBe('archive_default');
  });

  it('removing a non-default, non-collecting card never promotes anything', () => {
    const plan = planCardRemoval(
      'c',
      [
        card({ id: 'a', is_default: true,  created_at: '2026-01-01' }),
        card({ id: 'b', is_default: false, created_at: '2026-02-01' }),
        card({ id: 'c', is_default: false, created_at: '2026-03-01' }),
      ],
    );
    expect(plan.kind).toBe('archive_non_default');
    expect((plan as Record<string, unknown>).promoteToDefaultId).toBeUndefined();
  });
});
