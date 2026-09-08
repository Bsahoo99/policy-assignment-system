import type { Db } from './db';

export interface ExplainItem {
  slotId: string;
  targetId: string;
  winningRuleId: string;
  explainTrace: unknown;
}

export async function explainEmployee(
  db: Db,
  companyId: string,
  employeeId: string,
  validAt: Date,
  systemAt?: Date,
): Promise<ExplainItem[]> {
  const vIso = validAt.toISOString();
  const sIso = (systemAt ?? validAt).toISOString();
  const { rows } = await db.query<{
    slot_id: string;
    target_id: string;
    winning_rule_id: string;
    explain_trace: unknown;
  }>(
    `SELECT slot_id, target_id, winning_rule_id, explain_trace
     FROM resolved_assignments
     WHERE company_id = $1
       AND employee_id = $2
       AND valid @> $3::timestamptz
       AND system @> $4::timestamptz`,
    [companyId, employeeId, vIso, sIso],
  );
  return rows.map((r) => ({
    slotId: r.slot_id,
    targetId: r.target_id,
    winningRuleId: r.winning_rule_id,
    explainTrace: r.explain_trace,
  }));
}
