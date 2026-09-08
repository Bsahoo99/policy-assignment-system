import type { Predicate, TraceNode } from './predicate';

export type Cardinality = 'exactly_one' | 'at_most_one' | 'many';
export type TargetType = 'policy' | 'app' | 'pay_schedule' | 'employee';
export type RuleSource = 'rule' | 'manual';
export type Effect = 'grant' | 'deny';

/**
 * The only employment types the system understands. Derived once, enforced by a
 * CHECK constraint on employment_records.employment_type, and the only values
 * any form is allowed to offer. `full_time`/`part_time` are deliberately absent:
 * they are not what the seed data or rules use.
 */
export const EMPLOYMENT_TYPES = ['w2_employee', 'contractor', 'intern'] as const;
export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];

export const PAY_TYPES = ['salary', 'hourly'] as const;
export type PayType = (typeof PAY_TYPES)[number];

export interface Slot {
  id: string;
  companyId: string;
  key: string;
  displayName: string;
  cardinality: Cardinality;
  targetType: TargetType;
}

export interface Rule {
  /** Surrogate primary key for this version row. */
  id: string;
  /** Timeline key: the logical rule id that versions of the same rule share. */
  ruleId: string;
  /** When the LOGICAL rule was first authored; stable across versions and remnants. */
  ruleCreatedAt: Date;
  companyId: string;
  slotId: string;
  targetId: string;
  name: string;
  source: RuleSource;
  effect: Effect;
  priority: number;
  criteria: Predicate;
  subjectEmployeeId: string | null;
  /** When THIS VERSION ROW was written. Row metadata; not read by resolution. */
  createdAt: Date;
}

export interface Target {
  id: string;
  targetType: TargetType;
  displayName: string;
}

export interface ResolvedAssignment {
  employeeId: string;
  slotId: string;
  targetId: string;
  winningRuleId: string;
  winningRuleVersionId: string;
  validFrom: Date;
  validTo: Date | null;
}

export interface ConsideredRule {
  ruleId: string;
  ruleName: string;
  matched: boolean;
  status: 'applied' | 'shadowed' | 'denied' | 'not_matched';
  reason: string;
  trace: TraceNode;
}

export interface SlotResolution {
  slotKey: string;
  cardinality: Cardinality;
  resolved: { targetId: string; winningRuleId: string; winningRuleVersionId: string }[];
  unassignedWarning: boolean;
  considered: ConsideredRule[];
}

export interface EmployeeResolution {
  employeeId: string;
  asOf: Date;
  slots: SlotResolution[];
  assignments: ResolvedAssignment[];
}

export interface SlotDependency {
  companyId: string;
  slotId: string;
  dependsOnSlotId: string;
}

export interface ReconcileResult {
  changed: boolean;
  assignments: ResolvedAssignment[];
}

export interface Queue {
  send(name: string, data: object): Promise<void>;
}

export type { EmployeeState } from './predicate';
