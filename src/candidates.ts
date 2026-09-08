import { toSql, type Predicate } from './predicate';
import type { Db } from './db';
import type { Rule } from './types';

interface DynamicGroupRow {
  id: string;
  key: string;
  criteria: unknown;
}

async function fetchDynamicGroups(db: Db, companyId: string): Promise<DynamicGroupRow[]> {
  const { rows } = await db.query<DynamicGroupRow>(
    `SELECT id, key, criteria
     FROM groups
     WHERE company_id = $1 AND kind = 'dynamic'`,
    [companyId],
  );
  return rows;
}

/**
 * Builds the `employee_state` CTE used by `toSql` for reverse matching.
 * Params are $1 company, $2 valid, $3 system; dynamic group criteria add their own params.
 */
function buildEmployeeStateCte(
  companyId: string,
  validAt: Date,
  systemAt: Date,
  dynamicGroups: DynamicGroupRow[],
): { cte: string; params: unknown[] } {
  const validAtIso = validAt.toISOString();
  const systemAtIso = systemAt.toISOString();
  const params: unknown[] = [companyId, validAtIso, systemAtIso];

  const dynamicConditions = dynamicGroups.map((g) => {
    params.push(g.id);
    const groupParamIndex = params.length;
    const frag = toSql(g.criteria as Predicate, validAt, params);
    return `(g.id = $${groupParamIndex}::uuid AND ${frag.text})`;
  });

  const dynamicExpr = dynamicGroups.length === 0
    ? 'ef.group_keys'
    : `ef.group_keys || COALESCE((
        SELECT array_agg(g.key)
        FROM groups g
        CROSS JOIN employee_facts e
        WHERE g.company_id = ef.company_id
          AND g.kind = 'dynamic'
          AND e.employee_id = ef.employee_id
          AND (${dynamicConditions.join(' OR ')})
      ), '{}'::text[])`;

  const cte = `WITH employee_facts AS (
  SELECT e.id AS employee_id, e.company_id,
         er.department, er.location_state, er.location_country, er.employment_type, er.pay_type, er.tenure_start_date,
         COALESCE(drc.cnt, 0) AS direct_report_count,
         COALESCE(sg.group_keys, '{}'::text[]) AS group_keys
  FROM employees e
  JOIN employment_records er
    ON er.company_id = e.company_id
    AND er.employee_id = e.id
    AND er.valid @> $2::timestamptz
    AND er.system @> $3::timestamptz
  LEFT JOIN LATERAL (
    SELECT COUNT(ra.id) AS cnt
    FROM employee_targets et
    JOIN resolved_assignments ra
      ON ra.target_id = et.target_id
      AND ra.company_id = e.company_id
      AND ra.slot_id = (SELECT id FROM assignment_slots WHERE company_id = e.company_id AND key = 'manager')
      AND ra.valid @> $2::timestamptz
      AND ra.system @> $3::timestamptz
    WHERE et.employee_id = e.id
  ) drc ON true
  LEFT JOIN LATERAL (
    SELECT array_agg(g.key) AS group_keys
    FROM group_memberships gm
    JOIN groups g ON g.id = gm.group_id
    WHERE gm.employee_id = e.id
      AND gm.company_id = e.company_id
      AND gm.valid @> $2::timestamptz
      AND gm.system @> $3::timestamptz
  ) sg ON true
  WHERE e.company_id = $1
),
employee_state AS (
  SELECT ef.employee_id, ef.company_id, ef.department, ef.location_state, ef.location_country,
         ef.employment_type, ef.pay_type, ef.tenure_start_date, ef.direct_report_count,
         ${dynamicExpr} AS group_keys
  FROM employee_facts ef
)`;

  return { cte, params };
}

async function candidatesMatching(
  db: Db,
  companyId: string,
  validAt: Date,
  systemAt: Date,
  criteria: Predicate,
  dynamicGroups: DynamicGroupRow[],
): Promise<string[]> {
  const { cte, params } = buildEmployeeStateCte(companyId, validAt, systemAt, dynamicGroups);
  const frag = toSql(criteria, validAt, params);
  const { rows } = await db.query<{ employee_id: string }>(
    `${cte}
     SELECT employee_id FROM employee_state e
     WHERE ${frag.text}`,
    params,
  );
  return rows.map((r) => r.employee_id);
}

export async function candidatesForRuleChange(
  db: Db,
  companyId: string,
  before: Rule | null,
  after: Rule | null,
  asOf: Date,
): Promise<string[]> {
  const systemAt = asOf;
  const dynamicGroups = await fetchDynamicGroups(db, companyId);

  const [beforeSet, afterSet, resolvedSet, managerSet] = await Promise.all([
    before ? candidatesMatching(db, companyId, asOf, systemAt, before.criteria, dynamicGroups) : Promise.resolve([]),
    after ? candidatesMatching(db, companyId, asOf, systemAt, after.criteria, dynamicGroups) : Promise.resolve([]),
    (async () => {
      const ruleIds = [...new Set([before?.ruleId, after?.ruleId].filter((id): id is string => !!id))];
      if (ruleIds.length === 0) return [];
      const { rows } = await db.query<{ employee_id: string }>(
        `SELECT DISTINCT employee_id FROM resolved_assignments
         WHERE company_id = $1 AND system @> $2::timestamptz AND winning_rule_id = ANY($3::uuid[])`,
        [companyId, systemAt.toISOString(), ruleIds],
      );
      return rows.map((r) => r.employee_id);
    })(),
    (async () => {
      const { rows: managerSlots } = await db.query<{ id: string }>(
        `SELECT id FROM assignment_slots WHERE company_id = $1 AND key = 'manager'`,
        [companyId],
      );
      const managerSlotIds = new Set(managerSlots.map((r) => r.id));
      const targetIds = [...new Set([before?.targetId, after?.targetId].filter((id): id is string => !!id))];
      if (targetIds.length === 0) return [];
      const affectedRules = [before, after].filter((r): r is Rule => r !== null && managerSlotIds.has(r.slotId));
      if (affectedRules.length === 0) return [];
      const { rows } = await db.query<{ employee_id: string }>(
        `SELECT et.employee_id
         FROM employee_targets et
         JOIN assignment_targets at ON at.id = et.target_id AND at.company_id = $1
         WHERE et.target_id = ANY($2::uuid[])`,
        [companyId, targetIds],
      );
      return rows.map((r) => r.employee_id);
    })(),
  ]);

  const out = new Set<string>();
  for (const id of beforeSet) out.add(id);
  for (const id of afterSet) out.add(id);
  for (const id of resolvedSet) out.add(id);
  for (const id of managerSet) out.add(id);
  return [...out];
}
