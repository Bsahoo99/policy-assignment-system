import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { buildEmployeeState, buildEmployeeStates } from '../src/state';
import type { Db } from '../src/db';
import { ensureSchema } from '../src/schema-sql';

const __dirname = dirname(fileURLToPath(import.meta.url));

let db: PGlite;

beforeAll(async () => {
  db = new PGlite({ extensions: { btree_gist } });
  await ensureSchema(db as unknown as Db, join(__dirname, '..'));
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

async function insertEmploymentRecord(
  companyId: string,
  employeeId: string,
  department: string | null,
  validLower: string,
  validUpper: string | null,
  systemLower = '2024-01-01T00:00:00Z',
  systemUpper: string | null = null,
): Promise<void> {
  await (db as Db).query(
    `INSERT INTO employment_records
       (company_id, employee_id, department, location_state, location_country, employment_type, pay_type, tenure_start_date, valid, system)
     VALUES ($1, $2, $3, 'CA', 'US', 'w2_employee', 'salary', '2024-01-01',
             tstzrange($4::timestamptz, $5::timestamptz),
             tstzrange($6::timestamptz, $7::timestamptz))`,
    [companyId, employeeId, department, validLower, validUpper, systemLower, systemUpper],
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

async function insertEmployeeTarget(targetId: string, employeeId: string): Promise<void> {
  await (db as Db).query(
    'INSERT INTO employee_targets (target_id, target_type, employee_id) VALUES ($1, $2, $3)',
    [targetId, 'employee', employeeId],
  );
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
       (company_id, employee_id, slot_id, target_id, winning_rule_id, is_exclusive, explain_trace, valid, system)
     VALUES ($1, $2, $3, $4, $5, true, '{}'::jsonb,
             tstzrange('2024-01-01T00:00:00Z'::timestamptz, NULL),
             tstzrange('2024-01-01T00:00:00Z'::timestamptz, NULL))`,
    [companyId, employeeId, slotId, targetId, winningRuleId],
  );
}

function validAt(iso: string): Date {
  return new Date(iso);
}

function systemAt(iso: string): Date {
  return new Date(iso);
}

describe('buildEmployeeState', () => {
  it('test_build_state_returns_fact_valid_at_given_instant', async () => {
    const companyId = await insertCompany('c1');
    const employeeId = await insertEmployee(companyId, 'e1@example.com');
    await insertEmploymentRecord(companyId, employeeId, 'Engineering', '2024-01-01T00:00:00Z', '2024-06-01T00:00:00Z');
    await insertEmploymentRecord(companyId, employeeId, 'Sales', '2024-06-01T00:00:00Z', null);

    const before = await buildEmployeeState(db, companyId, employeeId, validAt('2024-03-01T00:00:00Z'), systemAt('2024-02-01T00:00:00Z'));
    const after = await buildEmployeeState(db, companyId, employeeId, validAt('2024-07-01T00:00:00Z'), systemAt('2024-02-01T00:00:00Z'));

    expect(before.department).toBe('Engineering');
    expect(after.department).toBe('Sales');
  });

  it('test_build_state_retroactive_correction_differs_by_system_time', async () => {
    const companyId = await insertCompany('c2');
    const employeeId = await insertEmployee(companyId, 'e2@example.com');
    await insertEmploymentRecord(
      companyId,
      employeeId,
      'Engineering',
      '2024-01-01T00:00:00Z',
      null,
      '2024-01-01T00:00:00Z',
      '2024-03-01T00:00:00Z',
    );
    await insertEmploymentRecord(
      companyId,
      employeeId,
      'Sales',
      '2024-01-01T00:00:00Z',
      null,
      '2024-03-01T00:00:00Z',
      null,
    );

    const earlierBelief = await buildEmployeeState(
      db,
      companyId,
      employeeId,
      validAt('2024-06-01T00:00:00Z'),
      systemAt('2024-01-15T00:00:00Z'),
    );
    const laterBelief = await buildEmployeeState(
      db,
      companyId,
      employeeId,
      validAt('2024-06-01T00:00:00Z'),
      systemAt('2024-03-15T00:00:00Z'),
    );

    expect(earlierBelief.department).toBe('Engineering');
    expect(laterBelief.department).toBe('Sales');
  });

  it('test_build_state_bulk_matches_single_for_each_employee', async () => {
    const companyId = await insertCompany('c3');
    const e1 = await insertEmployee(companyId, 'e3-1@example.com');
    const e2 = await insertEmployee(companyId, 'e3-2@example.com');
    await insertEmploymentRecord(companyId, e1, 'Engineering', '2024-01-01T00:00:00Z', null);
    await insertEmploymentRecord(companyId, e2, 'Sales', '2024-01-01T00:00:00Z', null);

    const valid = validAt('2024-06-01T00:00:00Z');
    const system = systemAt('2024-06-01T00:00:00Z');

    const bulk = await buildEmployeeStates(db, companyId, [e1, e2], valid, system);
    const single1 = await buildEmployeeState(db, companyId, e1, valid, system);
    const single2 = await buildEmployeeState(db, companyId, e2, valid, system);

    expect(bulk.get(e1)).toEqual(single1);
    expect(bulk.get(e2)).toEqual(single2);
  });

  it('test_direct_report_count_reflects_manager_assignments_at_asof', async () => {
    const companyId = await insertCompany('c4');
    const manager = await insertEmployee(companyId, 'manager@example.com');
    const report = await insertEmployee(companyId, 'report@example.com');
    await insertEmploymentRecord(companyId, manager, 'Engineering', '2024-01-01T00:00:00Z', null);
    await insertEmploymentRecord(companyId, report, 'Engineering', '2024-01-01T00:00:00Z', null);

    const managerSlot = await insertSlot(companyId, 'manager', 'at_most_one', 'employee');
    const managerTarget = await insertAssignmentTarget(companyId, 'employee', 'Manager');
    const reportTarget = await insertAssignmentTarget(companyId, 'employee', 'Report');
    await insertEmployeeTarget(managerTarget, manager);
    await insertEmployeeTarget(reportTarget, report);

    const winningRuleId = '00000000-0000-0000-0000-000000000001';
    await insertResolvedAssignment(companyId, report, managerSlot, managerTarget, winningRuleId);

    const asOf = validAt('2024-06-01T00:00:00Z');
    const managerState = await buildEmployeeState(db, companyId, manager, asOf, asOf);
    const reportState = await buildEmployeeState(db, companyId, report, asOf, asOf);

    expect(managerState.direct_report_count).toBe(1);
    expect(reportState.direct_report_count).toBe(0);
  });
});
