import { candidatesForRuleChange } from './candidates';
import { fetchDeps, fetchRules, fetchSlots } from './reconcile';
import { resolveEmployee } from './resolver';
import { topoOrder } from './cascade';
import { buildEmployeeState, deriveGroupKeys, getDynamicGroups } from './state';
import { diffAssignments } from './simulate';
import type { Db } from './db';
import type { Rule, ResolvedAssignment, SlotResolution } from './types';

/** How many affected employees the preview resolves before stopping. */
export const PREVIEW_LIMIT = 25;

export interface ImpactChange {
  slotId: string;
  slotKey: string;
  targetId: string;
  reason: string;
}

export interface ImpactedEmployee {
  employeeId: string;
  firstName: string;
  lastName: string;
  added: ImpactChange[];
  removed: ImpactChange[];
}

export interface RuleImpactPreview {
  impacted: ImpactedEmployee[];
  /** Total reconciliation candidates the rule change touches. */
  totalCandidates: number;
  /** True when `impacted` is capped at PREVIEW_LIMIT. */
  truncated: boolean;
}

/**
 * Candidates are who we have to look at; impact is who actually gains or loses
 * an assignment. Those are different sets — a candidate whose outcome is
 * unchanged is not impact. For each candidate, resolve under the current rule
 * set and under the proposed one, keep only employees with a non-empty diff,
 * and carry the explain reason for the winning rule.
 */
export async function previewRuleImpact(
  db: Db,
  companyId: string,
  before: Rule | null,
  after: Rule | null,
  effectiveAt: Date,
  systemAt: Date,
  limit = PREVIEW_LIMIT,
): Promise<RuleImpactPreview> {
  const candidateIds = await candidatesForRuleChange(db, companyId, before, after, effectiveAt, systemAt);
  if (candidateIds.length === 0) return { impacted: [], totalCandidates: 0, truncated: false };

  const [slots, deps, dynamicGroups] = await Promise.all([
    fetchSlots(db, companyId),
    fetchDeps(db, companyId),
    getDynamicGroups(db, companyId),
  ]);
  const orderedSlots = topoOrder(slots, deps);
  const slotKeyById = new Map(slots.map((s) => [s.id, s.key]));

  const reasonFor = (
    resolution: { slots: SlotResolution[] },
    assignment: ResolvedAssignment,
  ): string => {
    const slot = resolution.slots.find((sr) => slotKeyById.get(assignment.slotId) === sr.slotKey);
    const considered = slot?.considered.find((c) => c.ruleId === assignment.winningRuleId);
    return considered?.reason ?? 'matched';
  };

  const impacted: ImpactedEmployee[] = [];
  let truncated = false;

  for (const employeeId of candidateIds) {
    if (impacted.length >= limit) { truncated = true; break; }
    const [rulesNow, state] = await Promise.all([
      fetchRules(db, companyId, employeeId, effectiveAt, systemAt),
      buildEmployeeState(db, companyId, employeeId, effectiveAt, systemAt),
    ]);
    state.group_keys = deriveGroupKeys(state, dynamicGroups, effectiveAt);

    // The proposed rule set: remove the outgoing version of the rule (if any)
    // and add the incoming one (if any). Everything else is identical.
    const rulesAfter = rulesNow.filter((r) => r.ruleId !== (before?.ruleId ?? after?.ruleId));
    if (after) rulesAfter.push(after);

    const beforeRes = resolveEmployee(orderedSlots, rulesNow, state, effectiveAt);
    const afterRes = resolveEmployee(orderedSlots, rulesAfter, state, effectiveAt);
    const { added, removed } = diffAssignments(beforeRes.assignments, afterRes.assignments);
    if (added.length === 0 && removed.length === 0) continue;

    const { rows } = await db.query<{ id: string; first_name: string; last_name: string }>(
      'SELECT id, first_name, last_name FROM employees WHERE company_id = $1 AND id = $2',
      [companyId, employeeId],
    );
    const emp = rows[0];

    impacted.push({
      employeeId,
      firstName: emp?.first_name ?? '',
      lastName: emp?.last_name ?? '',
      added: added.map((a) => ({
        slotId: a.slotId,
        slotKey: slotKeyById.get(a.slotId) ?? a.slotId,
        targetId: a.targetId,
        reason: reasonFor(afterRes, afterRes.assignments.find((x) => x.slotId === a.slotId && x.targetId === a.targetId)!),
      })),
      removed: removed.map((r) => ({
        slotId: r.slotId,
        slotKey: slotKeyById.get(r.slotId) ?? r.slotId,
        targetId: r.targetId,
        reason: reasonFor(beforeRes, beforeRes.assignments.find((x) => x.slotId === r.slotId && x.targetId === r.targetId)!),
      })),
    });
  }
  return { impacted, totalCandidates: candidateIds.length, truncated };
}
