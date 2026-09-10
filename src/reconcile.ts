import { buildEmployeeState, getDynamicGroups } from './state';
import { resolveEmployee } from './resolver';
import { topoOrder } from './cascade';
import { supersede } from './temporal';
import { recomputeNextMaterialDate } from './scheduler';
import { planSegments, boundariesFrom, type BoundarySources, type Range } from './segments';
import type { Clock } from './clock';
import type { Db } from './db';
import type { Queue, ReconcileResult, ResolvedAssignment, Rule, Slot, SlotDependency, SlotResolution } from './types';
import { nextMaterialDateForRule, type Predicate } from './predicate';

/**
 * `db` is either a pool/PGlite adapter (which provides withTransaction) or an
 * already-open transaction handle (which does not). Nested runTx calls are safe:
 * on a transaction handle this is a plain `fn(db)`.
 */
async function runTx<T>(db: Db, fn: (tx: Db) => Promise<T>): Promise<T> {
  return db.withTransaction ? db.withTransaction(fn) : fn(db);
}

interface SlotRow {
  id: string;
  key: string;
  display_name: string;
  cardinality: 'exactly_one' | 'at_most_one' | 'many';
  target_type: 'policy' | 'app' | 'pay_schedule' | 'employee';
}

interface RuleRow {
  id: string;
  rule_id: string;
  rule_created_at: unknown;
  company_id: string;
  slot_id: string;
  target_id: string;
  name: string;
  source: 'rule' | 'manual';
  effect: 'grant' | 'deny';
  priority: number;
  criteria: unknown;
  subject_employee_id: string | null;
  created_at: unknown;
}

export interface CurrentRow {
  id: string;
  slot_id: string;
  target_id: string;
  winning_rule_id: string;
  winning_rule_version_id: string;
  is_exclusive: boolean;
  explain_trace: unknown;
  valid_lower: unknown;
  valid_upper: unknown;
}

export function assignmentKey(slotId: string, targetId: string): string {
  return `${slotId}:${targetId}`;
}

function toDate(value: unknown): Date {
  if (value instanceof Date) return value;
  return new Date(String(value));
}

function toPredicate(value: unknown): Predicate {
  return value as Predicate;
}

export async function fetchSlots(db: Db, companyId: string): Promise<Slot[]> {
  const { rows } = await db.query<SlotRow>(
    `SELECT id, key, display_name, cardinality, target_type
     FROM assignment_slots
     WHERE company_id = $1`,
    [companyId],
  );
  return rows.map((r) => ({
    id: r.id,
    companyId,
    key: r.key,
    displayName: r.display_name,
    cardinality: r.cardinality,
    targetType: r.target_type,
  }));
}

export async function fetchDeps(db: Db, companyId: string): Promise<SlotDependency[]> {
  const { rows } = await db.query<{ slot_id: string; depends_on_slot: string }>(
    `SELECT slot_id, depends_on_slot
     FROM slot_dependencies
     WHERE company_id = $1`,
    [companyId],
  );
  return rows.map((r) => ({ companyId, slotId: r.slot_id, dependsOnSlotId: r.depends_on_slot }));
}

export async function fetchRules(
  db: Db,
  companyId: string,
  employeeId: string,
  validAt: Date,
  systemAt: Date,
): Promise<Rule[]> {
  const { rows } = await db.query<RuleRow>(
    `SELECT id, rule_id, rule_created_at, company_id, slot_id, target_id, name, source, effect, priority, criteria,
            subject_employee_id, created_at
     FROM assignment_rules
     WHERE company_id = $1
       AND valid @> $2::timestamptz
       AND system @> $3::timestamptz
       AND (source <> 'manual' OR subject_employee_id = $4::uuid)`,
    [companyId, validAt.toISOString(), systemAt.toISOString(), employeeId],
  );
  return rows.map((r) => ({
    id: r.id,
    ruleId: r.rule_id,
    ruleCreatedAt: toDate(r.rule_created_at),
    companyId: r.company_id,
    slotId: r.slot_id,
    targetId: r.target_id,
    name: r.name,
    source: r.source,
    effect: r.effect,
    priority: r.priority,
    criteria: toPredicate(r.criteria),
    subjectEmployeeId: r.subject_employee_id,
    createdAt: toDate(r.created_at),
  }));
}

