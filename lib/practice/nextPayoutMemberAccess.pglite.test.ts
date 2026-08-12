// @vitest-environment node
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { resolveNextPayout } from './nextPayout';
import { SAST_OFFSET, sastMidnight } from '@/lib/payments/payoutWindow';

// ─── THE VERIFICATION THIS WORK WAS BLOCKED ON ──────────────────────────
//
// Question: after 0092, does an ORDINARY MEMBER (can_manage_practice = false)
// actually see real plan lines in the hero — in both the closed-batch and the
// open-window state — rather than the plansHidden framing that only ever
// applied under the old manager-only policy?
//
// Answering it needs three things a unit test cannot fake:
//   1. resolveNextPayout driven for real, not a stub.
//   2. RLS ACTUALLY ENFORCED. Every query below runs as a non-superuser role;
//      pglite's default role bypasses RLS unconditionally, so a suite that ran
//      as superuser would answer "yes" before 0092 as loudly as after.
//   3. The joins the plan lines depend on, under their real policies. A plan
//      line carries a patient label and an invoice number, which come from
//      plans and profiles — so proving the payouts read succeeds is not enough
//      on its own:
//        plans    practice_members_select_plans  is_practice_member (0002)
//        profiles see the note below (0093)
//      Their real policies are installed below rather than assumed.
//
// RE-BASELINED ONTO 0093
// ──────────────────────
// This file used to install 0006's practice_members_select_patient_profiles
// inline. That policy no longer exists in the repo and NEVER existed in
// production — 0093 back-ported the two correctly-scoped policies production
// actually had. Verifying patient-name resolution against a policy that exists
// nowhere proved nothing about either environment, so 0093 is now executed
// VERBATIM alongside 0090 and 0092.
//
// The fixture role changed with it, and that matters more than it looks.
// 0093's practice-side policy uses is_practice_admin(), which is ROLE-based
// (practice_members.role = 'admin'), NOT is_practice_manager /
// can_manage_practice. This file previously seeded role = 'staff' — a value
// the CHECK constraint permits but which NO code path in the app ever writes:
// inviteMemberIntoPractice assigns role = isProvider ? 'provider' : 'admin'
// (lib/brand/inviteMember.ts), so a reception-level member IS role = 'admin'
// with can_manage_practice = false. Seeding 'staff' modelled a user that
// cannot exist, and under 0093 it would have shown patient names failing to
// resolve for a user the product does not have.
//
// Migrations 0090 (payout_batches), 0092 (payouts → member-level) and 0093
// (patient profiles) are executed VERBATIM. The pre-0092 payouts policy and
// 0006's profiles policy are installed first so the contrast tests can show
// the behaviour those migrations change.

const MIG_0090 = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/0090_payout_batches.sql'), 'utf8',
).replace(/\r\n/g, '\n');
const MIG_0092 = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/0092_payouts_member_select.sql'), 'utf8',
).replace(/\r\n/g, '\n');
const MIG_0093 = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/0093_profiles_patient_select_reconcile.sql'), 'utf8',
).replace(/\r\n/g, '\n');

