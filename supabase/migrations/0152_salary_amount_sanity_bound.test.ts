// @vitest-environment node

import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { isValidSalaryAmount, MAX_SALARY_AMOUNT } from '../../lib/salaryAmount';

const migration = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/0152_salary_amount_sanity_bound.sql'),
  'utf8',
);

const PATIENT = '11111111-1111-1111-1111-111111111111';
let db: PGlite;

async function writeSalary(value: string): Promise<boolean> {
  try {
    await db.exec(`update profiles set salary_amount = ${value} where id = '${PATIENT}'`);
    return true;
  } catch {
    return false;
  }
}

describe('0152 salary amount database contract', () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      create table profiles (
        id uuid primary key,
        salary_amount numeric(12,2) check (salary_amount is null or salary_amount > 0)
      );
      insert into profiles values ('${PATIENT}', null);
    `);
    await db.exec(migration);
  });

  it.each([
    ['zero', '0'],
    ['negative', '-1'],
    ['just above the maximum', '100000.01'],
    ['excessive precision', '50000.001'],
  ])('rejects %s through a direct database update', async (_label, value) => {
    expect(await writeSalary(value)).toBe(false);
  });

  it('accepts the exact maximum', async () => {
    expect(await writeSalary(String(MAX_SALARY_AMOUNT))).toBe(true);
  });

  it('uses the same upper bound and precision contract as the server validator', () => {
    expect(migration).toContain('salary_amount <= 100000');
    expect(migration).toContain('salary_amount = round(salary_amount, 2)');

    expect(isValidSalaryAmount(MAX_SALARY_AMOUNT)).toBe(true);
    expect(isValidSalaryAmount(MAX_SALARY_AMOUNT + 0.01)).toBe(false);
    expect(isValidSalaryAmount(50_000.001)).toBe(false);
  });
});
