import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';

// ─── Guard: no source-text test may read a file that does not exist ─────
//
// WHY THIS EXISTS — a real failure that hid behind two reported "green" runs.
//
// This repo has ~300 test files and a great many are SOURCE-TEXT tests: they
// read a source file at MODULE level and assert on its text. That idiom has
// one nasty property. If the file being read is renamed or deleted, the read
// throws while the module is being imported, so the test file never COLLECTS
// — and a file that never collects contributes ZERO failing tests, because
// none of its tests ever ran.
//
// Vitest reports that honestly, but on the line most readers skip:
//
//     Test Files  3 failed | 296 passed (299)
//     Tests       5228 passed (5228)        <-- looks perfect
//
// The exit code is correct and non-zero. But anyone reading the Tests line —
// the line that looks like the verdict — sees an unbroken green run. That is
// exactly what happened: deleting app/patient/account/AccountAccordion.tsx
// stopped three files from running, and the breakage survived several merges
// while being reported as green.
//
// The worst part was WHICH tests stopped. One of the three was
// app/patient-address-removed.test.ts, which carries the POPIA "no address
// fields anywhere" invariant. That guarantee was not passing — it was ABSENT,
// which is strictly worse than failing, because failing is visible.
//
// WHAT THIS FIXES
//
// This converts that class of breakage from an invisible collection error
// into an ordinary failing assertion: a missing read target now appears in
// the "Tests" line, in the reporter's failure list, naming the offending test
// file and the path it wanted. The loud failure mode is the entire point.
//
// It cannot protect ITSELF by the same means, so it reads no fixed source
// file — it only walks directories — and the COVERAGE FLOOR block at the end
// fails if the scan silently stops finding things, which is this guard's own
// way of going quietly wrong.

const ROOT = resolve(process.cwd());

/** This file, excluded from its own scan — the prose above contains example
 *  read calls, and matching them would be a permanent false positive. The
 *  coverage floor asserts this path still exists, so renaming the file
 *  without updating this constant fails loudly rather than silently
 *  disabling the exclusion. */
const SELF = join('app', 'test-path-integrity.test.ts');

// Directories holding test files. `scripts` is included: it has its own
// *.test.ts files that read migrations.
const SCAN_DIRS = ['app', 'lib', 'components', 'supabase', 'scripts'];

// What makes a string literal recognisably a path to a repo file — this is
// what separates read('app/x/Y.tsx') from an unrelated readValue('some-key').
const PATHY = /\.(tsx?|jsx?|css|sql|json|mjs|cjs|md)$/;

function testFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(resolve(ROOT, dir))) {
      // node_modules for obvious reasons; ds-bundle is generated design-sync
      // output and is gitignored.
      if (entry === 'node_modules' || entry === 'ds-bundle' || entry.startsWith('.')) continue;
      const rel = join(dir, entry);
      if (statSync(resolve(ROOT, rel)).isDirectory()) { walk(rel); continue; }
      if (/\.test\.(ts|tsx)$/.test(entry)) out.push(rel);
    }
  };
  for (const d of SCAN_DIRS) if (existsSync(resolve(ROOT, d))) walk(d);
  return out;
}

// ── Extracting read targets ────────────────────────────────────────────
//
// ONLY call shapes that actually READ A FILE are considered. This matters:
// several tests legitimately name paths that must NOT exist —
// existsSync(resolve(ROOT, 'app/patient/profile/AddressForm.tsx')) asserting a
// deleted component is gone, or route-shape invariants naming
// 'app/practice/bills/[...slug]/page.tsx' to prove that catch-all form is
// unused. Matching every path-shaped literal instead was measured against
// this repo: 25 hits, only 3 real, the other 22 being those deliberate
// references. Scoping to read calls gave exactly the 3 real breakages and no
// false positives.

