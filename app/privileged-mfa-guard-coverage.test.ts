import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stripComments } from '@/lib/testing/stripComments';

// ─── Named test 10 — every privileged server action calls requireAAL2, ──
//     before it chooses its Supabase client
//
// The guard rots the instant a new privileged action ships without it, and
// nothing about the rendered output would reveal the omission — so the
// coverage is pinned structurally, exactly as the 27 authority-ordering
// tests pin authority-before-data. This is the file that fails when someone
// adds an eighth privileged operation and forgets the guard.
//
// Two properties per privileged action:
//   • requireAAL2('<tier>') is present in the function body.
//   • it runs AFTER the role/authority guard and BEFORE the first write or
//     service-client construction — which is what makes the service-role
//     bypass (named test 7) impossible: the guard is upstream of the client
//     choice, so switching to the RLS-bypassing client cannot skip it.
//
// The "fails when a new action is added" mechanism: each privileged action
// FILE has its full set of exported async functions enumerated below. If a
// new export appears that is not classified as privileged-with-a-tier or as
// a known non-privileged action, the drift test fails until it is
// classified — forcing the author to decide whether it needs the guard.

const ROOT = resolve(process.cwd());
const read = (p: string) => stripComments(readFileSync(resolve(ROOT, p), 'utf8'));

type Tier = 'standard' | 'critical';

type PrivAction = { file: string; fn: string; tier: Tier };

// The seven privileged operations, mapped to the concrete server actions
// that perform them on the admin / sales (in-scope) surface.
const PRIVILEGED: PrivAction[] = [
  { file: 'app/admin/practices/actions.ts', fn: 'approvePractice',          tier: 'standard' }, // merchant approval
  { file: 'app/admin/practices/actions.ts', fn: 'suspendPractice',          tier: 'standard' }, // merchant suspension
  { file: 'app/admin/_lib/auditActions.ts', fn: 'changePracticeFeePercent', tier: 'standard' }, // fee change
  { file: 'app/admin/payouts/actions.ts',   fn: 'markBatchPaid',            tier: 'critical' }, // payout settlement
  { file: 'app/admin/payouts/actions.ts',   fn: 'markPayoutPaid',           tier: 'critical' }, // payout settlement
  { file: 'app/admin/collections/actions.ts', fn: 'retryCollection',        tier: 'standard' }, // collection retry
  { file: 'app/admin/sales-team/actions.ts', fn: 'grantSalesRole',          tier: 'critical' }, // role grant
  { file: 'app/admin/sales-team/actions.ts', fn: 'revokeSalesRole',         tier: 'critical' }, // role grant
  { file: 'app/admin/groups/actions.ts',    fn: 'createGroup',              tier: 'critical' }, // banking (on create)
  { file: 'app/admin/groups/actions.ts',    fn: 'updateGroupBanking',       tier: 'critical' }, // banking change
  { file: 'app/admin/groups/actions.ts',    fn: 'assignPracticeToGroup',    tier: 'standard' }, // privileged practice move
  { file: 'app/admin/groups/actions.ts',    fn: 'grantBrandAdmin',          tier: 'critical' }, // role grant
  { file: 'app/admin/groups/actions.ts',    fn: 'revokeBrandAdmin',         tier: 'critical' }, // role grant
];

// Non-privileged exported actions in the same files — deliberately NOT
// guarded, and listed so the drift test knows they are accounted for. If
// one of these ever starts performing one of the seven operations, moving
// it here is a conscious act.
const NON_PRIVILEGED: Record<string, string[]> = {
  'app/admin/practices/actions.ts': [
    'updatePracticeAddressFromPlace', 'setPracticeCoordinates', 'clearPracticeCoordinates',
  ],
  'app/admin/_lib/auditActions.ts': ['addNote'],
  'app/admin/payouts/actions.ts':   [],
  'app/admin/collections/actions.ts': [],
  'app/admin/sales-team/actions.ts': [],
  'app/admin/groups/actions.ts':    [],
};

/** Slice a file into { fnName -> body } by `export async function` boundaries. */
function exportedFunctions(src: string): Map<string, string> {
  const re = /export async function (\w+)/g;
  const marks: Array<{ name: string; at: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) marks.push({ name: m[1], at: m.index });
  const out = new Map<string, string>();
  for (let i = 0; i < marks.length; i++) {
    const start = marks[i].at;
    const end = i + 1 < marks.length ? marks[i + 1].at : src.length;
    out.set(marks[i].name, src.slice(start, end));
  }
  return out;
}

