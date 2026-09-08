import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers';

let db: PGlite;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

describe('schema invariants', () => {
  it('test_exclusion_constraints_exist_on_every_bitemporal_table', async () => {
    const { rows } = await db.query<{ t: string }>(
      `SELECT conrelid::regclass::text AS t FROM pg_constraint WHERE contype = 'x'`,
    );
    expect(new Set(rows.map((r) => r.t))).toEqual(
      new Set(['employment_records', 'group_memberships', 'assignment_rules', 'resolved_assignments']),
    );
  });
});
