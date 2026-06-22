import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Admin authorization on the approval actions ─────────────────────────────
//
// Both approvePractice and suspendPractice must reject any caller who is
// not a platform admin (profiles.role !== 'admin'). Server-side check —
// hiding the admin-portal UI is necessary but not sufficient.

const profileRole: { value: string | null } = { value: null };
const userId: { value: string | null } = { value: 'admin-1' };
const updates: Array<{ table: string; row: unknown }> = [];

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

// Session client — used by guardAdmin() to read the caller's role.
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: {
      getUser: async () => ({
        data: { user: userId.value ? { id: userId.value } : null },
        error: null,
      }),
    },
    from(_table: string) {
      function selectChain() {
        return {
          eq: () => selectChain(),
          single: async () => ({
            data: profileRole.value ? { role: profileRole.value } : null,
            error: null,
          }),
          maybeSingle: async () => ({ data: null, error: null }),
        };
      }
      return {
        select: selectChain,
        // Session client should NOT be writing to practices any more — the
        // post-0054 code routes the UPDATE through the service-role mock
        // below. A session-client update would be a regression.
        update: (_row: unknown) => ({
          eq: () => Promise.resolve({ data: null, error: { message: 'session-client UPDATE not allowed' } }),
        }),
      };
    },
  })),
}));

// Service-role client — the post-0054 path for practices UPDATE writes.
// Migration 0054's protect_practices_columns() trigger lets these pass
// because auth.role() = 'service_role' inside the trigger when the
// service-role key is used. The mock records every update so the
// assertions below can check the row shape unchanged.
vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    from(table: string) {
      return {
        update: (row: unknown) => ({
          eq: () => {
            updates.push({ table, row });
            return Promise.resolve({ data: null, error: null });
          },
        }),
      };
    },
  })),
}));

beforeEach(() => {
  updates.length = 0;
  profileRole.value = null;
  userId.value = 'admin-1';
});

import { approvePractice, suspendPractice } from './actions';

describe('approvePractice — admin auth', () => {
  it('rejects an unauthenticated caller', async () => {
    userId.value = null;
    const result = await approvePractice('p1');
    expect(result.error).toBe('Not authenticated.');
    expect(updates).toHaveLength(0);
  });

  it('rejects a non-admin caller', async () => {
    profileRole.value = 'practice_admin';
    const result = await approvePractice('p1');
    expect(result.error).toBe('Unauthorized.');
    expect(updates).toHaveLength(0);
  });

  it('rejects a patient caller', async () => {
    profileRole.value = 'patient';
    const result = await approvePractice('p1');
    expect(result.error).toBe('Unauthorized.');
    expect(updates).toHaveLength(0);
  });

  it('writes status="approved" + audit columns when caller is admin', async () => {
    profileRole.value = 'admin';
    const result = await approvePractice('p1');
    expect(result.error).toBeNull();
    expect(updates).toHaveLength(1);
    const u = updates[0];
    expect(u.table).toBe('practices');
    const row = u.row as { status: string; approved_at: string; approved_by: string };
    expect(row.status).toBe('approved');
    expect(row.approved_by).toBe('admin-1');
    expect(row.approved_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe('suspendPractice — admin auth', () => {
  it('rejects a non-admin caller', async () => {
    profileRole.value = 'practice_admin';
    const result = await suspendPractice('p1');
    expect(result.error).toBe('Unauthorized.');
    expect(updates).toHaveLength(0);
  });

  it('writes status="suspended" without touching approved_at/by', async () => {
    profileRole.value = 'admin';
    const result = await suspendPractice('p1');
    expect(result.error).toBeNull();
    expect(updates).toHaveLength(1);
    const row = updates[0].row as Record<string, unknown>;
    expect(row.status).toBe('suspended');
    expect(row).not.toHaveProperty('approved_at');
    expect(row).not.toHaveProperty('approved_by');
  });
});