export async function fetchCurrentAssignments(
  db: Db,
  companyId: string,
  employeeId: string,
  validAt: Date,
  systemAt: Date,
): Promise<Map<string, CurrentRow>> {
  const { rows } = await db.query<CurrentRow>(
    `SELECT id, slot_id, target_id, winning_rule_id, winning_rule_version_id, is_exclusive, explain_trace,
            lower(valid) AS valid_lower, upper(valid) AS valid_upper
     FROM resolved_assignments
     WHERE company_id = $1
       AND employee_id = $2
       AND valid @> $3::timestamptz
       AND system @> $4::timestamptz`,
    [companyId, employeeId, validAt.toISOString(), systemAt.toISOString()],
  );
  return new Map(rows.map((r) => [assignmentKey(r.slot_id, r.target_id), r]));
}

/**
 * Every instant after `from` at which this employee's resolution could change.
 * Boundaries are collected as RANGES, not dates: both the start and the end of
 * a valid range are potential cuts. A membership revoked at June 1 has to cut
 * the timeline there — collecting only `lower(valid)` was the bug that let a
 * delayed job resurrect a revoked assignment.
 *
 * Sources are currently-open rows only (upper_inf(system)): a reconcile at
 * `systemAt` cannot plan around a future it does not yet believe.
 */
async function fetchBoundarySources(
  db: Db,
  companyId: string,
  employeeId: string,
  effectiveAt: Date,
): Promise<Omit<BoundarySources, 'tenureThresholds'>> {
  const after = effectiveAt.toISOString();
  // A range contributes a boundary if EITHER edge falls after `after`.
  // lower > after: the range starts later (a future-dated change).
  // upper > after: the range ends later (a revocation or expiry).
  const [facts, rules, memberships, published, inboundReports] = await Promise.all([
    db.query<{ f: unknown; t: unknown }>(
      `SELECT lower(valid) AS f, upper(valid) AS t FROM employment_records
       WHERE company_id = $1 AND employee_id = $2 AND upper_inf(system)
         AND (lower(valid) > $3::timestamptz OR upper(valid) > $3::timestamptz)`,
      [companyId, employeeId, after],
    ),
    db.query<{ f: unknown; t: unknown }>(
      `SELECT lower(valid) AS f, upper(valid) AS t FROM assignment_rules
       WHERE company_id = $1 AND upper_inf(system)
         AND (lower(valid) > $2::timestamptz OR upper(valid) > $2::timestamptz)
         AND (source <> 'manual' OR subject_employee_id = $3::uuid)`,
      [companyId, after, employeeId],
    ),
    db.query<{ f: unknown; t: unknown }>(
      `SELECT lower(valid) AS f, upper(valid) AS t FROM group_memberships
       WHERE company_id = $1 AND employee_id = $2 AND upper_inf(system)
         AND (lower(valid) > $3::timestamptz OR upper(valid) > $3::timestamptz)`,
      [companyId, employeeId, after],
    ),
    db.query<{ f: unknown; t: unknown }>(
      `SELECT lower(valid) AS f, upper(valid) AS t FROM resolved_assignments
       WHERE company_id = $1 AND employee_id = $2 AND upper_inf(system)
         AND (lower(valid) > $3::timestamptz OR upper(valid) > $3::timestamptz)`,
      [companyId, employeeId, after],
    ),
    // Inbound reporting lines: manager-slot assignments pointing AT this
    // employee. Their edges are the instants this employee's direct_report_count
    // changes, and they are invisible in every other source, all of which are
    // scoped to rows about the employee themselves.
    db.query<{ f: unknown; t: unknown }>(
      `SELECT lower(ra.valid) AS f, upper(ra.valid) AS t
         FROM resolved_assignments ra
         JOIN assignment_slots s
           ON s.id = ra.slot_id AND s.company_id = ra.company_id AND s.key = 'manager'
         JOIN employee_targets et ON et.target_id = ra.target_id
        WHERE ra.company_id = $1 AND et.employee_id = $2 AND upper_inf(ra.system)
          AND (lower(ra.valid) > $3::timestamptz OR upper(ra.valid) > $3::timestamptz)`,
      [companyId, employeeId, after],
    ),
  ]);
  const ranges = (rows: { f: unknown; t: unknown }[]): Range[] =>
    rows.map((r) => ({ from: toDate(r.f), to: r.t === null ? null : toDate(r.t) }));
  return {
    factRanges: ranges(facts.rows),
    ruleRanges: ranges(rules.rows),
    membershipRanges: ranges(memberships.rows),
    publishedRanges: ranges(published.rows),
    inboundReportRanges: ranges(inboundReports.rows),
  };
}

