import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { reconcileEmployee } from '../src/reconcile';
import { FixedClock } from '../src/clock';
import type { Db } from '../src/db';
import type { Predicate } from '../src/predicate';

const __dirname = dirname(fileURLToPath(import.meta.url));
const schemaSql = readFileSync(join(__dirname, '../db/schema.sql'), 'utf8');
const effectMigrationSql = readFileSync(join(__dirname, '../db/migrations/002_rule_effect.sql'), 'utf8');
const versionMigrationSql = readFileSync(join(__dirname, '../db/migrations/003_rule_version_key.sql'), 'utf8');
const tiebreakMigrationSql = readFileSync(join(__dirname, '../db/migrations/004_stable_tiebreak.sql'), 'utf8');

let db: PGlite;

beforeAll(async () => {
  db = new PGlite({ extensions: { btree_gist } });
  await db.exec(schemaSql);
  await db.exec(effectMigrationSql);
  await db.exec(versionMigrationSql);
  await db.exec(tiebreakMigrationSql);
});

afterAll(async () => {
  await db.close();
});

async function insertCompany(name: string): Promise<string> {
  const { rows } = await (db as Db).query<{ id: string }>('INSERT INTO companies (name) VALUES ($1) RETURNING id', [name]);
  return rows[0].id;
}

async function insertEmployee(companyId: string, email: string): Promise<string> {
  const { rows } = await (db as Db).query<{ id: string }>(
    'INSERT INTO employees (company_id, first_name, last_name, email) VALUES ($1, $2, $3, $4) RETURNING id',
    [companyId, 'F', 'L', email],
  );
  return rows[0].id;
}

async function insertEmploymentRecord(companyId: string, employeeId: string, tenureStart: string): Promise<void> {
  await (db as Db).query(
    `INSERT INTO employment_records
       (company_id, employee_id, department, location_state, location_country, employment_type, pay_type, tenure_start_date, valid, system)
     VALUES ($1, $2, 'Engineering', 'CA', 'US', 'w2_employee', 'salary', $3,
             tstzrange('2024-01-01T00:00:00Z'::timestamptz, NULL),
             tstzrange('2024-01-01T00:00:00Z'::timestamptz, NULL))`,
    [companyId, employeeId, tenureStart],
  );
}

async function insertSlot(companyId: string, key: string, cardinality: string, targetType: string): Promise<string> {
  const { rows } = await (db as Db).query<{ id: string }>(
    'INSERT INTO assignment_slots (company_id, key, display_name, cardinality, target_type) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [companyId, key, key, cardinality, targetType],
  );
  return rows[0].id;
}

async function insertAssignmentTarget(companyId: string, targetType: string, displayName: string): Promise<string> {
  const { rows } = await (db as Db).query<{ id: string }>(
    'INSERT INTO assignment_targets (company_id, target_type, display_name) VALUES ($1, $2, $3) RETURNING id',
    [companyId, targetType, displayName],
  );
  return rows[0].id;
}

async function insertRule(
  companyId: string,
  slotId: string,
  targetId: string,
  name: string,
  criteria: Predicate,
  source: 'rule' | 'manual' = 'rule',
  subjectEmployeeId: string | null = null,
  effect: 'grant' | 'deny' = 'grant',
  priority = 0,
): Promise<string> {
  const { rows } = await (db as Db).query<{ id: string }>(
    `INSERT INTO assignment_rules
       (company_id, rule_id, rule_created_at, slot_id, target_id, name, source, effect, priority, criteria, subject_employee_id, valid, system)
     VALUES ($1, gen_random_uuid(), '2024-01-01T00:00:00Z'::timestamptz, $2, $3, $4, $5, $6, $7, $8::jsonb, $9,
             tstzrange('2024-01-01T00:00:00Z'::timestamptz, NULL),
             tstzrange('2024-01-01T00:00:00Z'::timestamptz, NULL))
     RETURNING id`,
    [companyId, slotId, targetId, name, source, effect, priority, JSON.stringify(criteria), subjectEmployeeId],
  );
  return rows[0].id;
}

async function insertResolvedAssignment(
  companyId: string,
  employeeId: string,
  slotId: string,
  targetId: string,
  winningRuleId: string,
): Promise<void> {
  await (db as Db).query(
    `INSERT INTO resolved_assignments
       (company_id, employee_id, slot_id, target_id, winning_rule_id, winning_rule_version_id, is_exclusive, explain_trace, valid, system)
     VALUES ($1, $2, $3, $4, $5, $5, true, '{}'::jsonb,
             tstzrange('2024-01-01T00:00:00Z'::timestamptz, NULL),
             tstzrange('2024-01-01T00:00:00Z'::timestamptz, NULL))`,
    [companyId, employeeId, slotId, targetId, winningRuleId],
  );
}

async function resolvedCount(companyId: string, employeeId: string): Promise<number> {
  const { rows } = await (db as Db).query<{ c: unknown }>(
    'SELECT COUNT(*) AS c FROM resolved_assignments WHERE company_id = $1 AND employee_id = $2',
    [companyId, employeeId],
  );
  return Number(rows[0].c);
}

