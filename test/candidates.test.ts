import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import {
  createTestDb,
  insertCompany,
  insertEmployee,
  insertEmploymentRecord,
  insertSlot,
  insertAssignmentTarget,
  insertRule,
  insertResolvedAssignment,
} from './helpers';
import { candidatesForRuleChange } from '../src/candidates';
import type { Db } from '../src/db';
import type { Rule } from '../src/types';
import type { Predicate } from '../src/predicate';

let db: PGlite;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

async function insertEmployeeTarget(db: Db, targetId: string, employeeId: string): Promise<void> {
  await db.query(
    'INSERT INTO employee_targets (target_id, target_type, employee_id) VALUES ($1, $2, $3)',
    [targetId, 'employee', employeeId],
  );
}

function rule(id: string, slotId: string, targetId: string, criteria: Predicate, source: 'rule' | 'manual' = 'rule'): Rule {
  return {
    id,
    ruleId: id,
    ruleCreatedAt: new Date('2024-01-01'),
    companyId: 'c',
    slotId,
    targetId,
    name: 'r',
    source,
    effect: 'grant',
    priority: 0,
    criteria,
    subjectEmployeeId: null,
    createdAt: new Date('2024-01-01'),
  };
}

describe('candidatesForRuleChange', () => {
  it('test_narrowing_a_rule_includes_employees_who_no_longer_match', async () => {
    const companyId = await insertCompany(db, 'cand1');
    const alice = await insertEmployee(db, companyId, 'alice@example.com');
    const bob = await insertEmployee(db, companyId, 'bob@example.com');
    await insertEmploymentRecord(db, companyId, alice, '2024-01-01', 'Engineering');
    await insertEmploymentRecord(db, companyId, bob, '2024-01-01', 'Sales');
    const slotId = await insertSlot(db, companyId, 'vacation', 'exactly_one', 'policy');
    const targetId = await insertAssignmentTarget(db, companyId, 'policy', 'T');
    await insertRule(db, companyId, slotId, targetId, 'old', { op: 'always' });

    const ruleId = '00000000-0000-0000-0000-0000000000a1';
    const before = rule(ruleId, slotId, targetId, { op: 'always' });
    const after = rule(ruleId, slotId, targetId, { op: 'eq', field: 'department', value: 'Engineering' });
    const result = await candidatesForRuleChange(db as unknown as Db, companyId, before, after, new Date('2024-06-01'));

    expect(result).toContain(alice);
    expect(result).toContain(bob);
  });

  it('test_deleting_a_rule_includes_employees_currently_resolved_by_it', async () => {
    const companyId = await insertCompany(db, 'cand2');
    const employeeId = await insertEmployee(db, companyId, 'e@example.com');
    await insertEmploymentRecord(db, companyId, employeeId);
    const slotId = await insertSlot(db, companyId, 'vacation', 'exactly_one', 'policy');
    const targetId = await insertAssignmentTarget(db, companyId, 'policy', 'T');
    const ruleId = await insertRule(db, companyId, slotId, targetId, 'r', { op: 'always' });
    await insertResolvedAssignment(db as unknown as Db, companyId, employeeId, slotId, targetId, ruleId);

    const before = rule(ruleId, slotId, targetId, { op: 'always' });
    const result = await candidatesForRuleChange(db as unknown as Db, companyId, before, null, new Date('2024-06-01'));
    expect(result).toContain(employeeId);
  });

  it('test_manager_reassignment_includes_both_old_and_new_manager', async () => {
    const companyId = await insertCompany(db, 'cand3');
    const oldManager = await insertEmployee(db, companyId, 'old@example.com');
    const newManager = await insertEmployee(db, companyId, 'new@example.com');
    const subject = await insertEmployee(db, companyId, 'subject@example.com');
    await insertEmploymentRecord(db, companyId, oldManager);
    await insertEmploymentRecord(db, companyId, newManager);
    await insertEmploymentRecord(db, companyId, subject);
    const managerSlot = await insertSlot(db, companyId, 'manager', 'at_most_one', 'employee');
    const oldTarget = await insertAssignmentTarget(db, companyId, 'employee', 'Old');
    const newTarget = await insertAssignmentTarget(db, companyId, 'employee', 'New');
    await insertEmployeeTarget(db as unknown as Db, oldTarget, oldManager);
    await insertEmployeeTarget(db as unknown as Db, newTarget, newManager);

    const ruleId = '00000000-0000-0000-0000-0000000000a2';
    const before = rule(ruleId, managerSlot, oldTarget, { op: 'always' }, 'manual');
    const after = rule(ruleId, managerSlot, newTarget, { op: 'always' }, 'manual');
    const result = await candidatesForRuleChange(db as unknown as Db, companyId, before, after, new Date('2024-06-01'));

    expect(result).toContain(oldManager);
    expect(result).toContain(newManager);
    expect(result).toContain(subject);
  });
});
