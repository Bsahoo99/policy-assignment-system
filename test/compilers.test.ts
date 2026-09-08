import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fc from 'fast-check';
import { PGlite } from '@electric-sql/pglite';
import {
  evaluate,
  toSql,
  addYearsClamped,
  nextMaterialDate,
  validateGroupPredicate,
  type Predicate,
  type EmployeeState,
  SCALAR_FIELDS,
} from '../src/predicate';
import type { EmploymentType, PayType } from '../src/types';

/**
 * Runs real Postgres in-process (WASM), so the SQL compiler is tested against
 * actual Postgres semantics with no container or CI service required.
 */
let db: PGlite;

const DEPARTMENTS = ['Engineering', 'Sales', 'Support', null];
const STATES = ['CA', 'NY', 'TX', null];
const TYPES: EmploymentType[] = ['w2_employee', 'contractor', 'intern'];
const PAY_TYPES: PayType[] = ['salary', 'hourly'];
const GROUPS = ['eng-leads', 'us-payroll', 'interns'];

const employeeArb: fc.Arbitrary<EmployeeState> = fc.record({
  employee_id: fc.uuid(),
  department: fc.constantFrom(...DEPARTMENTS),
  location_state: fc.constantFrom(...STATES),
  location_country: fc.constantFrom('US', 'CA', 'IN'),
  employment_type: fc.constantFrom(...TYPES),
  pay_type: fc.constantFrom(...PAY_TYPES),
  tenure_start_date: fc
    .date({ min: new Date('2015-01-01'), max: new Date('2026-06-01'), noInvalidDate: true })
    .map((d) => d.toISOString().slice(0, 10)),
  direct_report_count: fc.integer({ min: 0, max: 5 }),
  group_keys: fc.uniqueArray(fc.constantFrom(...GROUPS), { maxLength: 3 }),
});

const predicateArb: fc.Arbitrary<Predicate> = fc.letrec<{ p: Predicate }>((tie) => ({
  p: fc.oneof(
    { depthSize: 'small', withCrossShrink: true },
    fc.constant<Predicate>({ op: 'always' }),
    fc.record({
      op: fc.constant<'eq'>('eq'),
      field: fc.constantFrom(...SCALAR_FIELDS),
      value: fc.constantFrom('Engineering', 'Sales', 'CA', 'NY', 'US', 'w2_employee', 'salary'),
    }),
    fc.record({
      op: fc.constant<'in'>('in'),
      field: fc.constantFrom(...SCALAR_FIELDS),
      values: fc.uniqueArray(fc.constantFrom('Engineering', 'Sales', 'CA', 'NY', 'contractor', 'hourly'), {
        minLength: 1,
        maxLength: 3,
      }),
    }),
    fc.record({ op: fc.constant<'gte_tenure'>('gte_tenure'), years: fc.integer({ min: 1, max: 10 }) }),
    fc.record({ op: fc.constant<'in_group'>('in_group'), group: fc.constantFrom(...GROUPS) }),
    fc.constant<Predicate>({ op: 'is_manager' }),
    fc.record({ op: fc.constant<'and'>('and'), children: fc.array(tie('p'), { minLength: 1, maxLength: 3 }) }),
    fc.record({ op: fc.constant<'or'>('or'), children: fc.array(tie('p'), { minLength: 1, maxLength: 3 }) }),
    fc.record({ op: fc.constant<'not'>('not'), child: tie('p') }),
  ),
})).p;