async function resolvedRows(companyId: string, employeeId: string, validAt: string, systemAt: string) {
  const { rows } = await (db as Db).query<{
    slot_id: string;
    target_id: string;
    winning_rule_id: string;
    valid_lower: unknown;
    valid_upper: unknown;
    system_lower: unknown;
    system_upper: unknown;
  }>(
    `SELECT slot_id, target_id, winning_rule_id, lower(valid) AS valid_lower, upper(valid) AS valid_upper,
            lower(system) AS system_lower, upper(system) AS system_upper
     FROM resolved_assignments
     WHERE company_id = $1 AND employee_id = $2
       AND valid @> $3::timestamptz
       AND system @> $4::timestamptz`,
    [companyId, employeeId, validAt, systemAt],
  );
  return rows;
}

describe('reconcileEmployee', () => {
  it('test_reconcile_identical_state_writes_nothing', async () => {
    const companyId = await insertCompany('c1');
    const employeeId = await insertEmployee(companyId, 'e1@example.com');
    await insertEmploymentRecord(companyId, employeeId, '2024-01-01');
    const slotId = await insertSlot(companyId, 'vacation', 'exactly_one', 'policy');
    const targetId = await insertAssignmentTarget(companyId, 'policy', 'Standard');
    await insertRule(companyId, slotId, targetId, 'Always', { op: 'always' });

    const clock = new FixedClock(new Date('2024-06-01T00:00:00Z'));
    const first = await reconcileEmployee(db, companyId, employeeId, new Date('2024-06-01T00:00:00Z'), clock);
    expect(first.changed).toBe(true);
    expect(await resolvedCount(companyId, employeeId)).toBe(1);

    const second = await reconcileEmployee(db, companyId, employeeId, new Date('2024-06-01T00:00:00Z'), clock);
    expect(second.changed).toBe(false);
    expect(await resolvedCount(companyId, employeeId)).toBe(1);
  });

  it('test_reconcile_tenure_crossing_sets_valid_from_to_boundary_not_run_time', async () => {
    const companyId = await insertCompany('c2');
    const employeeId = await insertEmployee(companyId, 'e2@example.com');
    await insertEmploymentRecord(companyId, employeeId, '2024-01-01');
    const slotId = await insertSlot(companyId, 'vacation', 'exactly_one', 'policy');
    const targetId = await insertAssignmentTarget(companyId, 'policy', 'Senior');
    await insertRule(companyId, slotId, targetId, 'Two years', { op: 'gte_tenure', years: 2 });

    const clock = new FixedClock(new Date('2026-03-01T00:00:00Z'));
    await reconcileEmployee(db, companyId, employeeId, new Date('2026-01-01T00:00:00Z'), clock);

    const rows = await resolvedRows(companyId, employeeId, '2026-01-01T00:00:00Z', '2026-03-01T00:00:00Z');
    expect(rows).toHaveLength(1);
    expect(new Date(String(rows[0].valid_lower)).toISOString().slice(0, 10)).toBe('2026-01-01');
    expect(new Date(String(rows[0].system_lower)).toISOString().slice(0, 10)).toBe('2026-03-01');
  });

  it('test_ending_an_assignment_preserves_prior_belief_at_earlier_system_time', async () => {
    const companyId = await insertCompany('c3');
    const employeeId = await insertEmployee(companyId, 'e3@example.com');
    await insertEmploymentRecord(companyId, employeeId, '2024-01-01');
    const slotId = await insertSlot(companyId, 'vacation', 'exactly_one', 'policy');
    const oldTarget = await insertAssignmentTarget(companyId, 'policy', 'Old');
    const newTarget = await insertAssignmentTarget(companyId, 'policy', 'New');
    const oldRuleId = '00000000-0000-0000-0000-0000000000a1';
    await insertResolvedAssignment(companyId, employeeId, slotId, oldTarget, oldRuleId);
    await insertRule(companyId, slotId, newTarget, 'New rule', { op: 'always' });

    const clock = new FixedClock(new Date('2024-09-01T00:00:00Z'));
    const result = await reconcileEmployee(db, companyId, employeeId, new Date('2024-06-01T00:00:00Z'), clock);
    expect(result.changed).toBe(true);

    // Current belief at systemAt=2024-09-01 sees the new assignment.
    const now = await resolvedRows(companyId, employeeId, '2024-07-01T00:00:00Z', '2024-09-01T00:00:00Z');
    expect(now.map((r) => r.target_id)).toEqual([newTarget]);

    // Earlier belief at systemAt=2024-03-01 still sees the old assignment as open-ended.
    const before = await resolvedRows(companyId, employeeId, '2024-07-01T00:00:00Z', '2024-03-01T00:00:00Z');
    expect(before.map((r) => r.target_id)).toEqual([oldTarget]);
    expect(before[0].valid_upper).toBeNull();
    expect(before[0].system_upper).not.toBeNull();
  });
});