const BASE = `
  create role app_user nologin;

  create table profiles (
    id uuid primary key default gen_random_uuid(),
    role text, first_name text not null, last_name text not null, email text unique not null
  );
  create table practices (
    id uuid primary key default gen_random_uuid(), name text, fee_percent numeric(5,2) default 6
  );
  create table practice_members (
    id uuid primary key default gen_random_uuid(),
    practice_id uuid references practices(id),
    user_id uuid references profiles(id),
    role text, active boolean default true,
    can_manage_practice boolean not null default false,
    unique (practice_id, user_id)
  );
  create table plans (
    id uuid primary key default gen_random_uuid(),
    practice_id uuid references practices(id),
    patient_id  uuid references profiles(id),
    -- 0093's provider-side policy predicates on this column, so it has to be
    -- real here rather than absent.
    provider_id uuid references profiles(id),
    status text, total_amount numeric(10,2), invoice_number text
  );
  create table payouts (
    id uuid primary key default gen_random_uuid(),
    practice_id uuid references practices(id),
    plan_id uuid references plans(id) unique,
    provider_id uuid,
    gross_amount numeric(10,2) not null,
    fee_amount numeric(10,2) not null,
    net_amount numeric(10,2) not null,
    status text default 'pending',
    payout_destination text default 'practice',
    paid_at timestamptz,
    created_at timestamptz default now()
  );

  create table _current_user (id uuid);
  create schema if not exists auth;
  create or replace function auth.uid() returns uuid
    language sql stable as $$ select id from _current_user limit 1 $$;

  -- SECURITY DEFINER, as the real ones are (0002 / 0034) — otherwise a policy
  -- on practice_members would recurse through its own predicate.
  create or replace function is_practice_member(p uuid) returns boolean
    language sql stable security definer set search_path = public, auth as $$
      select exists (select 1 from practice_members
        where practice_id = p and user_id = auth.uid() and active = true) $$;
  create or replace function is_practice_manager(p uuid) returns boolean
    language sql stable security definer set search_path = public, auth as $$
      select exists (select 1 from practice_members
        where practice_id = p and user_id = auth.uid()
          and can_manage_practice = true and active = true) $$;
  -- ROLE-based, not capability-based — 0093's practice-side patient-profile
  -- policy resolves through this one (0002).
  create or replace function is_practice_admin(p uuid) returns boolean
    language sql stable security definer set search_path = public, auth as $$
      select exists (select 1 from practice_members
        where practice_id = p and user_id = auth.uid()
          and role = 'admin' and active = true) $$;
  create or replace function is_platform_admin() returns boolean
    language sql stable as $$ select false $$;
  create or replace function is_brand_admin_of_practice(p uuid) returns boolean
    language sql stable as $$ select false $$;

  -- Real policies for the two tables the plan-line joins traverse.
  alter table plans enable row level security;
  create policy "practice_members_select_plans" on plans           -- 0002
    for select using (is_practice_member(practice_id));

  alter table profiles enable row level security;
  create policy "practice_members_select_patient_profiles" on profiles  -- 0006
    for select using (
      role = 'patient'
      and exists (select 1 from practice_members pm
                  where pm.user_id = auth.uid() and pm.active = true));

  -- payouts, at its PRE-0092 posture. 0092 replaces this policy.
  alter table payouts enable row level security;
  create policy "practice_admins_select_payouts" on payouts        -- 0035
    for select using (is_practice_manager(practice_id));
`;

let db: PGlite;
const q = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
  db.query<T>(sql, params);

/** Every resolver query goes through here, as the RLS-bound role. */
async function asAppUser<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
  await db.exec('set role app_user');
  try { return await db.query<T>(sql, params); }
  finally { await db.exec('reset role'); }
}

// ── PostgREST shim, RLS-bound ───────────────────────────────────────────
//
// Same narrow translation as lib/practice/nextPayout.pglite.test.ts — including
// the payouts→plans→profiles embed as a LEFT JOIN — except every statement runs
// as app_user. An unmodelled table or a changed embed THROWS, so a future query
// change cannot make this vacuous.

type Filter = { col: string; op: 'eq' | 'gte' | 'lt' | 'is'; val: unknown };

const EMBED_SELECT = `
  p.id, p.plan_id, p.net_amount, p.created_at,
  case when pl.id is null then null else json_build_object(
    'invoice_number', pl.invoice_number,
    'patient', case when pr.id is null then null else
      json_build_object('first_name', pr.first_name, 'last_name', pr.last_name) end
  ) end as plans`;

// LEFT JOINs, so an RLS-filtered plans/profiles row yields NULL rather than
// dropping the payout entirely — which is what PostgREST does too, and is the
// difference between "no plan lines" and "plan lines with no names".
const EMBED_FROM = `
  from payouts p
  left join plans    pl on pl.id = p.plan_id
  left join profiles pr on pr.id = pl.patient_id`;

