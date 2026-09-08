import { nextMaterialDateForRule, type Predicate } from './predicate';
import { buildEmployeeState, buildEmployeeStates, getDynamicGroups } from './state';
import type { Db } from './db';
import type { Queue, Rule } from './types';

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

export async function fetchActiveRules(db: Db, companyId: string, asOf: Date): Promise<Rule[]> {
  const { rows } = await db.query<RuleRow>(
    `SELECT id, rule_id, rule_created_at, company_id, slot_id, target_id, name, source, effect, priority, criteria,
            subject_employee_id, created_at
     FROM assignment_rules
     WHERE company_id = $1
       AND valid @> $2::timestamptz
       AND system @> $3::timestamptz`,
    [companyId, asOf.toISOString(), asOf.toISOString()],
  );
  return rows.map((r) => ({
    id: r.id,
    ruleId: r.rule_id,
    ruleCreatedAt: r.rule_created_at instanceof Date ? r.rule_created_at : new Date(String(r.rule_created_at)),
    companyId: r.company_id,
    slotId: r.slot_id,
    targetId: r.target_id,
    name: r.name,
    source: r.source,
    effect: r.effect,
    priority: r.priority,
    criteria: r.criteria as Predicate,
    subjectEmployeeId: r.subject_employee_id,
    createdAt: r.created_at instanceof Date ? r.created_at : new Date(String(r.created_at)),
  }));
}

export async function computeEmployeeMaterialDates(
  db: Db,
  companyId: string,
  asOf: Date,
): Promise<Map<string, Date | null>> {
  const [states, rules, dynamicGroups] = await Promise.all([
    buildEmployeeStates(db, companyId, 'all', asOf, asOf),
    fetchActiveRules(db, companyId, asOf),
    getDynamicGroups(db, companyId),
  ]);
  const dynMap = new Map(dynamicGroups.map((g) => [g.key, g.criteria]));

  const result = new Map<string, Date | null>();
  for (const [employeeId, state] of states) {
    let next: Date | null = null;
    for (const rule of rules) {
      if (rule.source === 'manual' && rule.subjectEmployeeId !== employeeId) continue;
      const candidate = nextMaterialDateForRule(rule.criteria, dynMap, state, asOf);
      if (candidate && (!next || candidate < next)) next = candidate;
    }
    result.set(employeeId, next);
  }
  return result;
}

export async function upsertMaterialDates(
  db: Db,
  companyId: string,
  materialDates: Map<string, Date | null>,
): Promise<void> {
  for (const [employeeId, nextDate] of materialDates) {
    await db.query(
      `INSERT INTO employee_next_material_date (company_id, employee_id, next_at, reason, computed_at)
       VALUES ($1, $2, $3, NULL, now())
       ON CONFLICT (company_id, employee_id) DO UPDATE SET next_at = EXCLUDED.next_at, computed_at = now()`,
      [companyId, employeeId, nextDate ? nextDate.toISOString() : null],
    );
  }
}

/**
 * Recomputes and stores one employee's next material date — the earliest instant
 * after `asOf` at which any active rule's criteria can change outcome for them.
 * Called inside the transaction after reconcile and after rule create/edit so
 * the schedule always reflects the latest facts.
 */
export async function recomputeNextMaterialDate(
  db: Db,
  companyId: string,
  employeeId: string,
  asOf: Date,
): Promise<void> {
  const [state, rules, dynamicGroups] = await Promise.all([
    buildEmployeeState(db, companyId, employeeId, asOf, asOf),
    fetchActiveRules(db, companyId, asOf),
    getDynamicGroups(db, companyId),
  ]);
  const dynMap = new Map(dynamicGroups.map((g) => [g.key, g.criteria]));
  let next: Date | null = null;
  for (const rule of rules) {
    if (rule.source === 'manual' && rule.subjectEmployeeId !== employeeId) continue;
    const candidate = nextMaterialDateForRule(rule.criteria, dynMap, state, asOf);
    if (candidate && (!next || candidate < next)) next = candidate;
  }
  await upsertMaterialDates(db, companyId, new Map([[employeeId, next]]));
}

/**
 * Dispatcher: finds employees whose stored material date has passed, enqueues a
 * reconcile for each, and clears the row. The dispatched job carries
 * `effective_at = the stored next_at` — not the dispatch time — so a job that
 * fires late still stamps the anniversary instant (D14).
 */
export async function dispatchDueMaterialDates(
  db: Db,
  companyId: string,
  now: Date,
  queue: Queue,
): Promise<number> {
  const { rows } = await db.query<{ employee_id: string; next_at: Date }>(
    `SELECT employee_id, next_at
     FROM employee_next_material_date
     WHERE company_id = $1 AND next_at IS NOT NULL AND next_at <= $2::timestamptz`,
    [companyId, now.toISOString()],
  );
  for (const row of rows) {
    const effectiveAt = row.next_at instanceof Date ? row.next_at : new Date(row.next_at);
    await queue.send('resolve-assignment', {
      company_id: companyId,
      employee_ids: [row.employee_id],
      effective_at: effectiveAt.toISOString(),
    });
    await db.query(
      `DELETE FROM employee_next_material_date WHERE company_id = $1 AND employee_id = $2`,
      [companyId, row.employee_id],
    );
  }
  return rows.length;
}

/** All-company variant of {@link dispatchDueMaterialDates}, for the cron job. */
export async function dispatchAllDueMaterialDates(
  db: Db,
  now: Date,
  queue: Queue,
): Promise<number> {
  const { rows } = await db.query<{ company_id: string }>(
    `SELECT DISTINCT company_id FROM employee_next_material_date
     WHERE next_at IS NOT NULL AND next_at <= $1::timestamptz`,
    [now.toISOString()],
  );
  let n = 0;
  for (const { company_id } of rows) {
    n += await dispatchDueMaterialDates(db, company_id, now, queue);
  }
  return n;
}
