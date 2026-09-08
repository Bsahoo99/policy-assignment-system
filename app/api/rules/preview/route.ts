import { NextRequest, NextResponse } from 'next/server';
import { getDb, getClock } from '../../../../src/runtime';
import { previewRuleImpact } from '../../../../src/preview';
import type { Rule } from '../../../../src/types';
import { parsePredicate, type Predicate } from '../../../../src/predicate';

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

function toDate(v: unknown): Date {
  return v instanceof Date ? v : new Date(String(v));
}

function toRule(r: RuleRow): Rule {
  return {
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
    criteria: r.criteria as Predicate,
    subjectEmployeeId: r.subject_employee_id,
    createdAt: toDate(r.created_at),
  };
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { company_id, rule_id, criteria, slot_id, target_id, effect, priority, name, effective_at, system_at } = body;
    // Preview compiles this straight to SQL, so it needs the same gate as a write.
    const parsedCriteria: Predicate | undefined =
      criteria === undefined || criteria === null ? undefined : parsePredicate(criteria);
    const db = await getDb();
    const effectiveAt = new Date(effective_at);
    const systemAt = system_at ? new Date(system_at) : getClock().now();

    let before: Rule | null = null;
    if (rule_id) {
      const { rows } = await db.query<RuleRow>(
        `SELECT id, rule_id, rule_created_at, company_id, slot_id, target_id, name, source, effect, priority, criteria, subject_employee_id, created_at
         FROM assignment_rules
         WHERE rule_id = $1 AND company_id = $2 AND valid @> $3::timestamptz AND system @> $4::timestamptz`,
        [rule_id, company_id, effectiveAt.toISOString(), systemAt.toISOString()],
      );
      before = rows[0] ? toRule(rows[0]) : null;
    }

    const after: Rule = before
      ? {
          ...before,
          criteria: parsedCriteria ?? before.criteria,
          slotId: slot_id ?? before.slotId,
          targetId: target_id ?? before.targetId,
          effect: effect ?? before.effect,
          priority: priority ?? before.priority,
          name: name ?? before.name,
        }
      : {
          id: crypto.randomUUID(),
          ruleId: crypto.randomUUID(),
          ruleCreatedAt: systemAt,
          companyId: company_id,
          slotId: slot_id,
          targetId: target_id,
          name: name ?? 'Preview',
          source: 'rule',
          effect: effect ?? 'grant',
          priority: priority ?? 0,
          criteria: parsedCriteria ?? { op: 'always' },
          subjectEmployeeId: null,
          createdAt: systemAt,
        };

    const preview = await previewRuleImpact(db, company_id, before, after, effectiveAt, systemAt);
    return NextResponse.json(preview);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
