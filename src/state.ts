import { evaluate, type EmployeeState, type Predicate } from './predicate';
import type { EmploymentType, PayType } from './types';
import type { Db } from './db';

export interface DynamicGroup {
  id: string;
  key: string;
  criteria: Predicate;
}

interface EmploymentRecordRow {
  employee_id: string;
  department: string | null;
  location_state: string | null;
  location_country: string;
  employment_type: string;
  pay_type: string;
  tenure_start_date: unknown;
}

interface StaticGroupRow {
  employee_id: string;
  group_key: string;
}

interface DynamicGroupRow {
  id: string;
  key: string;
  criteria: unknown;
}

interface DirectReportRow {
  employee_id: string;
  direct_report_count: unknown;
}

function formatDate(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function parseCount(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function groupKeysByEmployee(rows: StaticGroupRow[]): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const { employee_id, group_key } of rows) {
    const set = map.get(employee_id) ?? new Set<string>();
    set.add(group_key);
    map.set(employee_id, set);
  }
  return map;
}

export async function getDynamicGroups(db: Db, companyId: string): Promise<DynamicGroup[]> {
  const { rows } = await db.query<DynamicGroupRow>(
    `SELECT id, key, criteria
     FROM groups
     WHERE company_id = $1 AND kind = 'dynamic'`,
    [companyId],
  );
  return rows.map((g) => ({ id: g.id, key: g.key, criteria: g.criteria as Predicate }));
}

export async function getStaticGroupKeys(
  db: Db,
  companyId: string,
  employeeId: string,
  validAt: Date,
  systemAt: Date,
): Promise<string[]> {
  const { rows } = await db.query<{ group_key: string }>(
    `SELECT g.key AS group_key
     FROM group_memberships gm
     JOIN groups g ON g.id = gm.group_id
     WHERE gm.company_id = $1
       AND gm.employee_id = $2
       AND gm.valid @> $3::timestamptz
       AND gm.system @> $4::timestamptz`,
    [companyId, employeeId, validAt.toISOString(), systemAt.toISOString()],
  );
  return rows.map((r) => r.group_key);
}

export function deriveGroupKeys(state: EmployeeState, dynamicGroups: DynamicGroup[], asOf: Date): string[] {
  const dynamicKeys = new Set(dynamicGroups.map((g) => g.key));
  const base = state.group_keys.filter((k) => !dynamicKeys.has(k));
  const matched: string[] = [];
  for (const g of dynamicGroups) {
    if (evaluate(g.criteria, state, asOf).matched) {
      matched.push(g.key);
    }
  }
  return [...base, ...matched];
}

export async function buildEmployeeState(
  db: Db,
  companyId: string,
  employeeId: string,
  validAt: Date,
  systemAt: Date,
): Promise<EmployeeState> {
  const states = await buildEmployeeStates(db, companyId, [employeeId], validAt, systemAt);
  const state = states.get(employeeId);
  if (!state) throw new Error(`No employment record for employee ${employeeId} at the requested time`);
  return state;
}

export async function buildEmployeeStates(
  db: Db,
  companyId: string,
  employeeIds: string[] | 'all',
  validAt: Date,
  systemAt: Date,
): Promise<Map<string, EmployeeState>> {
  const validAtIso = validAt.toISOString();
  const systemAtIso = systemAt.toISOString();

  const ids: string[] =
    employeeIds === 'all'
      ? (await db.query<{ id: string }>('SELECT id FROM employees WHERE company_id = $1', [companyId])).rows.map(
          (r) => r.id,
        )
      : employeeIds;

  if (ids.length === 0) return new Map();

  const [facts, staticGroups, dynamicGroups, directReports] = await Promise.all([
    db.query<EmploymentRecordRow>(
      `SELECT employee_id, department, location_state, location_country,
              employment_type, pay_type, tenure_start_date
       FROM employment_records
       WHERE company_id = $1
         AND employee_id = ANY($2::uuid[])
         AND valid @> $3::timestamptz
         AND system @> $4::timestamptz`,
      [companyId, ids, validAtIso, systemAtIso],
    ),
    db.query<StaticGroupRow>(
      `SELECT gm.employee_id, g.key AS group_key
       FROM group_memberships gm
       JOIN groups g ON g.id = gm.group_id
       WHERE gm.company_id = $1
         AND gm.employee_id = ANY($2::uuid[])
         AND gm.valid @> $3::timestamptz
         AND gm.system @> $4::timestamptz`,
      [companyId, ids, validAtIso, systemAtIso],
    ),
    getDynamicGroups(db, companyId),
    (async () => {
      const slot = await db.query<{ id: string }>(
        `SELECT id FROM assignment_slots
         WHERE company_id = $1 AND key = 'manager'
         LIMIT 1`,
        [companyId],
      );
      const slotId = slot.rows[0]?.id;
      if (!slotId) return { rows: [] as DirectReportRow[] };
      return db.query<DirectReportRow>(
        `SELECT e.id AS employee_id, COUNT(ra.id) AS direct_report_count
         FROM employees e
         LEFT JOIN employee_targets et ON et.employee_id = e.id
         LEFT JOIN resolved_assignments ra
                ON ra.target_id = et.target_id
               AND ra.company_id = $1
               AND ra.slot_id = $2
               AND ra.valid @> $3::timestamptz
               AND ra.system @> $4::timestamptz
         WHERE e.company_id = $1 AND e.id = ANY($5::uuid[])
         GROUP BY e.id`,
        [companyId, slotId, validAtIso, systemAtIso, ids],
      );
    })(),
  ]);

  const factsById = new Map(facts.rows.map((r) => [r.employee_id, r]));
  const staticGroupMap = groupKeysByEmployee(staticGroups.rows);
  const directReportMap = new Map(directReports.rows.map((r) => [r.employee_id, parseCount(r.direct_report_count)]));

  const result = new Map<string, EmployeeState>();
  for (const id of ids) {
    const row = factsById.get(id);
    if (!row) continue;

    const base: EmployeeState = {
      employee_id: id,
      department: row.department ?? null,
      location_state: row.location_state ?? null,
      location_country: row.location_country,
      employment_type: row.employment_type as EmploymentType,
      pay_type: row.pay_type as PayType,
      tenure_start_date: formatDate(row.tenure_start_date),
      direct_report_count: directReportMap.get(id) ?? 0,
      group_keys: [...(staticGroupMap.get(id) ?? new Set<string>())],
    };

    base.group_keys = deriveGroupKeys(base, dynamicGroups, validAt);
    result.set(id, base);
  }

  return result;
}
