import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stripComments } from '@/lib/testing/stripComments';
import { resolveBrandViewer } from './brandViewer';

// ─── Who is this brand admin, and whose practices are they ────────────────
//
// Two things matter here and nothing else does.
//
//   THE n RULE. n=0 → setup, n=1 → that practice, n>=2 → the portal. It is not
//   cosmetic: at n=1 every brand screen is a worse version of the practice's own
//   dashboard, and the nav would say "practices" about one practice.
//
//   SCOPING. Authority through the CALLER'S client, data scoped by an .in()
//   built from the rows that client returned. The adversarial test below is the
//   whole point of the module: a brand admin of one group must never see
//   another group's practices, and the fake honours filters so the assertion is
//   about the code rather than about the fake.

type Row = Record<string, unknown>;

function makeClient(state: Record<string, Row[]>, seen: string[][] = []) {
  return {
    seen,
    from(table: string) {
      const eqs: Array<[string, unknown]> = [];
      const ins: Array<[string, unknown[]]> = [];

      const b: Record<string, unknown> = {
        select: () => b,
        eq: (c: string, v: unknown) => { eqs.push([c, v]); return b; },
        in: (c: string, v: unknown[]) => { ins.push([c, v]); return b; },
        order: () => b,
        then: (onFulfilled: (v: { data: Row[] }) => unknown) => {
          seen.push([table, ...ins.map(([c, v]) => `${c} in [${v.join(',')}]`)]);
          const rows = (state[table] ?? []).filter(
            (r) =>
              eqs.every(([c, v]) => r[c] === v) &&
              ins.every(([c, v]) => v.includes(r[c])),
          );
          return Promise.resolve({ data: rows }).then(onFulfilled);
        },
      };
      return b;
    },
  };
}

const GROUPS = [
  { id: 'g1', name: 'Bright Smiles', logo_url: 'https://x/logo.png' },
  { id: 'g2', name: 'Someone Else',  logo_url: null },
];

function practice(id: string, groupId: string, over: Row = {}): Row {
  return {
    id, group_id: groupId, name: id, status: 'approved',
    city: 'Johannesburg', suburb: 'Rosebank', fee_percent: 6, ...over,
  };
}

function world(over: Partial<Record<string, Row[]>> = {}) {
  return {
    practice_group_members: over.practice_group_members ?? [
      { group_id: 'g1', user_id: 'me', active: true },
    ],
    practices: over.practices ?? [
      practice('p1', 'g1'),
      practice('p2', 'g1'),
      practice('p-theirs', 'g2'),
    ],
    practice_groups: over.practice_groups ?? GROUPS,
  };
}

const run = (state = world(), userId = 'me') => {
  const c = makeClient(state);
  return resolveBrandViewer(c, c, userId);
};

// ─── The n rule ──────────────────────────────────────────────────────────

describe('the n rule', () => {
  it('no active brand membership → denied', async () => {
    expect(await run(world(), 'stranger')).toEqual({ kind: 'denied' });
  });

  it('a DEACTIVATED brand membership buys nothing', async () => {
    const state = world({
      practice_group_members: [{ group_id: 'g1', user_id: 'me', active: false }],
    });
    expect(await run(state)).toEqual({ kind: 'denied' });
  });

  it('brand membership but zero practices → setup', async () => {
    expect(await run(world({ practices: [practice('p-theirs', 'g2')] }))).toEqual({ kind: 'setup' });
  });

  it('exactly one practice → solo, carrying that practice id', async () => {
    const state = world({ practices: [practice('p1', 'g1'), practice('p-theirs', 'g2')] });
    expect(await run(state)).toEqual({ kind: 'solo', practiceId: 'p1' });
  });

  it('two or more → the brand portal', async () => {
    const v = await run();
    expect(v.kind).toBe('brand');
    if (v.kind !== 'brand') return;
    expect(v.practices.map((p) => p.id)).toEqual(['p1', 'p2']);
  });

  it('solo is decided by PRACTICES, not by how many brand rows exist', async () => {
    // A user can admin two brands and still have one practice between them, and
    // the brand portal is still the wrong screen for them.
    const state = world({
      practice_group_members: [
        { group_id: 'g1', user_id: 'me', active: true },
        { group_id: 'g2', user_id: 'me', active: true },
      ],
      practices: [practice('p1', 'g1')],
    });
    expect(await run(state)).toEqual({ kind: 'solo', practiceId: 'p1' });
  });
});

// ─── Shape ───────────────────────────────────────────────────────────────

