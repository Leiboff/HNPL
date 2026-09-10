// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
const MIG = readFileSync(resolve(process.cwd(), 'supabase/migrations/0154_onboarding_events.sql'), 'utf8');
const USER = '00000000-0000-0000-0000-000000000001';
let db: PGlite;
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls; create table profiles(id uuid primary key); insert into profiles values ('${USER}'); create function is_platform_admin() returns boolean language sql stable as $$ select false $$; grant usage on schema public to anon,authenticated,service_role;`);
  await db.exec(MIG);
});
afterAll(async () => db.close());
async function role(sql: string, name: string) { await db.exec(`set role ${name}`); try { return await db.query(sql); } finally { await db.exec('reset role'); } }
describe('0154 onboarding event security and validation', () => {
  it('allows service insertion of valid view, attempt, success and failure events', async () => {
    await role(`insert into onboarding_events(user_id,step,event_type,outcome,error_code) values ('${USER}','phone','phone_viewed',null,null),('${USER}','phone','phone_submit_started','started',null),('${USER}','phone','phone_saved','success',null),('${USER}','phone','phone_submit_failed','failure','network_error')`, 'service_role');
    expect((await role('select * from onboarding_events', 'service_role')).rows).toHaveLength(4);
  });
  it('rejects arbitrary event names and sensitive metadata keys', async () => {
    await expect(role(`insert into onboarding_events(user_id,step,event_type) values ('${USER}','phone','made_up')`, 'service_role')).rejects.toThrow();
    await expect(role(`insert into onboarding_events(user_id,step,event_type,metadata) values ('${USER}','phone','phone_viewed','{"phone":"082"}')`, 'service_role')).rejects.toThrow();
  });
  it('denies normal-client reads and all writes', async () => {
    expect((await role('select * from onboarding_events', 'authenticated')).rows).toEqual([]);
    await expect(role(`insert into onboarding_events(user_id,step,event_type) values ('${USER}','phone','phone_viewed')`, 'authenticated')).rejects.toThrow(/permission denied/i);
    await expect(role('update onboarding_events set outcome=null', 'authenticated')).rejects.toThrow(/permission denied/i);
    await expect(role('delete from onboarding_events', 'authenticated')).rejects.toThrow(/permission denied/i);
  });
  it('deduplicates webhook terminal delivery keys', async () => {
    await role(`insert into onboarding_events(user_id,step,event_type,dedupe_key) values ('${USER}','identity','identity_approved','didit-terminal:e1') on conflict(dedupe_key) do nothing`, 'service_role');
    await role(`insert into onboarding_events(user_id,step,event_type,dedupe_key) values ('${USER}','identity','identity_approved','didit-terminal:e1') on conflict(dedupe_key) do nothing`, 'service_role');
    const rows = await role(`select * from onboarding_events where dedupe_key='didit-terminal:e1'`, 'service_role');
    expect(rows.rows).toHaveLength(1);
  });
});
