import { buildEmployeeState, deriveGroupKeys, getDynamicGroups } from './state';
import { resolveEmployee } from './resolver';
import { topoOrder } from './cascade';
import { assignmentKey, fetchCurrentAssignments, fetchDeps, fetchRules, fetchSlots } from './reconcile';
import type { Db } from './db';
import type { EmployeeState } from './predicate';
import type { Rule, SlotResolution } from './types';

export interface FactPatch {
  department?: string | null;
  location_state?: string | null;
  location_country?: string;
  employment_type?: import('./types').EmploymentType;
  pay_type?: import('./types').PayType;
  tenure_start_date?: string | Date;
}

export interface SimulateItem {
  slotId: string;
  targetId: string;
  winningRuleId: string;
  reason: string;
  trace?: unknown;
}

export interface SimulateResult {
  added: SimulateItem[];
  removed: SimulateItem[];
  unchanged: SimulateItem[];
}

/**
 * The one place the "who gains / who loses" diff lives. simulate() diffs a
 * hypothetical resolution against stored rows; previewRuleImpact() diffs two
 * resolutions against each other. Both are the same (slotId, targetId) set
 * difference, so they share this helper rather than drifting.
 */
export function diffAssignments(
  before: { slotId: string; targetId: string }[],
  after: { slotId: string; targetId: string }[],
): { added: { slotId: string; targetId: string }[]; removed: { slotId: string; targetId: string }[] } {
  const b = new Set(before.map((a) => `${a.slotId}:${a.targetId}`));
  const a = new Set(after.map((x) => `${x.slotId}:${x.targetId}`));
  return {
    added: after.filter((x) => !b.has(`${x.slotId}:${x.targetId}`)),
    removed: before.filter((x) => !a.has(`${x.slotId}:${x.targetId}`)),
  };
}

function ruleName(rules: Rule[], id: string): string {
  return rules.find((r) => r.ruleId === id)?.name ?? id;
}

function applyPatch(state: EmployeeState, patch: FactPatch): EmployeeState {
  const tenure = patch.tenure_start_date
    ? (patch.tenure_start_date instanceof Date ? patch.tenure_start_date.toISOString().slice(0, 10) : String(patch.tenure_start_date).slice(0, 10))
    : state.tenure_start_date;
  return {
    ...state,
    department: patch.department !== undefined ? patch.department : state.department,
    location_state: patch.location_state !== undefined ? patch.location_state : state.location_state,
    location_country: patch.location_country ?? state.location_country,
    employment_type: patch.employment_type ?? state.employment_type,
    pay_type: patch.pay_type ?? state.pay_type,
    tenure_start_date: tenure,
    group_keys: state.group_keys,
  };
}

export async function simulateEmployee(
  db: Db,
  companyId: string,
  employeeId: string,
  effectiveAt: Date,
  systemAt: Date,
  patch?: FactPatch,
): Promise<SimulateResult> {
  const [slots, deps, rules, dynamicGroups] = await Promise.all([
    fetchSlots(db, companyId),
    fetchDeps(db, companyId),
    fetchRules(db, companyId, employeeId, effectiveAt, systemAt),
    getDynamicGroups(db, companyId),
  ]);

  const orderedSlots = topoOrder(slots, deps);
  const currentState = await buildEmployeeState(db, companyId, employeeId, effectiveAt, systemAt);
  const base: EmployeeState = patch ? applyPatch(currentState, patch) : currentState;
  base.group_keys = deriveGroupKeys(base, dynamicGroups, effectiveAt);
  const resolution = resolveEmployee(orderedSlots, rules, base, effectiveAt);
  const current = await fetchCurrentAssignments(db, companyId, employeeId, effectiveAt, systemAt);

  const desired = new Map(resolution.assignments.map((a) => [assignmentKey(a.slotId, a.targetId), a]));
  const slotsByKey = new Map(slots.map((s) => [s.key, s]));
  const slotResBySlotId = new Map<string, SlotResolution>(
    resolution.slots.map((sr) => [slotsByKey.get(sr.slotKey)!.id, sr]),
  );

  const added: SimulateItem[] = [];
  const removed: SimulateItem[] = [];
  const unchanged: SimulateItem[] = [];

  for (const [key, row] of current) {
    const wanted = desired.get(key);
    const trace = row.explain_trace;
    if (!wanted) {
      removed.push({ slotId: row.slot_id, targetId: row.target_id, winningRuleId: row.winning_rule_id, reason: 'no longer matched', trace });
    } else if (wanted.winningRuleId !== row.winning_rule_id) {
      removed.push({ slotId: row.slot_id, targetId: row.target_id, winningRuleId: row.winning_rule_id, reason: 'superseded by higher-priority rule', trace });
    }
  }

  for (const [key, assignment] of desired) {
    const row = current.get(key);
    const trace = slotResBySlotId.get(assignment.slotId);
    if (!row) {
      added.push({
        slotId: assignment.slotId,
        targetId: assignment.targetId,
        winningRuleId: assignment.winningRuleId,
        reason: `matched by ${ruleName(rules, assignment.winningRuleId)}`,
        trace,
      });
    } else if (row.winning_rule_id === assignment.winningRuleId) {
      unchanged.push({
        slotId: assignment.slotId,
        targetId: assignment.targetId,
        winningRuleId: assignment.winningRuleId,
        reason: 'already assigned',
        trace,
      });
    } else {
      added.push({
        slotId: assignment.slotId,
        targetId: assignment.targetId,
        winningRuleId: assignment.winningRuleId,
        reason: `matched by ${ruleName(rules, assignment.winningRuleId)}`,
        trace,
      });
    }
  }

  return { added, removed, unchanged };
}

/**
 * Resolve a hypothetical new hire who has no rows in the database yet. Used by
 * the onboarding preview: everything the resolver grants is reported as `added`.
 */
export async function simulateNewHire(
  db: Db,
  companyId: string,
  effectiveAt: Date,
  systemAt: Date,
  state: EmployeeState,
): Promise<SimulateResult> {
  const [slots, deps, rules, dynamicGroups] = await Promise.all([
    fetchSlots(db, companyId),
    fetchDeps(db, companyId),
    fetchRules(db, companyId, state.employee_id, effectiveAt, systemAt),
    getDynamicGroups(db, companyId),
  ]);
  const orderedSlots = topoOrder(slots, deps);
  state.group_keys = deriveGroupKeys(state, dynamicGroups, effectiveAt);
  const resolution = resolveEmployee(orderedSlots, rules, state, effectiveAt);
  const added: SimulateItem[] = resolution.assignments.map((a) => ({
    slotId: a.slotId,
    targetId: a.targetId,
    winningRuleId: a.winningRuleId,
    reason: 'matched',
  }));
  return { added, removed: [], unchanged: [] };
}
