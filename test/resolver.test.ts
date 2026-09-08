import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { resolveSlot, resolveEmployee } from '../src/resolver';
import { type EmployeeState, type Predicate } from '../src/predicate';
import type { Rule, Slot } from '../src/types';

function makeState(overrides: Partial<EmployeeState> = {}): EmployeeState {
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

function slot(overrides: Partial<Slot> = {}): Slot {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    companyId: 'c',
    key: 'vacation',
    displayName: 'Vacation',
    cardinality: 'exactly_one',
    targetType: 'policy',
    ...overrides,
  };
}

function rule(overrides: Partial<Rule> = {}): Rule {
  const id = overrides.id ?? '00000000-0000-0000-0000-000000000001';
  const ruleId = overrides.ruleId ?? id;
  const ruleCreatedAt = overrides.ruleCreatedAt ?? new Date('2024-01-01T00:00:00Z');
  return {
    companyId: 'c',
    slotId: '00000000-0000-0000-0000-000000000001',
    targetId: '00000000-0000-0000-0000-000000000010',
    name: 'Rule',
    source: 'rule',
    effect: 'grant',
    priority: 0,
    criteria: { op: 'always' },
    subjectEmployeeId: null,
    createdAt: new Date('2024-01-01T00:00:00Z'),
    ...overrides,
    id,
    ruleId,
    ruleCreatedAt,
  };
}