describe('what it returns', () => {
  it('maps every practice field the surfaces need, with numeric fee', async () => {
    const v = await run();
    if (v.kind !== 'brand') throw new Error('expected brand');
    expect(v.practices[0]).toEqual({
      id: 'p1', name: 'p1', status: 'approved',
      suburb: 'Rosebank', city: 'Johannesburg', groupId: 'g1', feePct: 6,
    });
  });

  it('survives null-ish columns without printing "null" at a reader', async () => {
    const state = world({
      practices: [
        practice('p1', 'g1', { name: null, status: null, suburb: null, city: null, fee_percent: null }),
        practice('p2', 'g1'),
      ],
    });
    const v = await run(state);
    if (v.kind !== 'brand') throw new Error('expected brand');
    expect(v.practices[0].name).toBe('—');
    expect(v.practices[0].status).toBe('pending');   // fail-closed, not "approved"
    expect(v.practices[0].feePct).toBe(0);
  });

  it('returns the brands, for the shell header', async () => {
    const v = await run();
    if (v.kind !== 'brand') throw new Error('expected brand');
    expect(v.brands).toEqual([{ id: 'g1', name: 'Bright Smiles', logoUrl: 'https://x/logo.png' }]);
  });

  it('de-duplicates group ids — a doubled membership row must not double the .in()', async () => {
    const state = world({
      practice_group_members: [
        { group_id: 'g1', user_id: 'me', active: true },
        { group_id: 'g1', user_id: 'me', active: true },
      ],
    });
    const v = await run(state);
    if (v.kind !== 'brand') throw new Error('expected brand');
    expect(v.groupIds).toEqual(['g1']);
  });
});

// ─── Adversarial: cross-brand isolation ──────────────────────────────────

describe('adversarial — a brand admin never sees another group\'s practices', () => {
  it('g2\'s practices are absent for a g1 admin, however many exist', async () => {
    const state = world({
      practices: [
        practice('p1', 'g1'),
        practice('p2', 'g1'),
        practice('theirs-1', 'g2'),
        practice('theirs-2', 'g2'),
      ],
    });
    const v = await run(state);
    if (v.kind !== 'brand') throw new Error('expected brand');
    expect(v.practices.map((p) => p.id)).toEqual(['p1', 'p2']);
    expect(JSON.stringify(v)).not.toContain('theirs');
    expect(JSON.stringify(v)).not.toContain('g2');
    expect(JSON.stringify(v)).not.toContain('Someone Else');
  });

  it('the practices query is scoped by the caller\'s OWN group ids, always', async () => {
    const seen: string[][] = [];
    const c = makeClient(world(), seen);
    await resolveBrandViewer(c, c, 'me');
    const practiceQuery = seen.find((s) => s[0] === 'practices');
    expect(practiceQuery).toEqual(['practices', 'group_id in [g1]']);
  });

  it('membership is read BEFORE any data query — never after', async () => {
    const seen: string[][] = [];
    const c = makeClient(world(), seen);
    await resolveBrandViewer(c, c, 'me');
    expect(seen[0][0]).toBe('practice_group_members');
  });

  it('a g2 admin sees g2 only — the mirror case, so the filter is not one-directional', async () => {
    const state = world({
      practice_group_members: [{ group_id: 'g2', user_id: 'me', active: true }],
      practices: [practice('p1', 'g1'), practice('t1', 'g2'), practice('t2', 'g2')],
    });
    const v = await run(state);
    if (v.kind !== 'brand') throw new Error('expected brand');
    expect(v.practices.map((p) => p.id)).toEqual(['t1', 't2']);
    expect(JSON.stringify(v)).not.toContain('Bright Smiles');
  });
});

// ─── Source pins ─────────────────────────────────────────────────────────

describe('source pins', () => {
  const SRC  = readFileSync(resolve(process.cwd(), 'lib/brand/brandViewer.ts'), 'utf8');
  const code = stripComments(SRC);

  it('reads authority through the CALLER\'s client and data through service-role', () => {
    const authIdx = code.indexOf("supabase\n    .from('practice_group_members')");
    expect(authIdx).toBeGreaterThan(0);
    // The two data reads go through `svc`, never through `supabase`.
    expect(code).toMatch(/svc\s*\n?\s*\.from\('practices'\)/);
    expect(code).toMatch(/svc\s*\n?\s*\.from\('practice_groups'\)/);
    expect(code).not.toMatch(/supabase\s*\n?\s*\.from\('practices'\)/);
  });

  it('scopes practices by an .in() over the resolved group ids', () => {
    expect(code).toMatch(/\.in\('group_id', groupIds\)/);
  });

  it('does not redirect — the page owns that', () => {
    // A lib that redirects cannot be unit-tested without a request scope, and
    // the n rule is exactly the thing worth testing directly.
    expect(code).not.toMatch(/redirect\(/);
    expect(code).not.toMatch(/next\/navigation/);
  });

  it('makes no authority decision beyond the membership read', () => {
    expect(code).not.toMatch(/can_manage_practice/);
    expect(code).not.toMatch(/practice_members/);
  });
});
