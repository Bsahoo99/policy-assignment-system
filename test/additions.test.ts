import { describe, it, expect } from 'vitest';
import { analyzeHealth, type RuleMeta, type SlotOutcome } from '../src/health.js';
import { summarize, describeFailure, whyNot } from '../src/explain-text.js';
import { evaluate, type Predicate, type EmployeeState } from '../src/predicate.js';

const jane: EmployeeState = {
  employee_id: 'e1',
  department: 'Sales',
  location_state: 'NY',
  location_country: 'US',
  employment_type: 'w2_employee',
  pay_type: 'salary',
  tenure_start_date: '2024-03-15',
  direct_report_count: 0,
  group_keys: ['us-payroll'],
};
const NOW = new Date('2026-01-01T00:00:00Z');
const trace = (p: Predicate) => evaluate(p, jane, NOW).trace;

describe('explain in admin language', () => {
  it('test_failed_attribute_condition_reads_as_a_sentence', () => {
    const t = trace({ op: 'eq', field: 'location_state', value: 'CA' });
    expect(summarize(t)).toBe('their work state is NY, but this rule needs CA.');
  });

  it('test_only_the_failing_branch_of_an_and_is_blamed', () => {
    // department matches, state does not. Blaming both would be noise.
    const t = trace({
      op: 'and',
      children: [
        { op: 'eq', field: 'department', value: 'Sales' },
        { op: 'eq', field: 'location_state', value: 'CA' },
      ],
    });
    const reasons = describeFailure(t);
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain('work state');
  });

  it('test_every_branch_of_a_failed_or_is_reported', () => {
    const t = trace({
      op: 'or',
      children: [
        { op: 'eq', field: 'location_state', value: 'CA' },
        { op: 'eq', field: 'location_state', value: 'TX' },
      ],
    });
    expect(describeFailure(t)).toHaveLength(2);
  });

  it('test_exclusion_rule_explains_what_was_excluded', () => {
    const t = trace({ op: 'not', child: { op: 'in_group', group: 'us-payroll' } });
    expect(summarize(t)).toBe('they are in the us-payroll group, which this rule excludes.');
  });

  it('test_unmet_tenure_names_the_date_it_will_be_met', () => {
    const t = trace({ op: 'gte_tenure', years: 5 });
    expect(summarize(t)).toBe('this rule needs 5 years of tenure, reached on 2029-03-15.');
  });

  it('test_unset_attribute_says_so_rather_than_showing_null', () => {
    const t = evaluate({ op: 'eq', field: 'department', value: 'Sales' },
      { ...jane, department: null }, NOW).trace;
    expect(summarize(t)).toContain('is not set');
  });

  it('test_why_not_answers_per_candidate_rule', () => {
    const out = whyNot('GitHub Access', [
      { ruleName: 'Engineering GitHub', trace: trace({ op: 'eq', field: 'department', value: 'Engineering' }) },
      { ruleName: 'Manager GitHub', trace: trace({ op: 'is_manager' }) },
    ]);
    expect(out.reasons[0].because).toContain('department is Sales');
    expect(out.reasons[1].because).toContain('do not manage anyone');
  });
});