describe('resolver', () => {
  it('test_exclusive_slot_highest_priority_rule_wins', () => {
    const s = slot({ id: 's1', key: 'vacation' });
    const high = rule({ id: 'r1', slotId: 's1', targetId: 't1', name: 'High', priority: 10 });
    const low = rule({ id: 'r2', slotId: 's1', targetId: 't2', name: 'Low', priority: 5 });
    const state = makeState();

    const res = resolveSlot(s, [high, low], state, new Date());

    expect(res.resolved).toEqual([{ targetId: 't1', winningRuleId: 'r1', winningRuleVersionId: 'r1' }]);
    expect(res.unassignedWarning).toBe(false);
    expect(res.considered.find((c) => c.ruleId === 'r1')?.status).toBe('applied');
    expect(res.considered.find((c) => c.ruleId === 'r2')?.status).toBe('shadowed');
  });

  it('test_manual_override_beats_equal_priority_rule', () => {
    const s = slot({ id: 's1', key: 'vacation' });
    const employeeId = makeState().employee_id;
    const auto = rule({ id: 'r1', slotId: 's1', targetId: 't1', name: 'Auto', priority: 10 });
    const manual = rule({
      id: 'r2',
      slotId: 's1',
      targetId: 't2',
      name: 'Manual',
      source: 'manual',
      subjectEmployeeId: employeeId,
      priority: 10,
    });
    const state = makeState();

    const res = resolveSlot(s, [auto, manual], state, new Date());

    expect(res.resolved).toEqual([{ targetId: 't2', winningRuleId: 'r2', winningRuleVersionId: 'r2' }]);
    expect(res.considered.find((c) => c.ruleId === 'r2')?.status).toBe('applied');
    expect(res.considered.find((c) => c.ruleId === 'r1')?.status).toBe('shadowed');
  });

  it('test_manual_deny_on_exclusive_slot_resolves_to_nothing', () => {
    const s = slot({ id: 's1', key: 'vacation' });
    const employeeId = makeState().employee_id;
    const deny = rule({
      id: 'r1',
      slotId: 's1',
      targetId: 't1',
      name: 'Deny',
      source: 'manual',
      subjectEmployeeId: employeeId,
      effect: 'deny',
      priority: 100,
    });
    const grant = rule({ id: 'r2', slotId: 's1', targetId: 't2', name: 'Grant', priority: 50 });
    const state = makeState();

    const res = resolveSlot(s, [grant, deny], state, new Date());

    expect(res.resolved).toEqual([]);
    expect(res.unassignedWarning).toBe(false);
    expect(res.considered.find((c) => c.ruleId === 'r1')?.status).toBe('denied');
    expect(res.considered.find((c) => c.ruleId === 'r2')?.status).toBe('shadowed');
  });

  it('test_many_slot_unions_all_granting_rules', () => {
    const s = slot({ id: 's1', key: 'apps', cardinality: 'many', targetType: 'app' });
    const r1 = rule({ id: 'r1', slotId: 's1', targetId: 't1', name: 'A', priority: 5 });
    const r2 = rule({ id: 'r2', slotId: 's1', targetId: 't2', name: 'B', priority: 5 });
    const state = makeState();

    const res = resolveSlot(s, [r1, r2], state, new Date());

    expect(res.resolved.length).toBe(2);
    expect(res.resolved.map((r) => r.targetId).sort()).toEqual(['t1', 't2']);
    expect(res.considered.every((c) => c.status === 'applied')).toBe(true);
  });

  it('test_many_slot_manual_deny_removes_group_granted_app', () => {
    const s = slot({ id: 's1', key: 'apps', cardinality: 'many', targetType: 'app' });
    const employeeId = makeState().employee_id;
    const group = rule({ id: 'r1', slotId: 's1', targetId: 't1', name: 'Group grant', priority: 10 });
    const manual = rule({
      id: 'r2',
      slotId: 's1',
      targetId: 't1',
      name: 'Manual deny',
      source: 'manual',
      subjectEmployeeId: employeeId,
      effect: 'deny',
      priority: 10,
    });
    const state = makeState();

    const res = resolveSlot(s, [group, manual], state, new Date());

    expect(res.resolved.find((r) => r.targetId === 't1')).toBeUndefined();
    expect(res.considered.find((c) => c.ruleId === 'r1')?.status).toBe('shadowed');
    expect(res.considered.find((c) => c.ruleId === 'r2')?.status).toBe('denied');
  });

  it('test_resolution_is_stable_across_shuffled_rule_input_order', () => {
    const slotA = slot({ id: 'slotA', key: 'vacation', cardinality: 'exactly_one' });
    const slotB = slot({ id: 'slotB', key: 'apps', cardinality: 'many', targetType: 'app' });
    const employee = makeState();
    const asOf = new Date('2026-01-01T00:00:00Z');

    const ruleArb = fc.record<Rule>({
      id: fc.uuid(),
      ruleId: fc.uuid(),
      ruleCreatedAt: fc.date({ min: new Date('2020-01-01'), max: new Date('2025-01-01') }),
      companyId: fc.constant('c'),
      slotId: fc.constantFrom('slotA', 'slotB'),
      targetId: fc.uuid(),
      name: fc.string({ minLength: 1, maxLength: 10 }),
      source: fc.constantFrom('rule', 'manual'),
      effect: fc.constantFrom('grant', 'deny'),
      priority: fc.integer({ min: 0, max: 20 }),
      criteria: fc.constant<Predicate>({ op: 'always' }),
      subjectEmployeeId: fc.constant(null),
      createdAt: fc.date({ min: new Date('2020-01-01'), max: new Date('2025-01-01') }),
    }).map((r) => ({
      ...r,
      subjectEmployeeId: r.source === 'manual' ? employee.employee_id : null,
    }));

    const pairsArb = fc.array(fc.tuple(ruleArb, fc.integer()), { minLength: 1, maxLength: 20 });

    fc.assert(
      fc.property(pairsArb, (pairs) => {
        const rules = pairs.map(([r]) => r);
        const shuffled = pairs.slice().sort((a, b) => a[1] - b[1]).map(([r]) => r);
        const res1 = resolveEmployee([slotA, slotB], rules, employee, asOf);
        const res2 = resolveEmployee([slotA, slotB], shuffled, employee, asOf);
        expect(res1).toEqual(res2);
      }),
      { numRuns: 100 },
    );
  });

  it('test_exactly_one_slot_with_no_match_sets_unassigned_warning', () => {
    const s = slot({ id: 's1', key: 'vacation' });
    const r = rule({
      id: 'r1',
      slotId: 's1',
      targetId: 't1',
      name: 'Only',
      criteria: { op: 'eq', field: 'department', value: 'Sales' },
    });
    const state = makeState({ department: 'Engineering' });

    const res = resolveSlot(s, [r], state, new Date());

    expect(res.resolved).toEqual([]);
    expect(res.unassignedWarning).toBe(true);
    expect(res.considered[0].status).toBe('not_matched');
  });

  it('test_explain_trace_names_the_shadowing_rule', () => {
    const s = slot({ id: 's1', key: 'vacation' });
    const winner = rule({ id: 'r1', slotId: 's1', targetId: 't1', name: 'Winner', priority: 10 });
    const loser = rule({ id: 'r2', slotId: 's1', targetId: 't2', name: 'Loser', priority: 5 });
    const state = makeState();

    const res = resolveSlot(s, [winner, loser], state, new Date());

    const loserConsidered = res.considered.find((c) => c.ruleId === 'r2');
    expect(loserConsidered?.status).toBe('shadowed');
    expect(loserConsidered?.reason).toContain('Winner');
    expect(loserConsidered?.trace.op).toBe('always');
  });

  it('test_manual_override_beats_higher_priority_automatic_rule', () => {
    // M1: ordering position is the invariant. An automatic rule at priority 200
    // must not beat a manual override at priority 100.
    const s = slot({ id: 's1', key: 'vacation' });
    const employeeId = makeState().employee_id;
    const auto = rule({ id: 'r1', slotId: 's1', targetId: 't1', name: 'Auto', priority: 200 });
    const manual = rule({
      id: 'r2',
      slotId: 's1',
      targetId: 't2',
      name: 'Manual',
      source: 'manual',
      subjectEmployeeId: employeeId,
      priority: 100,
    });
    const state = makeState();

    const res = resolveSlot(s, [auto, manual], state, new Date());

    expect(res.resolved).toEqual([{ targetId: 't2', winningRuleId: 'r2', winningRuleVersionId: 'r2' }]);
    expect(res.considered.find((c) => c.ruleId === 'r2')?.status).toBe('applied');
    expect(res.considered.find((c) => c.ruleId === 'r1')?.status).toBe('shadowed');
  });

  it('test_manual_override_with_default_zero_priority_still_wins', () => {
    // The write path defaults manual priority to 0; precedence must not depend
    // on that convention being maintained.
    const s = slot({ id: 's1', key: 'vacation' });
    const employeeId = makeState().employee_id;
    const auto = rule({ id: 'r1', slotId: 's1', targetId: 't1', name: 'Auto', priority: 50 });
    const manual = rule({
      id: 'r2',
      slotId: 's1',
      targetId: 't2',
      name: 'Manual',
      source: 'manual',
      subjectEmployeeId: employeeId,
      priority: 0,
    });
    const state = makeState();

    const res = resolveSlot(s, [auto, manual], state, new Date());

    expect(res.resolved).toEqual([{ targetId: 't2', winningRuleId: 'r2', winningRuleVersionId: 'r2' }]);
  });

  it('test_priority_still_orders_two_manual_rules', () => {
    // Manual precedes priority only ACROSS sources. Within manual rules,
    // priority is still the ordering term.
    const s = slot({ id: 's1', key: 'vacation' });
    const employeeId = makeState().employee_id;
    const low = rule({
      id: 'r1', slotId: 's1', targetId: 't1', name: 'LowManual',
      source: 'manual', subjectEmployeeId: employeeId, priority: 5,
    });
    const high = rule({
      id: 'r2', slotId: 's1', targetId: 't2', name: 'HighManual',
      source: 'manual', subjectEmployeeId: employeeId, priority: 10,
    });
    const state = makeState();

    const res = resolveSlot(s, [low, high], state, new Date());

    expect(res.resolved).toEqual([{ targetId: 't2', winningRuleId: 'r2', winningRuleVersionId: 'r2' }]);
    expect(res.considered.find((c) => c.ruleId === 'r1')?.status).toBe('shadowed');
  });
});
