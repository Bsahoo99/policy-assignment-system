/**
 * Rule health.
 *
 * The observation this comes from: in a real HR system nobody deletes rules. They
 * accumulate for years, people leave, and no admin can tell you which of the 40 rules in
 * the vacation slot still do anything. The engine already knows, because it evaluates
 * every rule against every employee on every reconciliation and throws the result away.
 *
 * Nothing here needs new machinery. It is the resolver's existing per-rule verdicts,
 * aggregated across the population instead of discarded.
 */

export type RuleStatus = 'applied' | 'shadowed' | 'denied' | 'not_matched';

/** Minimal shape of one rule's verdict for one employee, from SlotResolution.considered. */
export interface Verdict {
  ruleId: string;
  status: RuleStatus;
}

/** Minimal shape of one employee's resolution of one slot. */
export interface SlotOutcome {
  employeeId: string;
  slotKey: string;
  cardinality: 'exactly_one' | 'at_most_one' | 'many';
  resolvedTargetIds: string[];
  considered: Verdict[];
}

export interface RuleMeta {
  ruleId: string;
  name: string;
  slotKey: string;
  source: 'rule' | 'manual';
  priority: number;
  /** Required for per-target collision checks in `many` slots. */
  targetId?: string;
  targetName?: string;
}

export interface RuleHealth {
  ruleId: string;
  name: string;
  slotKey: string;
  matchCount: number;
  appliedCount: number;
  /** 'dead' matched nobody. 'always_shadowed' matched people but never won. */
  verdict: 'healthy' | 'dead' | 'always_shadowed';
  detail: string;
}

export interface Collision {
  slotKey: string;
  ruleIds: string[];
  priority: number;
  source: 'rule' | 'manual';
  affectedEmployeeCount: number;
  detail: string;
}

export interface UnfilledSlot {
  slotKey: string;
  employeeCount: number;
  detail: string;
}

export interface HealthReport {
  rules: RuleHealth[];
  collisions: Collision[];
  unfilled: UnfilledSlot[];
}

export function analyzeHealth(rules: RuleMeta[], outcomes: SlotOutcome[]): HealthReport {
  const matched = new Map<string, number>();
  const decisive = new Map<string, number>();

  for (const o of outcomes) {
    for (const v of o.considered) {
      if (v.status === 'not_matched') continue;
      bump(matched, v.ruleId);
      // A rule that WON by denying had just as much effect as one that won by granting.
      // Counting only 'applied' reported a winning manual denial as having no effect,
      // which is the opposite of the truth: it is the reason the slot is empty.
      if (v.status === 'applied' || v.status === 'denied') bump(decisive, v.ruleId);
    }
  }

  const ruleHealth: RuleHealth[] = rules.map((r) => {
    const m = matched.get(r.ruleId) ?? 0;
    const a = decisive.get(r.ruleId) ?? 0;

    if (m === 0) {
      return {
        ...base(r), matchCount: 0, appliedCount: 0, verdict: 'dead',
        detail: 'Matches no current employee. Either the criteria are wrong or this rule outlived what it was written for.',
      };
    }
    if (a === 0) {
      return {
        ...base(r), matchCount: m, appliedCount: 0, verdict: 'always_shadowed',
        detail: `Matches ${m} ${plural(m, 'employee')} but never decides the outcome. A higher-ranked rule in this slot always takes precedence, so this rule has no effect on anyone.`,
      };
    }
    return {
      ...base(r), matchCount: m, appliedCount: a, verdict: 'healthy',
      detail: `Matches ${m}, decides the outcome for ${a}.`,
    };
  });

  return {
    rules: ruleHealth,
    collisions: findCollisions(rules, outcomes),
    unfilled: findUnfilled(rules, outcomes),
  };
}

/**
 * Two rules in the same slot with identical (source, priority) that both matched the
 * same employee. Resolution stays deterministic because the comparator falls through to
 * authoring time, but the admin did not choose that outcome and probably cannot predict
 * it. This is the surface D9 promised instead of specificity scoring.
 */
function findCollisions(rules: RuleMeta[], outcomes: SlotOutcome[]): Collision[] {
  const byId = new Map(rules.map((r) => [r.ruleId, r]));
  const groups = new Map<string, { ids: Set<string>; employees: Set<string> }>();

  for (const o of outcomes) {
    const live = o.considered.filter((v) => v.status !== 'not_matched');
    const buckets = new Map<string, string[]>();

    for (const v of live) {
      const r = byId.get(v.ruleId);
      if (!r) continue;
      // In a `many` slot, rules on DIFFERENT targets never compete — every
      // matching grant applies. But the resolver still picks one winner per
      // targetId, so an equal-priority grant and deny on the SAME target
      // collide exactly as they would in an exclusive slot. Bucket per target.
      if (o.cardinality === 'many') {
        if (r.targetId === undefined) continue;
      }
      const k = o.cardinality === 'many'
        ? `${o.slotKey}|${r.source}|${r.priority}|${r.targetId}`
        : `${o.slotKey}|${r.source}|${r.priority}`;
      buckets.set(k, [...(buckets.get(k) ?? []), r.ruleId]);
    }

    for (const [k, ids] of buckets) {
      if (ids.length < 2) continue;
      const g = groups.get(k) ?? { ids: new Set<string>(), employees: new Set<string>() };
      ids.forEach((id) => g.ids.add(id));
      g.employees.add(o.employeeId);
      groups.set(k, g);
    }
  }

  return [...groups.entries()].map(([k, g]) => {
    const [slotKey, source, priority, targetId] = k.split('|');
    const names = [...g.ids].map((id) => byId.get(id)?.name ?? id);
    const targetName = [...g.ids].map((id) => byId.get(id)?.targetName).find(Boolean);
    const onWhat = targetId ? ` on ${targetName ?? 'the same target'} in ${slotKey}` : ` in ${slotKey}`;
    return {
      slotKey,
      ruleIds: [...g.ids],
      priority: Number(priority),
      source: source as 'rule' | 'manual',
      affectedEmployeeCount: g.employees.size,
      detail: `${names.join(' and ')} share priority ${priority}${onWhat} and both match ${g.employees.size} ${plural(g.employees.size, 'employee')}. The winner is decided by which was authored first, which is stable but probably not what anyone intended. Set distinct priorities.`,
    };
  });
}

