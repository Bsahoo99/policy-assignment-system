import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { randomUUID } from 'crypto';
import type { Db } from '../src/db';
import type { Predicate } from '../src/predicate';
import { ensureSchema } from '../src/schema-sql';

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function createTestDb(): Promise<PGlite> {
  const db = new PGlite({ extensions: { btree_gist } });
  await ensureSchema(db as unknown as Db, join(__dirname, '..'));
  return db;
}

export async function insertCompany(db: Db, name: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>('INSERT INTO companies (name) VALUES ($1) RETURNING id', [name]);
  return rows[0].id;
}

export async function insertEmployee(db: Db, companyId: string, email: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    'INSERT INTO employees (company_id, first_name, last_name, email) VALUES ($1, $2, $3, $4) RETURNING id',
    [companyId, 'F', 'L', email],
  );
  return rows[0].id;
}

export async function insertEmploymentRecord(
  db: Db,
  companyId: string,
  employeeId: string,
  tenureStart = '2024-01-01',
  department = 'Engineering',
): Promise<void> {
  await db.query(
    `INSERT INTO employment_records
       (company_id, employee_id, department, location_state, location_country, employment_type, pay_type, tenure_start_date, valid, system)
     VALUES ($1, $2, $3, 'CA', 'US', 'w2_employee', 'salary', $4,
             tstzrange('2024-01-01T00:00:00Z'::timestamptz, NULL),
             tstzrange('2024-01-01T00:00:00Z'::timestamptz, NULL))`,
    [companyId, employeeId, department, tenureStart],
  );
}

export async function insertSlot(
  db: Db,
  companyId: string,
  key: string,
  cardinality: 'exactly_one' | 'at_most_one' | 'many',
  targetType: 'policy' | 'app' | 'pay_schedule' | 'employee',
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    'INSERT INTO assignment_slots (company_id, key, display_name, cardinality, target_type) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [companyId, key, key, cardinality, targetType],
  );
  return rows[0].id;
}

export async function insertAssignmentTarget(
  db: Db,
  companyId: string,
  targetType: 'policy' | 'app' | 'pay_schedule' | 'employee',
  displayName: string,
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    'INSERT INTO assignment_targets (company_id, target_type, display_name) VALUES ($1, $2, $3) RETURNING id',
    [companyId, targetType, displayName],
  );
  return rows[0].id;
}

export async function insertGroup(
  db: Db,
  companyId: string,
  key: string,
  kind: 'static' | 'dynamic',
  criteria?: Predicate | null,
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    'INSERT INTO groups (company_id, key, kind, criteria) VALUES ($1, $2, $3, $4) RETURNING id',
    [companyId, key, kind, criteria ? JSON.stringify(criteria) : null],
  );
  return rows[0].id;
}

export async function insertRule(
  db: Db,
  companyId: string,
  slotId: string,
  targetId: string,
  name: string,
  criteria: Predicate,
  opts: {
    source?: 'rule' | 'manual';
    subjectEmployeeId?: string | null;
    effect?: 'grant' | 'deny';
    priority?: number;
  } = {},
): Promise<string> {
  const ruleId = randomUUID();
  await db.query(
    `INSERT INTO assignment_rules
       (company_id, rule_id, rule_created_at, slot_id, target_id, name, source, effect, priority, criteria, subject_employee_id, valid, system)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11,
             tstzrange('2024-01-01T00:00:00Z'::timestamptz, NULL),
             tstzrange('2024-01-01T00:00:00Z'::timestamptz, NULL))`,
    [
      companyId,
      ruleId,
      '2024-01-01T00:00:00Z',
      slotId,
      targetId,
      name,
      opts.source ?? 'rule',
      opts.effect ?? 'grant',
      opts.priority ?? 0,
      JSON.stringify(criteria),
      opts.subjectEmployeeId ?? null,
    ],
  );
  return ruleId;
}

export async function insertResolvedAssignment(
  db: Db,
  companyId: string,
  employeeId: string,
  slotId: string,
  targetId: string,
  winningRuleId: string,
  isExclusive = true,
  explainTrace: unknown = {},
  validLower = '2024-01-01T00:00:00Z',
  validUpper: string | null = null,
  systemLower = '2024-01-01T00:00:00Z',
  systemUpper: string | null = null,
  winningRuleVersionId?: string,
): Promise<void> {
  await db.query(
    `INSERT INTO resolved_assignments
       (company_id, employee_id, slot_id, target_id, winning_rule_id, winning_rule_version_id, is_exclusive, explain_trace, valid, system)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb,
             tstzrange($9::timestamptz, $10::timestamptz),
             tstzrange($11::timestamptz, $12::timestamptz))`,
    [companyId, employeeId, slotId, targetId, winningRuleId, winningRuleVersionId ?? winningRuleId, isExclusive, JSON.stringify(explainTrace), validLower, validUpper, systemLower, systemUpper],
  );
}
