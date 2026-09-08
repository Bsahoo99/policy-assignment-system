import { describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { parsePredicate, toSql, PredicateValidationError } from '../src/predicate';
import { createRule } from '../src/api/writes';
import { FixedClock } from '../src/clock';
import type { Db } from '../src/db';
import {
  createTestDb,
  insertCompany,
  insertSlot,
  insertAssignmentTarget,
} from './helpers';

/**
 * `Predicate` is a compile-time type, but criteria arrive as JSON on an HTTP
 * body and `toSql` compiles `field` into query text as an identifier.
 * Parameterising values does not protect an identifier.
 */
describe('predicate input validation', () => {
  it('test_parse_predicate_field_carrying_sql_is_rejected', () => {
    expect(() =>
      parsePredicate({ op: 'eq', field: "department = 'x' OR 1=1 --", value: 'x' }),
    ).toThrow(PredicateValidationError);
  });

  it('test_parse_predicate_unknown_field_is_rejected', () => {
    expect(() => parsePredicate({ op: 'eq', field: 'salary', value: '1' })).toThrow(
      /unknown field/,
    );
  });

  it('test_parse_predicate_unknown_operator_is_rejected', () => {
    expect(() => parsePredicate({ op: 'drop_table' })).toThrow(/unknown op/);
  });

  it('test_parse_predicate_non_integer_tenure_years_is_rejected', () => {
    expect(() => parsePredicate({ op: 'gte_tenure', years: 1.5 })).toThrow(/whole number/);
    expect(() => parsePredicate({ op: 'gte_tenure', years: -1 })).toThrow(/whole number/);
  });

  it('test_parse_predicate_hostile_group_key_is_rejected', () => {
    expect(() =>
      parsePredicate({ op: 'in_group', group: "hq'); DROP TABLE employees;--" }),
    ).toThrow(/group key/);
  });

  it('test_parse_predicate_deeply_nested_tree_is_rejected', () => {
    let node: unknown = { op: 'always' };
    for (let i = 0; i < 25; i += 1) node = { op: 'not', child: node };
    expect(() => parsePredicate(node)).toThrow(/nested deeper/);
  });

  it('test_parse_predicate_accepts_every_supported_operator', () => {
    const good = {
      op: 'and',
      children: [
        { op: 'always' },
        { op: 'eq', field: 'department', value: 'Engineering' },
        { op: 'in', field: 'location_state', values: ['CA', 'NY'] },
        { op: 'gte_tenure', years: 2 },
        { op: 'in_group', group: 'engineering' },
        { op: 'or', children: [{ op: 'is_manager' }, { op: 'not', child: { op: 'is_manager' } }] },
      ],
    };
    expect(() => parsePredicate(good)).not.toThrow();
  });

  /** Even if an unparsed predicate reached toSql, the column map must reject it. */
  it('test_to_sql_never_interpolates_an_unknown_field', () => {
    const hostile = { op: 'eq', field: "department = 'x' OR 1=1 --", value: 'x' };
    expect(() => toSql(hostile as never, new Date('2026-01-01T00:00:00Z'))).toThrow(
      PredicateValidationError,
    );
  });
});

/**
 * D4: there is no "add tenancy later" path in a payroll system. Composite keys
 * carry the invariant so no write path can forget it.
 */
describe('tenant and target-type integrity', () => {
  async function fixture() {
    const pg: PGlite = await createTestDb();
    const db = pg as unknown as Db;
    const companyA = await insertCompany(db, 'A');
    const companyB = await insertCompany(db, 'B');
    const paySlotA = await insertSlot(db, companyA, 'payroll', 'exactly_one', 'pay_schedule');
    const appTargetA = await insertAssignmentTarget(db, companyA, 'app', 'A Slack');
    const appTargetB = await insertAssignmentTarget(db, companyB, 'app', 'B Slack');
    const payTargetA = await insertAssignmentTarget(db, companyA, 'pay_schedule', 'A Monthly');
    return { pg, db, companyA, companyB, paySlotA, appTargetA, appTargetB, payTargetA };
  }

  const clock = new FixedClock(new Date('2026-01-01T00:00:00Z'));
  const at = new Date('2026-01-01T00:00:00Z');

  it('test_rule_naming_another_companys_target_is_rejected', async () => {
    const f = await fixture();
    await expect(
      createRule(
        f.db,
        f.companyA,
        { name: 'cross tenant', slotId: f.paySlotA, targetId: f.appTargetB, criteria: { op: 'always' } },
        at,
        clock,
      ),
    ).rejects.toThrow();
    await f.pg.close();
  });

  it('test_rule_whose_target_type_mismatches_its_slot_is_rejected', async () => {
    const f = await fixture();
    await expect(
      createRule(
        f.db,
        f.companyA,
        { name: 'type mismatch', slotId: f.paySlotA, targetId: f.appTargetA, criteria: { op: 'always' } },
        at,
        clock,
      ),
    ).rejects.toThrow();
    await f.pg.close();
  });

  it('test_rule_naming_another_companys_slot_reports_the_company_mismatch', async () => {
    const f = await fixture();
    const slotB = await insertSlot(f.db, f.companyB, 'payroll', 'exactly_one', 'pay_schedule');
    await expect(
      createRule(
        f.db,
        f.companyA,
        { name: 'foreign slot', slotId: slotB, targetId: f.payTargetA, criteria: { op: 'always' } },
        at,
        clock,
      ),
    ).rejects.toThrow(/does not belong to company/);
    await f.pg.close();
  });

  it('test_rule_with_matching_company_and_target_type_is_accepted', async () => {
    const f = await fixture();
    const id = await createRule(
      f.db,
      f.companyA,
      { name: 'valid', slotId: f.paySlotA, targetId: f.payTargetA, criteria: { op: 'always' } },
      at,
      clock,
    );
    expect(id).toBeTruthy();
    await f.pg.close();
  });
});
