// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

// ─── Real RPC execution — accept_practice_invitation (Phase 2 2.3) ────
//
// Phase 2's "close the loop to the platform" item asks for
// crm_leads.converted_practice_id to populate when Mark signed →
// invite's practice gets created, reconciled at practice-creation
// time, idempotent, and never mis-linked by a name match. All of that
// is ALREADY implemented — this RPC (0069, hardened in 0070) does
// exactly this, called from app/signup/practice/actions.ts:333. This
// suite proves it does what the spec asks, running the ACTUAL function
// body loaded verbatim from the migration file, rather than re-reading
// the SQL and trusting it.

const MIG = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/0070_crm_conversion_hardening.sql'), 'utf8',
).replace(/\r\n/g, '\n');

function fnSql(name: string): string {
  const start = MIG.indexOf(`CREATE OR REPLACE FUNCTION ${name}`);
  if (start < 0) throw new Error(`function ${name} not found in migration`);
  const end = MIG.indexOf('$$;', start);
  return MIG.slice(start, end + 3);
}

const BASE = `
  create schema if not exists auth;
  create table _current_role (role text);
  create table _current_user (id uuid);
  create or replace function auth.uid() returns uuid
    language sql stable as $$ select id from _current_user limit 1 $$;
  create or replace function auth.role() returns text
    language sql stable as $$ select coalesce((select role from _current_role limit 1), 'service_role') $$;

  create table crm_leads (
    id uuid primary key default gen_random_uuid(),
    practice_name text not null,
    converted_practice_id uuid
  );
  create table practices (
    id uuid primary key default gen_random_uuid(),
    name text, owner_id uuid
  );
  create table practice_members (
    id uuid primary key default gen_random_uuid(),
    practice_id uuid, user_id uuid, active boolean default true
  );
  create table practice_invitations (
    id uuid primary key default gen_random_uuid(),
    token text unique not null,
    lead_id uuid references crm_leads(id),
    accepted_at timestamptz,
    accepted_by_practice_id uuid,
    expires_at timestamptz not null default (now() + interval '7 days')
  );
`;

let db: PGlite;
const q = <T = Record<string, unknown>>(sql: string, p: unknown[] = []) => db.query<T>(sql, p);

beforeEach(async () => {
  db = new PGlite();
  await db.exec(BASE);
  await db.exec(fnSql('accept_practice_invitation'));
});

describe('7. Mark signed → invite reconciliation', () => {
  it('populates converted_practice_id once the practice exists', async () => {
    const lead = (await q<{ id: string }>(`insert into crm_leads (practice_name) values ('Acme Dental') returning id`)).rows[0].id;
    await q(`insert into practice_invitations (token, lead_id) values ('tok-1', $1)`, [lead]);
    const practice = (await q<{ id: string }>(`insert into practices (name) values ('Acme Dental') returning id`)).rows[0].id;

    await q(`select accept_practice_invitation('tok-1', $1)`, [practice]);

    const { rows } = await q<{ converted_practice_id: string }>(`select converted_practice_id from crm_leads where id = $1`, [lead]);
    expect(rows[0].converted_practice_id).toBe(practice);
  });

  it('is idempotent — calling it twice with the same token links exactly once', async () => {
    const lead = (await q<{ id: string }>(`insert into crm_leads (practice_name) values ('Idempotent Practice') returning id`)).rows[0].id;
    await q(`insert into practice_invitations (token, lead_id) values ('tok-idem', $1)`, [lead]);
    const practice = (await q<{ id: string }>(`insert into practices (name) values ('Idempotent Practice') returning id`)).rows[0].id;

    const r1 = await q<{ accept_practice_invitation: string | null }>(`select accept_practice_invitation('tok-idem', $1)`, [practice]);
    const r2 = await q<{ accept_practice_invitation: string | null }>(`select accept_practice_invitation('tok-idem', $1)`, [practice]);

    expect(r1.rows[0].accept_practice_invitation).toBe(lead); // first call links
    expect(r2.rows[0].accept_practice_invitation).toBeNull(); // second call is a no-op (token already accepted)

    const { rows } = await q<{ n: string }>(`select count(*)::text as n from crm_leads where converted_practice_id = $1`, [practice]);
    expect(rows[0].n).toBe('1'); // linked exactly once, not double-counted
  });

  it('8. adversarial — two practices with identical names do not cause a mis-linked converted_practice_id', async () => {
    const leadA = (await q<{ id: string }>(`insert into crm_leads (practice_name) values ('Same Name Dental') returning id`)).rows[0].id;
    const leadB = (await q<{ id: string }>(`insert into crm_leads (practice_name) values ('Same Name Dental') returning id`)).rows[0].id;
    await q(`insert into practice_invitations (token, lead_id) values ('tok-a', $1)`, [leadA]);
    await q(`insert into practice_invitations (token, lead_id) values ('tok-b', $1)`, [leadB]);

    const practiceA = (await q<{ id: string }>(`insert into practices (name) values ('Same Name Dental') returning id`)).rows[0].id;
    const practiceB = (await q<{ id: string }>(`insert into practices (name) values ('Same Name Dental') returning id`)).rows[0].id;

    // Only token-B redeems, against practiceB — linkage is keyed on the
    // token→lead_id chain, never on a name lookup, so leadA must stay
    // unlinked even though its practice_name matches practiceA exactly.
    await q(`select accept_practice_invitation('tok-b', $1)`, [practiceB]);

    const { rows } = await q<{ id: string; converted_practice_id: string | null }>(
      `select id, converted_practice_id from crm_leads order by practice_name`);
    const byId = new Map(rows.map(r => [r.id, r.converted_practice_id]));
    expect(byId.get(leadB)).toBe(practiceB);
    expect(byId.get(leadA)).toBeNull();
  });

  it('adversarial — an expired invitation token does not link', async () => {
    const lead = (await q<{ id: string }>(`insert into crm_leads (practice_name) values ('Expired Practice') returning id`)).rows[0].id;
    await q(`insert into practice_invitations (token, lead_id, expires_at) values ('tok-expired', $1, now() - interval '1 day')`, [lead]);
    const practice = (await q<{ id: string }>(`insert into practices (name) values ('Expired Practice') returning id`)).rows[0].id;

    await q(`select accept_practice_invitation('tok-expired', $1)`, [practice]);

    const { rows } = await q<{ converted_practice_id: string | null }>(`select converted_practice_id from crm_leads where id = $1`, [lead]);
    expect(rows[0].converted_practice_id).toBeNull();
  });
});
