// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

// ─── Real RPC execution test (migration 0084) ───────────────────────────
//
// Source pins prove the SQL *says* the right thing; this proves it *does*
// the right thing. It loads the ACTUAL refresh_card_token body out of the
// 0084 migration and runs it in an in-process Postgres (pglite, real
// plpgsql), then calls it DIRECTLY — the same way saveCardForPatient's
// dedupe 'update' branch drives it — to prove the resurrect + sane-default
// behaviour on the server itself.
//
// The bug this guards: 0083 added archived_at, but re-vaulting a removed
// (archived) card used to refresh the token yet leave archived_at SET, so
// the card stayed hidden. Adding a card added nothing visible.

const MIG = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/0084_refresh_card_token_unarchive.sql'),
  'utf8',
).replace(/\r\n/g, '\n');

/** Extract the full `CREATE OR REPLACE FUNCTION … $$;` block verbatim. */
function fnSql(name: string): string {
  const start = MIG.indexOf(`CREATE OR REPLACE FUNCTION ${name}`);
  if (start < 0) throw new Error(`function ${name} not found in migration`);
  const end = MIG.indexOf('$$;', start);
  return MIG.slice(start, end + 3);
}

const SCHEMA = `
  create table payment_methods (
    id           uuid primary key default gen_random_uuid(),
    patient_id   uuid not null,
    token        text,
    card_brand   text,
    last_four    text,
    expiry_month int,
    expiry_year  int,
    signature    text,
    reusable     boolean not null default true,
    is_default   boolean not null default false,
    archived_at  timestamptz,
    created_at   timestamptz not null default now()
  );
  create table plans (
    id                    uuid primary key default gen_random_uuid(),
    patient_id            uuid not null,
    status                text not null,
    peach_registration_id text,
    invoice_number        text
  );
  create table plan_events (
    id          uuid primary key default gen_random_uuid(),
    plan_id     uuid not null,
    patient_id  uuid not null,
    event_type  text not null,
    payload     jsonb,
    created_at  timestamptz not null default now()
  );
`;

const U  = '11111111-1111-1111-1111-111111111111';
const U2 = '22222222-2222-2222-2222-222222222222';
const C  = '00000000-0000-0000-0000-0000000000c1'; // the card under test
const D  = '00000000-0000-0000-0000-0000000000d2'; // an "other" card

let db: PGlite;

async function seedCard(
  id: string, patient: string, token: string,
  opts: { isDefault?: boolean; archivedAt?: string | null } = {},
) {
  await db.query(
    `insert into payment_methods
       (id, patient_id, token, card_brand, last_four, expiry_month, expiry_year, signature, is_default, archived_at)
     values ($1, $2, $3, 'VISA', '4242', 12, 2030, 'peach:VISA:4242:122030', $4, $5)`,
    [id, patient, token, opts.isDefault ?? false, opts.archivedAt ?? null],
  );
}
async function seedPlan(patient: string, status: string, token: string) {
  await db.query(
    `insert into plans (patient_id, status, peach_registration_id, invoice_number)
     values ($1, $2, $3, 'INV-1')`,
    [patient, status, token],
  );
}
async function cardRow(id: string) {
  const r = await db.query<{ is_default: boolean; archived_at: string | null; token: string; last_four: string }>(
    `select is_default, archived_at, token, last_four from payment_methods where id = $1`, [id],
  );
  return r.rows[0];
}
async function refresh(cardId: string, token: string) {
  return db.query(
    `select refresh_card_token($1, $2, 'VISA', '4041', 6, 2031) as r`, [cardId, token],
  );
}

beforeEach(async () => {
  db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(fnSql('refresh_card_token'));
});

describe('refresh_card_token — resurrect on re-vault (the reported bug)', () => {
  it('re-vaulting an ARCHIVED card clears archived_at so it reappears', async () => {
    // The removed card: archived, de-defaulted (as archive_card leaves it).
    await seedCard(C, U, 'tokOld', { isDefault: false, archivedAt: '2026-08-01T00:00:00Z' });

    await refresh(C, 'tokNew'); // re-add → new registrationId

    const row = await cardRow(C);
    expect(row.archived_at).toBeNull();   // resurrected — no longer hidden
    expect(row.token).toBe('tokNew');     // token refreshed to the new reg
    expect(row.last_four).toBe('4041');   // metadata refreshed too
  });

  it('an ordinary same-card refresh (not archived) stays un-archived — no-op on archived_at', async () => {
    await seedCard(C, U, 'tokOld', { isDefault: true, archivedAt: null });
    await refresh(C, 'tokNew');
    const row = await cardRow(C);
    expect(row.archived_at).toBeNull();
    expect(row.is_default).toBe(true);    // untouched
  });
});

describe('refresh_card_token — sane default after resurrect', () => {
  it('resurrecting the patient\'s ONLY card (no active default) promotes it to default', async () => {
    // Only card, archived + de-defaulted → after archiving there was no
    // active default at all.
    await seedCard(C, U, 'tokOld', { isDefault: false, archivedAt: '2026-08-01T00:00:00Z' });

    await refresh(C, 'tokNew');

    const row = await cardRow(C);
    expect(row.archived_at).toBeNull();
    expect(row.is_default).toBe(true);    // promoted — plan creation has a default again
  });

  it('does NOT steal the default from an existing ACTIVE default card', async () => {
    // Patient already has an active default card D; they re-add archived C.
    await seedCard(D, U, 'tokD', { isDefault: true,  archivedAt: null });
    await seedCard(C, U, 'tokOld', { isDefault: false, archivedAt: '2026-08-01T00:00:00Z' });

    await refresh(C, 'tokNew');

    expect((await cardRow(C)).is_default).toBe(false); // resurrected but not default
    expect((await cardRow(D)).is_default).toBe(true);  // existing default preserved
  });
});

describe('refresh_card_token — 0078 behaviour preserved', () => {
  it('still repoints an active plan holding the OLD token to the new one', async () => {
    await seedCard(C, U, 'tokOld', { isDefault: true, archivedAt: null });
    await seedPlan(U, 'active', 'tokOld');

    await refresh(C, 'tokNew');

    const r = await db.query<{ peach_registration_id: string }>(
      `select peach_registration_id from plans where patient_id = $1`, [U],
    );
    expect(r.rows[0].peach_registration_id).toBe('tokNew');
  });

  it('never crosses patient boundaries on resurrect', async () => {
    // A different patient's card sharing the (coincidental) fingerprint must
    // be untouched, and its default state left alone.
    await seedCard(D, U2, 'tokD', { isDefault: true, archivedAt: null });
    await seedCard(C, U,  'tokOld', { isDefault: false, archivedAt: '2026-08-01T00:00:00Z' });

    await refresh(C, 'tokNew');

    expect((await cardRow(D)).is_default).toBe(true);   // other patient's default intact
    expect((await cardRow(D)).archived_at).toBeNull();
    expect((await cardRow(D)).token).toBe('tokD');       // untouched
  });
});