/**
 * `exactly_one` slots with nothing resolved. Declared as required, actually empty.
 *
 * The two causes need different messages and different actions. Uncovered means write a
 * rule. Explicitly denied means someone made that choice on purpose, and telling them "no
 * override was set" when an override is exactly what emptied the slot sends them looking
 * for a bug that is not there.
 */
function findUnfilled(rules: RuleMeta[], outcomes: SlotOutcome[]): UnfilledSlot[] {
  const byId = new Map(rules.map((r) => [r.ruleId, r]));
  const uncovered = new Map<string, number>();
  const denied = new Map<string, number>();
  const deniers = new Map<string, Set<string>>();

  for (const o of outcomes) {
    if (o.cardinality !== 'exactly_one') continue;
    if (o.resolvedTargetIds.length > 0) continue;

    const denier = o.considered.find((v) => v.status === 'denied');
    if (denier) {
      bump(denied, o.slotKey);
      const set = deniers.get(o.slotKey) ?? new Set<string>();
      set.add(byId.get(denier.ruleId)?.name ?? denier.ruleId);
      deniers.set(o.slotKey, set);
    } else {
      bump(uncovered, o.slotKey);
    }
  }

  const out: UnfilledSlot[] = [];

  for (const [slotKey, n] of uncovered) {
    out.push({
      slotKey,
      employeeCount: n,
      detail: `${n} ${plural(n, 'employee')} ${n === 1 ? 'has' : 'have'} no ${slotKey}, but this slot is declared as required. No rule covers them and no manual override was set.`,
    });
  }

  for (const [slotKey, n] of denied) {
    const names = [...(deniers.get(slotKey) ?? [])].join(', ');
    out.push({
      slotKey,
      employeeCount: n,
      detail: `${n} ${plural(n, 'employee')} ${n === 1 ? 'has' : 'have'} no ${slotKey} because an override explicitly denies it (${names}). This slot is declared as required, so confirm the denial is intended.`,
    });
  }

  return out;
}

const base = (r: RuleMeta) => ({ ruleId: r.ruleId, name: r.name, slotKey: r.slotKey });
const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
const plural = (n: number, w: string) => (n === 1 ? w : `${w}s`);

// ---------------------------------------------------------------------------
// Report assembly
// ---------------------------------------------------------------------------

import type { Db } from './db';
import { fetchSlots, fetchDeps } from './reconcile';
import { fetchActiveRules } from './scheduler';
import { buildEmployeeStates } from './state';
import { topoOrder } from './cascade';
import { resolveEmployee } from './resolver';

/**
 * Resolve the whole current population once and aggregate the per-rule verdicts
 * the resolver already produces. This is deliberately the same code path as
 * reconciliation — a health report computed by a second evaluator could
 * disagree with what the engine actually does.
 */
export async function computeHealthReport(
  db: Db,
  companyId: string,
  asOf: Date,
): Promise<HealthReport> {
  const [states, rules, slots, deps, { rows: targets }] = await Promise.all([
    buildEmployeeStates(db, companyId, 'all', asOf, asOf),
    fetchActiveRules(db, companyId, asOf),
    fetchSlots(db, companyId),
    fetchDeps(db, companyId),
    db.query<{ id: string; display_name: string }>(
      'SELECT id, display_name FROM assignment_targets WHERE company_id = $1',
      [companyId],
    ),
  ]);
  const ordered = topoOrder(slots, deps);
  const slotKeyById = new Map(slots.map((s) => [s.id, s.key]));
  const targetNameById = new Map(targets.map((t) => [t.id, t.display_name]));

  const metas: RuleMeta[] = rules.map((r) => ({
    ruleId: r.ruleId,
    name: r.name,
    slotKey: slotKeyById.get(r.slotId) ?? r.slotId,
    source: r.source,
    priority: r.priority,
    targetId: r.targetId,
    targetName: targetNameById.get(r.targetId),
  }));

  const outcomes: SlotOutcome[] = [];
  for (const [employeeId, state] of states) {
    for (const sr of resolveEmployee(ordered, rules, state, asOf).slots) {
      outcomes.push({
        employeeId,
        slotKey: sr.slotKey,
        cardinality: sr.cardinality,
        resolvedTargetIds: sr.resolved.map((x) => x.targetId),
        considered: sr.considered.map((c) => ({ ruleId: c.ruleId, status: c.status })),
      });
    }
  }
  return analyzeHealth(metas, outcomes);
}