describe('rule health', () => {
  const rules: RuleMeta[] = [
    { ruleId: 'r-live', name: 'CA Vacation', slotKey: 'vacation', source: 'rule', priority: 100 },
    { ruleId: 'r-shadow', name: 'Default Vacation', slotKey: 'vacation', source: 'rule', priority: 10 },
    { ruleId: 'r-dead', name: 'Nevada Vacation', slotKey: 'vacation', source: 'rule', priority: 50 },
    { ruleId: 'r-tie-a', name: 'Contractor Apps', slotKey: 'app_access', source: 'rule', priority: 20, targetId: 't-slack' },
    { ruleId: 'r-tie-b', name: 'Sales Apps', slotKey: 'app_access', source: 'rule', priority: 20, targetId: 't-github' },
  ];

  const outcomes: SlotOutcome[] = [
    {
      employeeId: 'e1', slotKey: 'vacation', cardinality: 'exactly_one',
      resolvedTargetIds: ['t1'],
      considered: [
        { ruleId: 'r-live', status: 'applied' },
        { ruleId: 'r-shadow', status: 'shadowed' },
        { ruleId: 'r-dead', status: 'not_matched' },
      ],
    },
    {
      employeeId: 'e2', slotKey: 'vacation', cardinality: 'exactly_one',
      resolvedTargetIds: [],
      considered: [{ ruleId: 'r-dead', status: 'not_matched' }],
    },
    {
      // exactly_one: a priority tie means the winner is the stable id tiebreak,
      // which nobody chose. In a `many` slot the same tie is not a collision —
      // every matching grant applies, so there is no winner to dispute.
      employeeId: 'e1', slotKey: 'app_access', cardinality: 'exactly_one',
      resolvedTargetIds: ['a1'],
      considered: [
        { ruleId: 'r-tie-a', status: 'applied' },
        { ruleId: 'r-tie-b', status: 'shadowed' },
      ],
    },
  ];

  const report = analyzeHealth(rules, outcomes);
  const byId = (id: string) => report.rules.find((r) => r.ruleId === id)!;

  it('test_rule_matching_nobody_is_flagged_dead', () => {
    expect(byId('r-dead').verdict).toBe('dead');
  });

  it('test_rule_that_matches_but_never_wins_is_flagged_shadowed', () => {
    expect(byId('r-shadow').verdict).toBe('always_shadowed');
    expect(byId('r-shadow').detail).toContain('never decides the outcome');
  });

  it('test_rule_that_wins_at_least_once_is_healthy', () => {
    expect(byId('r-live').verdict).toBe('healthy');
    expect(byId('r-live').appliedCount).toBe(1);
  });

  it('test_equal_priority_rules_matching_one_employee_are_a_collision', () => {
    expect(report.collisions).toHaveLength(1);
    expect(report.collisions[0].slotKey).toBe('app_access');
    expect(report.collisions[0].ruleIds.sort()).toEqual(['r-tie-a', 'r-tie-b']);
  });

  it('test_collision_detail_names_both_rules_and_suggests_the_fix', () => {
    const d = report.collisions[0].detail;
    expect(d).toContain('Contractor Apps');
    expect(d).toContain('Sales Apps');
    expect(d).toContain('distinct priorities');
  });

  it('test_many_slot_equal_priority_is_not_a_collision', () => {
    // Browser review 2026-09-05: Slack and GitHub shared a priority in the
    // many-valued apps slot and were flagged as colliding, while both were
    // correctly assigned. Rules on DIFFERENT targets in a `many` slot never
    // compete — every matching grant applies.
    const manyOutcome: SlotOutcome[] = [{
      employeeId: 'e1', slotKey: 'app_access', cardinality: 'many',
      resolvedTargetIds: ['t-slack', 't-github'],
      considered: [
        { ruleId: 'r-tie-a', status: 'applied' },
        { ruleId: 'r-tie-b', status: 'applied' },
      ],
    }];
    expect(analyzeHealth(rules, manyOutcome).collisions).toHaveLength(0);
  });

  it('test_many_slot_same_target_grant_deny_tie_is_a_collision', () => {
    // Same review, corrected scope: a grant and a deny at equal priority on the
    // SAME target still compete in a `many` slot — the resolver picks one winner
    // per targetId by stable tiebreak, which nobody chose.
    const grant: RuleMeta = { ruleId: 'r-g', name: 'Grant Slack', slotKey: 'apps', source: 'rule', priority: 30, targetId: 't-slack' };
    const deny: RuleMeta = { ruleId: 'r-d', name: 'Deny Slack', slotKey: 'apps', source: 'rule', priority: 30, targetId: 't-slack' };
    const outcomes: SlotOutcome[] = [{
      employeeId: 'e1', slotKey: 'apps', cardinality: 'many',
      resolvedTargetIds: [],
      considered: [
        { ruleId: 'r-g', status: 'shadowed' },
        { ruleId: 'r-d', status: 'denied' },
      ],
    }];
    const report = analyzeHealth([grant, deny], outcomes);
    expect(report.collisions).toHaveLength(1);
    expect(report.collisions[0].ruleIds.sort()).toEqual(['r-d', 'r-g']);
  });

  it('test_required_slot_with_no_resolution_is_reported_unfilled', () => {
    expect(report.unfilled).toHaveLength(1);
    expect(report.unfilled[0].slotKey).toBe('vacation');
    expect(report.unfilled[0].employeeCount).toBe(1);
  });

  it('test_many_cardinality_slot_is_never_reported_unfilled', () => {
    expect(report.unfilled.some((u) => u.slotKey === 'app_access')).toBe(false);
  });
});