export async function reconcileEmployee(
  db: Db,
  companyId: string,
  employeeId: string,
  effectiveAt: Date,
  clock: Clock,
  queue?: Queue,
): Promise<ReconcileResult> {
  const systemAt = clock.now();
  const managerEmployeeIds = new Set<string>();

  const { result, continueAt } = await runTx(db, async (tx) => {
    const [slots, deps, rules] = await Promise.all([
      fetchSlots(tx, companyId),
      fetchDeps(tx, companyId),
      fetchRules(tx, companyId, employeeId, effectiveAt, systemAt),
    ]);

    const orderedSlots = topoOrder(slots, deps);
    const state = await buildEmployeeState(tx, companyId, employeeId, effectiveAt, systemAt);

    // Tenure thresholds come from the predicate scheduler, not from a scan.
    // Dynamic groups are expanded first: a rule that is just
    // `in_group('two-year-club')` contains no tenure node itself — the threshold
    // lives one level down inside the group definition, and expanding here is
    // what makes the anniversary visible to scheduling.
    const dynMap = new Map((await getDynamicGroups(tx, companyId)).map((g) => [g.key, g.criteria]));
    const tenureThresholds = rules
      .map((r) => nextMaterialDateForRule(r.criteria, dynMap, state, effectiveAt))
      .filter((d): d is Date => d !== null && d.getTime() > effectiveAt.getTime());

    const sources = await fetchBoundarySources(tx, companyId, employeeId, effectiveAt);
    const boundaries = boundariesFrom({ ...sources, tenureThresholds });
    const plan = planSegments(effectiveAt, boundaries);
    const segments = plan.segments;

    const managerSlotId = slots.find((s) => s.key === 'manager')?.id;
    let firstAssignments: ResolvedAssignment[] = [];
    let firstBefore: CurrentRow[] = [];
    let firstAfter: ResolvedAssignment[] = [];
    let changed = false;
    let segmentsChanged = 0;

    for (let i = 0; i < segments.length; i++) {
      const [segFrom, segTo] = segments[i];
      const [segRules, segState, current] = await Promise.all([
        fetchRules(tx, companyId, employeeId, segFrom, systemAt),
        buildEmployeeState(tx, companyId, employeeId, segFrom, systemAt),
        fetchCurrentAssignments(tx, companyId, employeeId, segFrom, systemAt),
      ]);
      const resolution = resolveEmployee(orderedSlots, segRules, segState, segFrom);
      const desired = new Map(resolution.assignments.map((a) => [assignmentKey(a.slotId, a.targetId), a]));
      const slotsByKey = new Map(slots.map((s) => [s.key, s]));
      const slotResBySlotId = new Map<string, SlotResolution>(
        resolution.slots.map((sr) => [slotsByKey.get(sr.slotKey)!.id, sr]),
      );

      const toEnd = new Map<string, CurrentRow>();
      const toStart = new Map<string, ResolvedAssignment>();
      for (const [key, row] of current) {
        const wanted = desired.get(key);
        if (!wanted || wanted.winningRuleId !== row.winning_rule_id) toEnd.set(key, row);
      }
      for (const [key, assignment] of desired) {
        const row = current.get(key);
        // "Same rule" is not enough: the existing row must cover the whole
        // segment. If it ends before segTo, re-assert to extend it — otherwise
        // arrival order would determine how far the assignment reaches.
        const covers = row && row.winning_rule_id === assignment.winningRuleId && (() => {
          const upper = row.valid_upper === null ? null : toDate(row.valid_upper);
          return segTo === null ? upper === null : upper === null || upper.getTime() >= segTo.getTime();
        })();
        if (!covers) toStart.set(key, assignment);
      }

      if (i === 0) {
        firstAssignments = resolution.assignments;
        firstBefore = [...current.values()];
        firstAfter = resolution.assignments;
      }
      if (toEnd.size === 0 && toStart.size === 0) continue;
      changed = true;
      segmentsChanged++;

      for (const row of toEnd.values()) {
        // A null payload over a BOUNDED range: the timeline has no fact in
        // [segFrom, segTo). The row's trailing remnant beyond segTo is
        // re-inserted by supersede, so an existing later conclusion survives.
        await supersede(tx, {
          table: 'resolved_assignments',
          companyId,
          key: { employee_id: employeeId, slot_id: row.slot_id, target_id: row.target_id },
          payload: null,
          validFrom: segFrom,
          validTo: segTo,
          now: systemAt,
        });
      }

      for (const assignment of toStart.values()) {
        const slot = slots.find((s) => s.id === assignment.slotId);
        const isExclusive = slot ? slot.cardinality !== 'many' : false;
        const trace = slotResBySlotId.get(assignment.slotId);
        await supersede(tx, {
          table: 'resolved_assignments',
          companyId,
          key: { employee_id: employeeId, slot_id: assignment.slotId, target_id: assignment.targetId },
          payload: {
            winning_rule_id: assignment.winningRuleId,
            winning_rule_version_id: assignment.winningRuleVersionId,
            is_exclusive: isExclusive,
            explain_trace: trace ? JSON.stringify(trace) : '{}',
          },
          validFrom: segFrom,
          validTo: segTo,
          now: systemAt,
        });
      }

      if (managerSlotId) {
        for (const row of toEnd.values()) if (row.slot_id === managerSlotId) {
          const { rows: rows2 } = await tx.query<{ employee_id: string }>(
            `SELECT et.employee_id
             FROM employee_targets et
             JOIN assignment_targets at ON at.id = et.target_id AND at.company_id = $1
             WHERE et.target_id = $2::uuid`,
            [companyId, row.target_id],
          );
          for (const r of rows2) if (r.employee_id !== employeeId) managerEmployeeIds.add(r.employee_id);
        }
        for (const a of toStart.values()) if (a.slotId === managerSlotId) {
          const { rows: rows2 } = await tx.query<{ employee_id: string }>(
            `SELECT et.employee_id
             FROM employee_targets et
             JOIN assignment_targets at ON at.id = et.target_id AND at.company_id = $1
             WHERE et.target_id = $2::uuid`,
            [companyId, a.targetId],
          );
          for (const r of rows2) if (r.employee_id !== employeeId) managerEmployeeIds.add(r.employee_id);
        }
      }
    }

    if (changed) {
      await tx.query(
        `INSERT INTO audit_events
           (company_id, actor_id, actor_kind, action, entity_type, entity_id, before, after, reason)
         VALUES ($1, NULL, 'system', 'reconcile', 'employee', $2, $3::jsonb, $4::jsonb, $5)`,
        [
          companyId,
          employeeId,
          JSON.stringify(firstBefore.map((r) => ({ slotId: r.slot_id, targetId: r.target_id, winningRuleId: r.winning_rule_id }))),
          JSON.stringify(firstAfter.map((a) => ({ slotId: a.slotId, targetId: a.targetId, winningRuleId: a.winningRuleId }))),
          `reconcile at ${effectiveAt.toISOString()} (${segmentsChanged} segment(s) changed)`,
        ],
      );
    }

    await recomputeNextMaterialDate(tx, companyId, employeeId, systemAt);
    // A truncated plan ends at continueAt; the caller must enqueue a
    // continuation there or the timeline simply stops.
    return {
      result: { changed, assignments: firstAssignments },
      continueAt: plan.continueAt,
    };
  });

  // Fan out manager cascades and the truncation continuation only after the
  // reconcile transaction has committed. `queue` is the transaction-bound queue
  // when the caller is a worker (handleJob) and the shared memory queue in
  // embedded mode.
  if (queue) {
    for (const empId of managerEmployeeIds) {
      await queue.send('resolve-assignment', {
        company_id: companyId,
        employee_ids: [empId],
        effective_at: effectiveAt.toISOString(),
      });
    }
    // A truncated plan ends at continueAt; without this job the timeline would
    // simply stop there.
    if (continueAt) {
      await queue.send('resolve-assignment', {
        company_id: companyId,
        employee_ids: [employeeId],
        effective_at: continueAt.toISOString(),
      });
    }
  }

  return result;
}