// read('path') / readSql("path") / readFileSync('path') — quoted, not template.
const DIRECT = /\bread[A-Za-z]*\(\s*(['"])([^'"\n]+)\1/g;
// readFileSync(resolve(ROOT, 'path')) / resolve(process.cwd(), 'path')
const VIA_RESOLVE = /\bread[A-Za-z]*\(\s*resolve\([^,)]*,\s*(['"])([^'"\n]+)\1/g;
// Template reads, with or without interpolation:
//   readSql(`supabase/migrations/${MIG_NAME}`)
//   readFileSync(resolve(ROOT, `app/onboarding/${step}/page.tsx`), 'utf8')
const TEMPLATE = /\bread[A-Za-z]*\(\s*(?:resolve\([^,)]*,\s*)?`([^`\n]+)`/g;

/** Substitute `${IDENT}` from a same-file `const IDENT = '…'` declaration. */
function resolveTemplate(tpl: string, src: string): string | null {
  let out = tpl;
  for (const m of tpl.matchAll(/\$\{([A-Za-z_$][\w$]*)\}/g)) {
    const decl = new RegExp(`\\b(?:const|let|var)\\s+${m[1]}\\s*=\\s*(['"])([^'"\\n]+)\\1`);
    const hit = decl.exec(src);
    if (!hit) return null;              // e.g. a loop variable — unresolvable
    out = out.replace(m[0], hit[2]);
  }
  return /\$\{/.test(out) ? null : out;
}

type Target = { test: string; path: string };

function collect() {
  const exact: Target[] = [];    // fully resolved — existence is checkable
  const partial: Target[] = [];  // interpolated — only the static prefix is

  for (const file of testFiles()) {
    if (file === SELF) continue;
    const src = readFileSync(resolve(ROOT, file), 'utf8');

    for (const re of [DIRECT, VIA_RESOLVE]) {
      for (const m of src.matchAll(re)) {
        const p = m[2];
        if (!PATHY.test(p)) continue;
        if (p.startsWith('.') || p.startsWith('/') || /^[A-Za-z]:/.test(p)) continue;
        exact.push({ test: file, path: p });
      }
    }

    for (const m of src.matchAll(TEMPLATE)) {
      const tpl = m[1];
      const got = resolveTemplate(tpl, src);
      if (got != null) {
        if (PATHY.test(got)) exact.push({ test: file, path: got });
      } else if (PATHY.test(tpl)) {
        partial.push({ test: file, path: tpl });
      }
    }
  }

  return { exact, partial };
}

const { exact, partial } = collect();

const dedupe = (t: Target[]) =>
  [...new Set(t.map((x) => `${x.test}  ->  ${x.path}`))].sort();

describe('source-text tests only read files that exist', () => {
  it('every fully-resolved read target is a real file', () => {
    const missing = dedupe(exact.filter((t) => !existsSync(resolve(ROOT, t.path))));

    // The message carries the offending test AND the path it wanted, so the
    // fix needs no investigation beyond reading the failure.
    expect(
      missing,
      missing.length
        ? `\n\n${missing.length} source-text test read(s) point at a file that does not exist.\n`
          + 'Each would otherwise be an INVISIBLE collection error: the test file\n'
          + 'would not run at all, and the summary would still report every test\n'
          + 'as passing. Re-point the read at the successor file, or remove the\n'
          + 'assertion if what it protected is genuinely gone.\n\n'
          + missing.map((m) => `  ${m}`).join('\n') + '\n'
        : undefined,
    ).toEqual([]);
  });

  it('every interpolated read target has a real static prefix', () => {
    // A template read whose interpolation is a LOOP VARIABLE cannot be
    // resolved without executing the test, so full coverage is impossible
    // here. Rather than allowlisting those sites — an allowlist rots, and
    // hides the next one — this asserts the part that IS static: the
    // directory above the first ${…}. That still catches a wholesale rename
    // or removal of the directory, which is the realistic breakage.
    const broken = dedupe(
      partial.filter((t) => {
        const staticPrefix = t.path.slice(0, t.path.indexOf('${'));
        const dir = dirname(staticPrefix.endsWith('/') ? staticPrefix + 'x' : staticPrefix);
        return !existsSync(resolve(ROOT, dir));
      }),
    );

    expect(
      broken,
      broken.length
        ? `interpolated read target(s) whose directory no longer exists:\n${broken.join('\n')}`
        : undefined,
    ).toEqual([]);
  });
});

describe('COVERAGE FLOOR — this guard cannot pass vacuously', () => {
  // A scanner that silently stops matching is worse than no scanner: it
  // reports green while checking nothing. These floors sit well below the
  // measured values (299 test files, 400+ read targets when written) so
  // ordinary churn never trips them, but a broken regex or walker will.
  it('scanned a plausible number of test files', () => {
    expect(testFiles().length).toBeGreaterThan(150);
  });

  it('extracted a plausible number of read targets', () => {
    expect(exact.length).toBeGreaterThan(250);
  });

  it('all three extraction shapes still match something real', () => {
    // Proves each pattern earns its place, so a broken one cannot hide
    // behind the other two.
    const files = testFiles().filter((f) => f !== SELF)
      .map((f) => readFileSync(resolve(ROOT, f), 'utf8'));
    const matches = (re: RegExp) => files.some((s) => new RegExp(re.source).test(s));
    expect({
      direct:   matches(DIRECT),
      resolve:  matches(VIA_RESOLVE),
      template: matches(TEMPLATE),
    }).toEqual({ direct: true, resolve: true, template: true });
  });

  it('the self-exclusion still points at this file', () => {
    // If this file is renamed, the SELF constant goes stale and would
    // silently stop excluding it — reintroducing false positives from the
    // example read calls in the prose above.
    expect(existsSync(resolve(ROOT, SELF))).toBe(true);
  });
});
