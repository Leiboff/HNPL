import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── /admin/practices/[id] — server-side admin authorization ────────────────
//
// The detail route is one of the most-sensitive admin surfaces — full
// practice identity, banking, owner, members. Hiding it in the UI is
// not enough; a non-admin who types the URL directly must be rejected
// server-side. This regression locks the auth pattern into source so
// a future refactor can't silently drop the check.
//
// Two layers are required:
//   1. The /admin layout already runs requireConfirmedUser + admin-role
//      check (locked elsewhere by the layout's own tests).
//   2. The detail page itself runs the same admin-role check + redirect
//      so it survives any future change that bypasses or splits the
//      layout (e.g. moving the route into a different route group).

const ROOT = resolve(process.cwd());
const detail = readFileSync(resolve(ROOT, 'app/admin/practices/[id]/page.tsx'), 'utf8');
const layout = readFileSync(resolve(ROOT, 'app/admin/layout.tsx'), 'utf8');

describe('admin practices detail route — auth pattern', () => {
  it('detail page imports requireConfirmedUser', () => {
    expect(detail).toMatch(/from\s+['"]@\/lib\/auth\/requireConfirmedUser['"]/);
    expect(detail).toMatch(/await\s+requireConfirmedUser\s*\(/);
  });

  it('detail page checks profile.role !== "admin" and redirects', () => {
    expect(detail).toMatch(/profile\?\.role\s*!==\s*['"]admin['"]/);
    expect(detail).toMatch(/redirect\s*\(/);
  });

  it('detail page reads profile.role from the profiles table for the current user', () => {
    expect(detail).toMatch(/\.from\(\s*['"]profiles['"]\s*\)/);
    expect(detail).toMatch(/\.select\(\s*['"]role['"]\s*\)/);
    expect(detail).toMatch(/\.eq\(\s*['"]id['"]\s*,\s*user\.id\s*\)/);
  });

  it('detail page guards each non-admin role with the role-appropriate redirect target', () => {
    expect(detail).toMatch(/role\s*===\s*['"]patient['"][\s\S]*?redirect\(\s*['"]\/patient['"]\s*\)/);
    expect(detail).toMatch(/role\s*===\s*['"]practice_admin['"][\s\S]*?redirect\(\s*['"]\/practice['"]\s*\)/);
    expect(detail).toMatch(/role\s*===\s*['"]practice_provider['"][\s\S]*?redirect\(\s*['"]\/provider['"]\s*\)/);
    expect(detail).toMatch(/redirect\(\s*['"]\/login['"]\s*\)/);
  });

  it('parent /admin layout runs the same admin-role check (layer 1)', () => {
    expect(layout).toMatch(/profile\?\.role\s*!==\s*['"]admin['"]/);
    expect(layout).toMatch(/await\s+requireConfirmedUser\s*\(/);
  });
});