/**
 * The cases the first 14 tests missed. Both defects were reproduced by review against
 * real resolver output while the suite stayed green, which is the fourth time in this
 * project that a test could not see the bug it was written for. The pattern: the fixture
 * only exercised the shape I had already thought about.
 */
describe('cases the original suite could not see', () => {
  it('test_satisfied_exclusion_rule_explains_itself_not_applies_to_everyone', () => {
    // NOT contractors, evaluated for a W-2 employee. The rule matched, and the reason is
    // the exclusion being satisfied. Reporting nothing read as "applies to everyone".
    const t = trace({ op: 'not', child: { op: 'eq', field: 'employment_type', value: 'contractor' } });
    expect(t.matched).toBe(true);
    expect(summarize(t)).toBe('their employment type is not contractor.');
  });

  it('test_nested_exclusion_explains_the_leaf_not_the_composite', () => {
    // Previously produced "2/2 conditions met" by negating the composite node.
    const t = trace({
      op: 'not',
      child: {
        op: 'and',
        children: [
          { op: 'eq', field: 'department', value: 'Sales' },
          { op: 'eq', field: 'location_state', value: 'NY' },
        ],
      },
    });
    expect(t.matched).toBe(false);
    const s = summarize(t);
    expect(s).not.toContain('conditions met');
    expect(s).toContain('which this rule excludes');
  });

  it('test_exclusion_of_a_group_the_employee_is_not_in_reads_naturally', () => {
    const t = trace({ op: 'not', child: { op: 'in_group', group: 'contractors' } });
    expect(summarize(t)).toBe('they are not in the contractors group.');
  });

  it('test_double_negation_returns_to_positive_phrasing', () => {
    const t = trace({ op: 'not', child: { op: 'not', child: { op: 'eq', field: 'department', value: 'Sales' } } });
    expect(t.matched).toBe(true);
    expect(summarize(t)).toBe('their department is Sales.');
  });

  it('test_winning_denial_is_decisive_not_shadowed', () => {
    const rules: RuleMeta[] = [
      { ruleId: 'r-deny', name: 'No vacation for interns', slotKey: 'vacation', source: 'manual', priority: 0 },
      { ruleId: 'r-grant', name: 'Default Vacation', slotKey: 'vacation', source: 'rule', priority: 100 },
    ];
    const outcomes: SlotOutcome[] = [{
      employeeId: 'e9', slotKey: 'vacation', cardinality: 'exactly_one',
      resolvedTargetIds: [],
      considered: [
        { ruleId: 'r-deny', status: 'denied' },
        { ruleId: 'r-grant', status: 'shadowed' },
      ],
    }];
    const report = analyzeHealth(rules, outcomes);
    expect(report.rules.find((r) => r.ruleId === 'r-deny')!.verdict).toBe('healthy');
    expect(report.rules.find((r) => r.ruleId === 'r-grant')!.verdict).toBe('always_shadowed');
  });

  it('test_slot_emptied_by_a_denial_says_so_instead_of_no_override_set', () => {
    const rules: RuleMeta[] = [
      { ruleId: 'r-deny', name: 'No vacation for interns', slotKey: 'vacation', source: 'manual', priority: 0 },
    ];
    const outcomes: SlotOutcome[] = [{
      employeeId: 'e9', slotKey: 'vacation', cardinality: 'exactly_one',
      resolvedTargetIds: [],
      considered: [{ ruleId: 'r-deny', status: 'denied' }],
    }];
    const d = analyzeHealth(rules, outcomes).unfilled[0].detail;
    expect(d).toContain('No vacation for interns');
    expect(d).not.toContain('no manual override was set');
  });

  it('test_uncovered_and_denied_employees_are_reported_separately', () => {
    const rules: RuleMeta[] = [
      { ruleId: 'r-deny', name: 'Denial', slotKey: 'vacation', source: 'manual', priority: 0 },
    ];
    const outcomes: SlotOutcome[] = [
      { employeeId: 'a', slotKey: 'vacation', cardinality: 'exactly_one', resolvedTargetIds: [], considered: [{ ruleId: 'r-deny', status: 'denied' }] },
      { employeeId: 'b', slotKey: 'vacation', cardinality: 'exactly_one', resolvedTargetIds: [], considered: [] },
    ];
    const u = analyzeHealth(rules, outcomes).unfilled;
    expect(u).toHaveLength(2);
    expect(u.map((x) => x.employeeCount)).toEqual([1, 1]);
  });
});