const WRITE_MARKERS = [
  'svc(',
  'createServiceClient(',
  'attemptChargeInstalment(',
  '.update(',
  '.insert(',
  '.upsert(',
];

const GUARD_MARKERS = ['guardAdmin(', 'guardSalesOrAdmin(', 'requireConfirmedUser('];

describe('[named 10] every privileged action guards with requireAAL2', () => {
  it.each(PRIVILEGED.map((p) => [`${p.fn} (${p.file})`, p] as const))(
    '%s calls requireAAL2 with the right tier',
    (_label, p) => {
      const body = exportedFunctions(read(p.file)).get(p.fn);
      expect(body, `${p.fn} is an exported async function in ${p.file}`).toBeDefined();
      expect(body!).toContain(`requireAAL2('${p.tier}')`);
    },
  );

  it.each(PRIVILEGED.map((p) => [`${p.fn} (${p.file})`, p] as const))(
    '%s runs the guard AFTER authority and BEFORE the write/client choice',
    (_label, p) => {
      const body = exportedFunctions(read(p.file)).get(p.fn)!;
      const guardAt = body.indexOf('requireAAL2(');
      expect(guardAt, 'requireAAL2 present').toBeGreaterThan(-1);

      // Authority (role gate) precedes assurance.
      const authAt = Math.min(
        ...GUARD_MARKERS.map((g) => body.indexOf(g)).filter((i) => i > -1),
      );
      expect(authAt, 'an authority guard precedes requireAAL2').toBeGreaterThan(-1);
      expect(authAt).toBeLessThan(guardAt);

      // The write / service-client construction comes AFTER the guard.
      const writeAt = Math.min(
        ...WRITE_MARKERS.map((w) => body.indexOf(w)).filter((i) => i > -1),
      );
      expect(writeAt, 'the action performs a write').toBeGreaterThan(-1);
      expect(guardAt, 'requireAAL2 precedes the first write/client construction').toBeLessThan(writeAt);
    },
  );
});

describe('[named 7] the guard is upstream of the service-role client', () => {
  // The service-role client bypasses RLS, so a guard that ran after it was
  // constructed would be no guard at all. For every privileged action that
  // constructs a service-role client, requireAAL2 must precede that
  // construction — proved above by the ordering test, restated here as the
  // property it defends.
  it.each(
    PRIVILEGED
      .map((p) => [p, exportedFunctions(read(p.file)).get(p.fn)!] as const)
      .filter(([, body]) => body.includes('svc(') || body.includes('createServiceClient(')),
  )('%s constructs the service client only after requireAAL2', (_p, body) => {
    const guardAt = body.indexOf('requireAAL2(');
    const svcAt = Math.min(
      ...['svc(', 'createServiceClient('].map((w) => body.indexOf(w)).filter((i) => i > -1),
    );
    expect(guardAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(svcAt);
  });
});

describe('[named 10 drift] no privileged action file gains an unclassified export', () => {
  const FILES = Object.keys(NON_PRIVILEGED);
  it.each(FILES)('%s: every exported async action is classified', (file) => {
    const names = [...exportedFunctions(read(file)).keys()];
    const known = new Set<string>([
      ...PRIVILEGED.filter((p) => p.file === file).map((p) => p.fn),
      ...(NON_PRIVILEGED[file] ?? []),
    ]);
    const unclassified = names.filter((n) => !known.has(n));
    expect(
      unclassified,
      `New exported action(s) in ${file}: ${unclassified.join(', ')}. ` +
      'Classify each as privileged (add to PRIVILEGED with a tier + requireAAL2) ' +
      'or non-privileged (add to NON_PRIVILEGED).',
    ).toEqual([]);
  });
});

describe('the PII page gate is wired on both customer surfaces', () => {
  // Customer-PII access is a page-level operation, not a server action, so
  // its guard is requireAAL2Page rather than requireAAL2. Pinned here so the
  // seventh operation cannot lose its guard in a page refactor.
  it.each([
    'app/admin/customers/page.tsx',
    'app/admin/customers/[patientId]/page.tsx',
  ])('%s calls requireAAL2Page after the role gate', (file) => {
    const src = read(file);
    const roleAt  = src.indexOf("profile?.role !== 'admin'");
    const gateAt  = src.indexOf('requireAAL2Page(');
    expect(gateAt, 'requireAAL2Page present').toBeGreaterThan(-1);
    expect(roleAt, 'role gate present').toBeGreaterThan(-1);
    expect(gateAt).toBeGreaterThan(roleAt);
  });
});