function makeSqlClient() {
  return {
    from(table: string) {
      if (table !== 'payouts' && table !== 'payout_batches') {
        throw new Error(`shim: unmodelled table "${table}"`);
      }
      const filters: Filter[] = [];
      let cols = '*', orderBy = '', headOnly = false, embedded = false;

      function where(alias: string) {
        const params: unknown[] = [];
        const parts = filters.map((f) => {
          const col = `${alias}${f.col}`;
          if (f.op === 'is') return `${col} is null`;
          params.push(f.val);
          return `${col} ${f.op === 'eq' ? '=' : f.op === 'gte' ? '>=' : '<'} $${params.length}`;
        });
        return { sql: parts.length ? parts.join(' and ') : 'true', params };
      }

      async function run() {
        if (headOnly) {
          const w = where('');
          const { rows } = await asAppUser<{ n: number }>(
            `select count(*)::int as n from ${table} where ${w.sql}`, w.params);
          return { data: null, error: null, count: Number(rows[0]?.n ?? 0) };
        }
        if (embedded) {
          const w = where('p.');
          const { rows } = await asAppUser(
            `select ${EMBED_SELECT} ${EMBED_FROM} where ${w.sql} ${orderBy}`, w.params);
          return { data: rows, error: null, count: null };
        }
        const w = where('');
        const { rows } = await asAppUser(
          `select ${cols} from ${table} where ${w.sql} ${orderBy}`, w.params);
        return { data: rows, error: null, count: null };
      }

      const b: Record<string, unknown> = {};
      b.select = (c?: string, opts?: { count?: string; head?: boolean }) => {
        if (c) {
          if (/\bplans\s*\(/.test(c)) {
            embedded = true;
            if (!/patient:profiles!plans_patient_id_fkey\(first_name, last_name\)/.test(c)) {
              throw new Error('shim: payouts embed changed — update EMBED_SELECT');
            }
          } else cols = c.replace(/\s+/g, ' ').trim();
        }
        if (opts?.head) headOnly = true;
        return b;
      };
      b.eq  = (col: string, val: unknown) => { filters.push({ col, op: 'eq',  val }); return b; };
      b.gte = (col: string, val: unknown) => { filters.push({ col, op: 'gte', val }); return b; };
      b.lt  = (col: string, val: unknown) => { filters.push({ col, op: 'lt',  val }); return b; };
      b.is  = (col: string) => { filters.push({ col, op: 'is', val: null }); return b; };
      b.order = (col: string, opts?: { ascending?: boolean }) => {
        orderBy = `order by ${embedded ? 'p.' : ''}${col} ${opts?.ascending === false ? 'desc' : 'asc'}`;
        return b;
      };
      b.then = (ok: (v: unknown) => unknown, err?: (e: unknown) => unknown) => run().then(ok, err);
      return b;
    },
  };
}

// ── Fixtures ────────────────────────────────────────────────────────────
// Real 2026 calendar. NOW = Friday 14 Aug 09:00 SAST → closed window Thu 6 –
// Wed 12, open window Thu 13 – Wed 19.
const THU_06 = '2026-08-06';
const THU_13 = '2026-08-13';
const sast = (dt: string) => new Date(`${dt}${SAST_OFFSET}`);
const NOW  = sast('2026-08-14T09:00:00');

let practiceId: string, managerId: string, memberId: string;

const beCaller = async (id: string | null) => {
  await q('delete from _current_user');
  if (id) await q('insert into _current_user (id) values ($1)', [id]);
};

/**
 * A non-provider practice member. practice_members.role = 'admin' because
 * that is what inviteMemberIntoPractice actually writes for every
 * non-provider — 'staff' is permitted by the CHECK constraint but never
 * produced. `canManage` is the separate can_manage_practice capability, which
 * is what distinguishes a manager from reception.
 */
async function seedStaff(canManage: boolean, email: string) {
  const p = await q<{ id: string }>(
    `insert into profiles (role,first_name,last_name,email)
     values ('practice_admin','Staff','Person',$1) returning id`, [email]);
  await q(
    `insert into practice_members (practice_id,user_id,role,active,can_manage_practice)
     values ($1,$2,'admin',true,$3)`, [practiceId, p.rows[0].id, canManage]);
  return p.rows[0].id;
}

/** A practitioner: practice_members.role = 'provider', so NOT is_practice_admin. */
async function seedProvider(email: string) {
  const p = await q<{ id: string }>(
    `insert into profiles (role,first_name,last_name,email)
     values ('practice_provider','Doc','Provider',$1) returning id`, [email]);
  await q(
    `insert into practice_members (practice_id,user_id,role,active,can_manage_practice)
     values ($1,$2,'provider',true,false)`, [practiceId, p.rows[0].id]);
  return p.rows[0].id;
}

async function seedPayout(opts: {
  activatedAt: Date; net: number; batchId?: string | null;
  patient?: [string, string]; invoice?: string;
  /** Treating provider on the plan — drives 0093's provider-side policy. */
  providerId?: string | null;
}) {
  const [first, last] = opts.patient ?? ['Thabo', 'Mokoena'];
  const patient = await q<{ id: string }>(
    `insert into profiles (role,first_name,last_name,email)
     values ('patient',$1,$2,$3) returning id`,
    [first, last, `${first}.${last}.${Math.abs(opts.net)}@x.test`.toLowerCase()]);
  const plan = await q<{ id: string }>(
    `insert into plans (practice_id,patient_id,provider_id,status,total_amount,invoice_number)
     values ($1,$2,$3,'active',$4,$5) returning id`,
    [practiceId, patient.rows[0].id, opts.providerId ?? null,
     opts.net * 2, opts.invoice ?? 'INV-1']);
  await q(
    `insert into payouts (practice_id,plan_id,gross_amount,fee_amount,net_amount,status,batch_id,created_at)
     values ($1,$2,$3,$4,$5,'pending',$6,$7)`,
    [practiceId, plan.rows[0].id, opts.net * 2, opts.net, opts.net,
     opts.batchId ?? null, opts.activatedAt.toISOString()]);
}

async function seedBatch(windowEndDate: string, totalNet: number, planCount: number) {
  const end   = sastMidnight(windowEndDate);
  const start = new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000);
  const { rows } = await q<{ id: string }>(
    `insert into payout_batches (practice_id,window_start,window_end,total_net,plan_count,status)
     values ($1,$2,$3,$4,$5,'pending') returning id`,
    [practiceId, start.toISOString(), end.toISOString(), totalNet, planCount]);
  return rows[0].id;
}