const asOfArb = fc
  .date({ min: new Date('2020-01-01'), max: new Date('2030-01-01'), noInvalidDate: true })
  .map((d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())));

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    SET TIME ZONE 'UTC';
    CREATE TABLE employee_state (
      employee_id UUID PRIMARY KEY,
      department TEXT,
      location_state TEXT,
      location_country TEXT NOT NULL,
      employment_type TEXT NOT NULL,
      pay_type TEXT NOT NULL,
      tenure_start_date DATE NOT NULL,
      direct_report_count INT NOT NULL,
      group_keys TEXT[] NOT NULL
    );
  `);
});

afterAll(async () => {
  await db.close();
});

async function sqlMatches(p: Predicate, s: EmployeeState, asOf: Date): Promise<boolean> {
  await db.query('DELETE FROM employee_state');
  await db.query(
    `INSERT INTO employee_state VALUES ($1,$2,$3,$4,$5,$6,$7::date,$8,$9::text[])`,
    [
      s.employee_id,
      s.department,
      s.location_state,
      s.location_country,
      s.employment_type,
      s.pay_type,
      s.tenure_start_date,
      s.direct_report_count,
      s.group_keys,
    ],
  );
  const { text, params } = toSql(p, asOf);
  const res = await db.query<{ hit: boolean }>(
    `SELECT COALESCE(${text}, FALSE) AS hit FROM employee_state e`,
    params,
  );
  return res.rows[0].hit;
}

describe('predicate compilers', () => {
  it('test_evaluate_and_tosql_random_inputs_agree', async () => {
    await fc.assert(
      fc.asyncProperty(predicateArb, employeeArb, asOfArb, async (p, s, asOf) => {
        const inMemory = evaluate(p, s, asOf).matched;
        const inSql = await sqlMatches(p, s, asOf);
        expect(inSql).toBe(inMemory);
      }),
      { numRuns: 300 },
    );
  }, 120_000);

  it('test_null_attribute_negation_agrees_with_sql', async () => {
    const s = sample({ department: null });
    const p: Predicate = { op: 'not', child: { op: 'eq', field: 'department', value: 'Sales' } };
    const asOf = new Date('2026-01-01T00:00:00Z');
    expect(await sqlMatches(p, s, asOf)).toBe(evaluate(p, s, asOf).matched);
  });
});

describe('tenure boundaries', () => {
  it('test_leap_day_anniversary_clamps_to_month_end', () => {
    expect(addYearsClamped('2024-02-29', 1).toISOString().slice(0, 10)).toBe('2025-02-28');
    expect(addYearsClamped('2024-02-29', 4).toISOString().slice(0, 10)).toBe('2028-02-29');
  });

  it('test_tenure_predicate_flips_exactly_at_boundary_instant', () => {
    const s = sample({ tenure_start_date: '2024-03-15' });
    const p: Predicate = { op: 'gte_tenure', years: 2 };
    const boundary = new Date('2026-03-15T00:00:00.000Z');

    expect(evaluate(p, s, new Date(boundary.getTime() - 1)).matched).toBe(false);
    expect(evaluate(p, s, boundary).matched).toBe(true);
  });

  it('test_next_material_date_returns_earliest_upcoming_threshold', () => {
    const s = sample({ tenure_start_date: '2024-03-15' });
    const p: Predicate = {
      op: 'and',
      children: [
        { op: 'gte_tenure', years: 5 },
        { op: 'or', children: [{ op: 'gte_tenure', years: 2 }, { op: 'is_manager' }] },
      ],
    };
    const next = nextMaterialDate(p, s, new Date('2025-01-01T00:00:00Z'));
    expect(next?.toISOString().slice(0, 10)).toBe('2026-03-15');
  });

  it('test_next_material_date_past_all_thresholds_returns_null', () => {
    const s = sample({ tenure_start_date: '2010-01-01' });
    expect(nextMaterialDate({ op: 'gte_tenure', years: 2 }, s, new Date('2026-01-01Z'))).toBeNull();
  });
});

describe('group predicate validation', () => {
  it('test_dynamic_group_referencing_group_is_rejected', () => {
    const p: Predicate = {
      op: 'and',
      children: [{ op: 'eq', field: 'department', value: 'Engineering' }, { op: 'in_group', group: 'eng-leads' }],
    };
    expect(() => validateGroupPredicate(p)).toThrow(/not allowed/);
  });

  it('test_dynamic_group_without_group_reference_is_accepted', () => {
    expect(() => validateGroupPredicate({ op: 'eq', field: 'location_state', value: 'CA' })).not.toThrow();
  });
});

function sample(overrides: Partial<EmployeeState> = {}): EmployeeState {
  return {
    employee_id: '11111111-1111-1111-1111-111111111111',
    department: 'Engineering',
    location_state: 'CA',
    location_country: 'US',
    employment_type: 'w2_employee',
    pay_type: 'salary',
    tenure_start_date: '2024-01-01',
    direct_report_count: 0,
    group_keys: [],
    ...overrides,
  };
}
