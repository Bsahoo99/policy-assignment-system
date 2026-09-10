import { describe, it, expect } from 'vitest';
import {
  expandDynamicGroups,
  nextMaterialDateForRule,
  nextMaterialDate,
  evaluate,
  type Predicate,
  type EmployeeState,
} from '../src/predicate.js';

const jane: EmployeeState = {
  employee_id: '11111111-1111-1111-1111-111111111111',
  department: 'Engineering',
  location_state: 'CA',
  location_country: 'US',
  employment_type: 'w2_employee',
  pay_type: 'salary',
  tenure_start_date: '2024-03-15',
  direct_report_count: 0,
  group_keys: [],
};

const twoYearClub = new Map<string, Predicate>([
  ['two-year-club', { op: 'gte_tenure', years: 2 }],
]);

describe('dynamic group expansion', () => {
  it('test_tenure_threshold_inside_dynamic_group_is_invisible_without_expansion', () => {
    // The bug, stated as a test. The rule mentions no tenure at all.
    const rule: Predicate = { op: 'in_group', group: 'two-year-club' };
    expect(nextMaterialDate(rule, jane, new Date('2025-01-01Z'))).toBeNull();
  });

  it('test_tenure_threshold_inside_dynamic_group_is_found_after_expansion', () => {
    const rule: Predicate = { op: 'in_group', group: 'two-year-club' };
    const next = nextMaterialDateForRule(rule, twoYearClub, jane, new Date('2025-01-01Z'));
    expect(next?.toISOString().slice(0, 10)).toBe('2026-03-15');
  });

  it('test_static_group_reference_is_left_untouched', () => {
    const rule: Predicate = { op: 'in_group', group: 'eng-leads' };
    expect(expandDynamicGroups(rule, twoYearClub)).toEqual(rule);
  });

  it('test_expansion_reaches_nested_predicates', () => {
    const rule: Predicate = {
      op: 'and',
      children: [
        { op: 'eq', field: 'location_state', value: 'CA' },
        { op: 'not', child: { op: 'in_group', group: 'two-year-club' } },
      ],
    };
    const next = nextMaterialDateForRule(rule, twoYearClub, jane, new Date('2025-01-01Z'));
    expect(next?.toISOString().slice(0, 10)).toBe('2026-03-15');
  });

  it('test_group_referencing_another_group_is_rejected_loudly', () => {
    const bad = new Map<string, Predicate>([
      ['a', { op: 'in_group', group: 'b' }],
      ['b', { op: 'gte_tenure', years: 2 }],
    ]);
    expect(() => expandDynamicGroups({ op: 'in_group', group: 'a' }, bad)).toThrow(/D11/);
  });

  it('test_earliest_threshold_wins_across_rule_and_group', () => {
    const rule: Predicate = {
      op: 'and',
      children: [{ op: 'gte_tenure', years: 5 }, { op: 'in_group', group: 'two-year-club' }],
    };
    const next = nextMaterialDateForRule(rule, twoYearClub, jane, new Date('2025-01-01Z'));
    expect(next?.toISOString().slice(0, 10)).toBe('2026-03-15');
  });
});

/**
 * A predicate bounded on both sides changes value at each of its thresholds in
 * turn. Pinned because a proposed scheduling design tried to decide materiality
 * by forcing every threshold to a constant, which reports this predicate as
 * false in both directions while the real answer is true between the first and
 * second anniversary. A false negative here means an anniversary job is never
 * scheduled, so the counterexample is worth keeping in the suite.
 */
describe('nextMaterialDate over multiple thresholds', () => {
  const between1And2: Predicate = {
    op: 'and',
    children: [
      { op: 'gte_tenure', years: 1 },
      { op: 'not', child: { op: 'gte_tenure', years: 2 } },
    ],
  };
  const hire2024 = {
    employee_id: 'e',
    department: 'Engineering',
    location_state: 'CA',
    location_country: 'US',
    employment_type: 'w2_employee' as const,
    pay_type: 'salary' as const,
    tenure_start_date: '2024-01-01',
    direct_report_count: 0,
    group_keys: [] as string[],
  };
  const on = (iso: string) => new Date(`${iso}T00:00:00Z`);
  const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

  it('test_next_material_date_returns_each_threshold_in_turn', () => {
    expect(day(nextMaterialDate(between1And2, hire2024, on('2024-06-01')))).toBe('2025-01-01');
    expect(day(nextMaterialDate(between1And2, hire2024, on('2025-06-01')))).toBe('2026-01-01');
    expect(day(nextMaterialDate(between1And2, hire2024, on('2026-06-01')))).toBeNull();
  });

  it('test_predicate_bounded_on_both_sides_is_true_only_between_its_thresholds', () => {
    expect(evaluate(between1And2, hire2024, on('2024-06-01')).matched).toBe(false);
    expect(evaluate(between1And2, hire2024, on('2025-06-01')).matched).toBe(true);
    expect(evaluate(between1And2, hire2024, on('2026-06-01')).matched).toBe(false);
  });
});