const resolveFor = () => resolveNextPayout(makeSqlClient(), practiceId, NOW);

beforeAll(async () => {
  db = new PGlite();
  await db.exec(BASE);
  await db.exec(MIG_0090);
  await db.exec(`grant usage on schema public, auth to app_user;
                 grant select, insert, update, delete on all tables in schema public to app_user;
                 grant execute on all functions in schema public, auth to app_user;`);
});

beforeEach(async () => {
  await db.exec('truncate payout_batches, payouts, plans, practice_members, practices, profiles, _current_user cascade');
  practiceId = (await q<{ id: string }>(
    `insert into practices (name) values ('Test Practice') returning id`)).rows[0].id;
  managerId = await seedStaff(true,  'mgr@x.test');
  memberId  = await seedStaff(false, 'member@x.test');
});

afterAll(async () => { await db?.close(); });

// ─── BEFORE: the state that made this task necessary ────────────────────

describe('BEFORE 0092 — an ordinary member sees a count above nothing', () => {
  it('closed batch: total readable, plan lines NOT — plansHidden fires', async () => {
    const batchId = await seedBatch(THU_13, 350, 2);
    await seedPayout({ activatedAt: sast(`${THU_06}T10:00:00`), net: 100, batchId });
    await seedPayout({ activatedAt: sast('2026-08-11T10:00:00'), net: 250, batchId });

    await beCaller(memberId);
    const r = await resolveFor();

    expect(r.next.kind).toBe('committed');
    if (r.next.kind !== 'committed') return;
    expect(r.next.totalNet).toBe(350);      // payout_batches is member-readable
    expect(r.next.planCount).toBe(2);
    expect(r.next.plans).toEqual([]);       // payouts is not
    expect(r.next.plansHidden).toBe(true);  // the symptom being fixed
  });

  it('open window: the projection is unreadable, so it collapses to none', async () => {
    await seedPayout({ activatedAt: sast(`${THU_13}T10:00:00`), net: 400 });
    await beCaller(memberId);
    expect((await resolveFor()).next.kind).toBe('none');
  });
});

// ─── AFTER: the verification ────────────────────────────────────────────

describe('AFTER 0092 — an ordinary member sees real plan lines', () => {
  // 0093 runs too: it replaces 0006's uncorrelated profiles policy with the
  // two correlated ones production actually has, so patient-name resolution is
  // measured against the real posture rather than a policy that exists nowhere.
  beforeEach(async () => { await db.exec(MIG_0092); await db.exec(MIG_0093); });

  it('CLOSED BATCH: full plan lines, with patient labels and amounts', async () => {
    const batchId = await seedBatch(THU_13, 350, 2);
    await seedPayout({ activatedAt: sast(`${THU_06}T10:00:00`), net: 100,
      batchId, patient: ['Thabo', 'Mokoena'], invoice: 'INV-A1' });
    await seedPayout({ activatedAt: sast('2026-08-11T10:00:00'), net: 250,
      batchId, patient: ['Sarah', 'Naidoo'], invoice: 'INV-A2' });

    await beCaller(memberId);
    const r = await resolveFor();

    expect(r.next.kind).toBe('committed');
    if (r.next.kind !== 'committed') return;

    // The whole point.
    expect(r.next.plansHidden).toBe(false);
    expect(r.next.plans).toHaveLength(2);
    expect(r.next.plans.map((p) => [p.patientLabel, p.invoiceNumber, p.netAmount])).toEqual([
      ['Thabo M.', 'INV-A1', 100],
      ['Sarah N.', 'INV-A2', 250],
    ]);

    // Not merely non-empty — reconciling to the headline, which is what makes
    // the breakdown worth showing at all.
    expect(r.next.plans.reduce((s, p) => s + p.netAmount, 0)).toBe(r.next.totalNet);

    // Patient names really did resolve through the joins — a line reading "—"
    // would mean plans/profiles RLS refused and the list is cosmetic.
    expect(r.next.plans.every((p) => p.patientLabel !== '—')).toBe(true);
  });

  it('OPEN WINDOW: the projection is now readable, with its own plan lines', async () => {
    await seedPayout({ activatedAt: sast(`${THU_13}T10:00:00`), net: 400,
      patient: ['Naledi', 'Khumalo'], invoice: 'INV-B1' });
    await seedPayout({ activatedAt: sast('2026-08-14T08:00:00'), net: 250,
      patient: ['Sipho', 'Dlamini'], invoice: 'INV-B2' });

    await beCaller(memberId);
    const r = await resolveFor();

    expect(r.next.kind).toBe('projected');   // no longer 'none'
    if (r.next.kind !== 'projected') return;
    expect(r.next.totalNet).toBe(650);
    expect(r.next.plans).toHaveLength(2);
    expect(r.next.plans.map((p) => p.patientLabel)).toEqual(['Naledi K.', 'Sipho D.']);
    expect(r.next.plansHidden).toBe(false);
  });

  it('the ordinary member now sees EXACTLY what the manager sees', async () => {
    // The equality is the cleanest statement of what 0092 did.
    const batchId = await seedBatch(THU_13, 350, 2);
    await seedPayout({ activatedAt: sast(`${THU_06}T10:00:00`), net: 100, batchId });
    await seedPayout({ activatedAt: sast('2026-08-11T10:00:00'), net: 250, batchId });

    await beCaller(managerId);
    const asManager = await resolveFor();
    await beCaller(memberId);
    const asMember = await resolveFor();

    expect(JSON.stringify(asMember)).toBe(JSON.stringify(asManager));
  });

  it('plansHidden stays FALSE for a member — it is no longer a permission signal', async () => {
    const batchId = await seedBatch(THU_13, 100, 1);
    await seedPayout({ activatedAt: sast(`${THU_06}T10:00:00`), net: 100, batchId });

    await beCaller(memberId);
    const r = await resolveFor();
    if (r.next.kind !== 'committed') throw new Error('expected committed');
    expect(r.next.plansHidden).toBe(false);
  });

  it('but plansHidden STILL fires for a genuinely inconsistent batch', async () => {
    // The condition the new copy describes: plan_count says 3, no member rows
    // exist. Not a permission gap — the batch really does disagree with itself.
    await seedBatch(THU_13, 900, 3);

    await beCaller(memberId);
    const r = await resolveFor();
    if (r.next.kind !== 'committed') throw new Error('expected committed');
    expect(r.next.planCount).toBe(3);
    expect(r.next.plans).toEqual([]);
    expect(r.next.plansHidden).toBe(true);
  });

  // ── 0093: who resolves a patient NAME, and who gets '—' ───────────────
  //
  // The decided behaviour is that reception-level staff SHOULD see patient
  // names — managers only grant dashboard access to people they trust. These
  // tests pin exactly where the '—' fallback survives.

  it('RECEPTION (role=admin, can_manage_practice=false) resolves patient names', async () => {
    const batchId = await seedBatch(THU_13, 100, 1);
    await seedPayout({ activatedAt: sast(`${THU_06}T10:00:00`), net: 100,
      batchId, patient: ['Thabo', 'Mokoena'] });

    await beCaller(memberId);
    const r = await resolveFor();
    if (r.next.kind !== 'committed') throw new Error('expected committed');
    expect(r.next.plans.map((p) => p.patientLabel)).toEqual(['Thabo M.']);
  });

  it('a PROVIDER on the plan resolves the patient name', async () => {
    const providerId = await seedProvider('doc-on-plan@x.test');
    const batchId = await seedBatch(THU_13, 100, 1);
    await seedPayout({ activatedAt: sast(`${THU_06}T10:00:00`), net: 100,
      batchId, patient: ['Sarah', 'Naidoo'], providerId });

    await beCaller(providerId);
    const r = await resolveFor();
    if (r.next.kind !== 'committed') throw new Error('expected committed');
    expect(r.next.plans.map((p) => p.patientLabel)).toEqual(['Sarah N.']);
  });

  it("a PROVIDER not on the plan gets '—' — the only surviving fallback", async () => {
    // role='provider' is not is_practice_admin, and this plan's provider_id is
    // someone else, so neither of 0093's policies grants the profile read. The
    // payout row itself is still readable (0092 is member-level), so the line
    // appears with its amount and invoice — just without a name.
    const onPlan  = await seedProvider('doc-a@x.test');
    const notOnIt = await seedProvider('doc-b@x.test');
    const batchId = await seedBatch(THU_13, 100, 1);
    await seedPayout({ activatedAt: sast(`${THU_06}T10:00:00`), net: 100,
      batchId, patient: ['Naledi', 'Khumalo'], invoice: 'INV-X', providerId: onPlan });

    await beCaller(notOnIt);
    const r = await resolveFor();
    if (r.next.kind !== 'committed') throw new Error('expected committed');
    expect(r.next.plans).toHaveLength(1);
    expect(r.next.plans[0].patientLabel).toBe('—');
    // The row is not hidden — only the name is withheld.
    expect(r.next.plans[0].netAmount).toBe(100);
    expect(r.next.plans[0].invoiceNumber).toBe('INV-X');
    expect(r.next.plansHidden).toBe(false);
  });

  it('0093 actually removed 0006\'s uncorrelated policy', async () => {
    const { rows } = await q<{ policyname: string }>(
      `select policyname from pg_policies where tablename = 'profiles'`);
    const names = rows.map((r) => r.policyname);
    expect(names).not.toContain('practice_members_select_patient_profiles');
    expect(names).toContain('practice_admins_select_patient_profiles');
    expect(names).toContain('provider_select_own_patient_profiles');
  });

  it('a DEACTIVATED member sees nothing — widening did not weaken the gate', async () => {
    const batchId = await seedBatch(THU_13, 350, 1);
    await seedPayout({ activatedAt: sast(`${THU_06}T10:00:00`), net: 350, batchId });
    await q(`update practice_members set active = false where user_id = $1`, [memberId]);

    await beCaller(memberId);
    const r = await resolveFor();
    // payout_batches is is_practice_member too, so the whole hero goes empty.
    expect(r.next.kind).toBe('none');
  });
});
