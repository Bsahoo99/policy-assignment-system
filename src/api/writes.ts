import { candidatesForRuleChange } from '../candidates';
import { validateSlotGraph } from '../cascade';
import { fetchDeps } from '../reconcile';
import { supersede } from '../temporal';
import { recomputeNextMaterialDate } from '../scheduler';
import { validateGroupPredicate, parsePredicate, toSql, type Predicate } from '../predicate';
import { drainMemoryQueue, transactionalQueue } from '../runtime';
import { memoryQueue } from '../queue';
import type { Clock } from '../clock';
import type { Db } from '../db';
import type { Queue, Rule } from '../types';

interface EmploymentRow {
  id: string;
  department: string | null;
  location_state: string | null;
  location_country: string;
  employment_type: string;
  pay_type: string;
  tenure_start_date: unknown;
  recorded_by: string | null;
  created_at: unknown;
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

/**
 * Runs `fn` inside a transaction bound to a single connection when the adapter
 * supports it. Every supersede call, audit insert, and enqueue inside `fn`
 * takes `tx` as its Db — nothing reaches for the pool inside a transaction.
 */
async function runTx<T>(db: Db, fn: (tx: Db) => Promise<T>): Promise<T> {
  return db.withTransaction ? db.withTransaction(fn) : fn(db);
}

/**
 * Inside a real transaction the queue must be bound to `tx` so the enqueue
 * commits atomically with the write. When `runTx` fell back (adapters without
 * withTransaction, e.g. a bare PGlite in tests) `tx` is the caller's `db` and
 * we keep the provided queue or a throwaway in-memory one.
 */
async function txQueue(tx: Db, callerDb: Db, queue?: Queue): Promise<Queue> {
  return tx === callerDb ? (queue ?? memoryQueue()) : transactionalQueue(tx);
}

export interface EmploymentFields {
  department?: string | null;
  location_state?: string | null;
  location_country?: string;
  employment_type?: string;
  pay_type?: string;
  tenure_start_date?: string;
}

export async function updateEmploymentRecord(
  db: Db,
  companyId: string,
  employeeId: string,
  fields: EmploymentFields,
  effectiveAt: Date,
  clock: Clock,
  queue?: Queue,
): Promise<void> {
  const systemAt = clock.now();
  await runTx(db, async (tx) => {
    const q = await txQueue(tx, db, queue);
    const { rows } = await tx.query<EmploymentRow>(
      `SELECT id, department, location_state, location_country, employment_type, pay_type,
              tenure_start_date, recorded_by, created_at
       FROM employment_records
       WHERE company_id = $1 AND employee_id = $2 AND valid @> $3::timestamptz AND system @> $4::timestamptz`,
      [companyId, employeeId, effectiveAt.toISOString(), systemAt.toISOString()],
    );
    const current = rows[0];
    if (!current) throw new Error('No current employment record for employee');

    const next = {
      department: fields.department !== undefined ? fields.department : current.department,
      location_state: fields.location_state !== undefined ? fields.location_state : current.location_state,
      location_country: fields.location_country ?? current.location_country,
      employment_type: fields.employment_type ?? current.employment_type,
      pay_type: fields.pay_type ?? current.pay_type,
      tenure_start_date: fields.tenure_start_date ?? (current.tenure_start_date instanceof Date ? current.tenure_start_date.toISOString().slice(0, 10) : String(current.tenure_start_date).slice(0, 10)),
      recorded_by: current.recorded_by,
      created_at: current.created_at,
    };

    await supersede(tx, {
      table: 'employment_records',
      companyId,
      key: { employee_id: employeeId },
      payload: next,
      validFrom: effectiveAt,
      validTo: null,
      now: systemAt,
    });
    await tx.query(
      `INSERT INTO audit_events (company_id, actor_id, actor_kind, action, entity_type, entity_id, before, after)
       VALUES ($1, NULL, 'system', 'update', 'employment_record', $2, $3::jsonb, $4::jsonb)`,
      [companyId, employeeId, JSON.stringify(current), JSON.stringify(next)],
    );
    await q.send('resolve-assignment', { company_id: companyId, employee_ids: [employeeId], effective_at: effectiveAt.toISOString() });
    await recomputeNextMaterialDate(tx, companyId, employeeId, systemAt);
  });
  if (queue) await drainMemoryQueue(db, clock, queue);
}

export interface RuleInput {
  name: string;
  slotId: string;
  targetId: string;
  criteria: Predicate;
  priority?: number;
  effect?: 'grant' | 'deny';
  reason?: string;
}

export async function createRule(
  db: Db,
  companyId: string,
  input: RuleInput,
  effectiveAt: Date,
  clock: Clock,
  queue?: Queue,
): Promise<string> {
  const systemAt = clock.now();
  const ruleId = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  const rule: Rule = {
    id: versionId,
    ruleId,
    ruleCreatedAt: systemAt,
    companyId,
    slotId: input.slotId,
    targetId: input.targetId,
    name: input.name,
    source: 'rule',
    effect: input.effect ?? 'grant',
    priority: input.priority ?? 0,
    // Parse before anything else touches it: `criteria` is untrusted JSON, and
    // toSql compiles `field` into query text. See parsePredicate.
    criteria: parsePredicate(input.criteria),
    subjectEmployeeId: null,
    createdAt: systemAt,
  };
  const targetType = await slotTargetType(db, companyId, input.slotId);
  const candidates = await candidatesForRuleChange(db, companyId, null, rule, effectiveAt);

  await runTx(db, async (tx) => {
    const q = await txQueue(tx, db, queue);
    await supersede(tx, {
      table: 'assignment_rules',
      companyId,
      key: { rule_id: ruleId },
      payload: {
        slot_id: input.slotId,
        target_id: input.targetId,
        name: input.name,
        source: 'rule',
        effect: rule.effect,
        priority: rule.priority,
        // Persist the parsed form: what is stored is exactly what was validated.
        criteria: JSON.stringify(rule.criteria),
        subject_employee_id: null,
        target_type: targetType,
        rule_created_at: systemAt,
        created_at: systemAt,
      },
      validFrom: effectiveAt,
      validTo: null,
      now: systemAt,
    });
    await tx.query(
      `INSERT INTO audit_events (company_id, actor_id, actor_kind, action, entity_type, entity_id, after, reason)
       VALUES ($1, NULL, 'system', 'create', 'assignment_rule', $2, $3::jsonb, $4)`,
      [companyId, ruleId, JSON.stringify(rule), input.reason ?? null],
    );
    for (const empId of candidates) {
      await q.send('resolve-assignment', { company_id: companyId, employee_ids: [empId], effective_at: effectiveAt.toISOString() });
      await recomputeNextMaterialDate(tx, companyId, empId, systemAt);
    }
  });
  if (queue) await drainMemoryQueue(db, clock, queue);
  return ruleId;
}

/**
 * The slot decides the target type; migration 006's composite foreign keys then
 * force the rule's target to agree with it. Resolving it here means a rule that
 * names another company's slot fails with a sentence instead of a constraint
 * violation, and it supplies the denormalised discriminator those keys need.
 */
async function slotTargetType(db: Db, companyId: string, slotId: string): Promise<string> {
  const { rows } = await db.query<{ target_type: string }>(
    `SELECT target_type FROM assignment_slots WHERE company_id = $1 AND id = $2`,
    [companyId, slotId],
  );
  if (rows.length === 0) {
    throw new Error(`slot ${slotId} does not belong to company ${companyId}`);
  }
  return rows[0].target_type;
}

export interface RulePatch {
  name?: string;
  criteria?: Predicate;
  priority?: number;
  targetId?: string;
  effect?: 'grant' | 'deny';
  reason?: string;
}

export async function updateRule(
  db: Db,
  companyId: string,
  ruleId: string,
  patch: RulePatch,
  effectiveAt: Date,
  clock: Clock,
  queue?: Queue,
): Promise<void> {
  const systemAt = clock.now();
  await runTx(db, async (tx) => {
    const q = await txQueue(tx, db, queue);
    const { rows } = await tx.query<RuleRow>(
      `SELECT id, rule_id, rule_created_at, company_id, slot_id, target_id, name, source, effect, priority, criteria, subject_employee_id, created_at
       FROM assignment_rules
       WHERE rule_id = $1 AND company_id = $2 AND valid @> $3::timestamptz AND system @> $4::timestamptz`,
      [ruleId, companyId, effectiveAt.toISOString(), systemAt.toISOString()],
    );
    const current = rows[0];
    if (!current) throw new Error('Rule not found');
    const before = toRule(current);
    const after: Rule = {
      ...before,
      name: patch.name ?? before.name,
      criteria: patch.criteria === undefined ? before.criteria : parsePredicate(patch.criteria),
      priority: patch.priority ?? before.priority,
      targetId: patch.targetId ?? before.targetId,
      effect: patch.effect ?? before.effect,
    };
    const candidates = await candidatesForRuleChange(tx, companyId, before, after, effectiveAt);
    const targetType = await slotTargetType(tx, companyId, after.slotId);

    await supersede(tx, {
      table: 'assignment_rules',
      companyId,
      key: { rule_id: ruleId },
      payload: {
        slot_id: after.slotId,
        target_type: targetType,
        target_id: after.targetId,
        name: after.name,
        source: after.source,
        effect: after.effect,
        priority: after.priority,
        criteria: JSON.stringify(after.criteria),
        subject_employee_id: after.subjectEmployeeId,
        // D9: rule_created_at is the stable authoring time; it must survive edits.
        rule_created_at: toDate(current.rule_created_at),
        created_at: toDate(current.created_at),
      },
      validFrom: effectiveAt,
      validTo: null,
      now: systemAt,
    });
    await tx.query(
      `INSERT INTO audit_events (company_id, actor_id, actor_kind, action, entity_type, entity_id, before, after, reason)
       VALUES ($1, NULL, 'system', 'update', 'assignment_rule', $2, $3::jsonb, $4::jsonb, $5)`,
      [companyId, ruleId, JSON.stringify(before), JSON.stringify(after), patch.reason ?? null],
    );
    for (const empId of candidates) {
      await q.send('resolve-assignment', { company_id: companyId, employee_ids: [empId], effective_at: effectiveAt.toISOString() });
      await recomputeNextMaterialDate(tx, companyId, empId, systemAt);
    }
  });
  if (queue) await drainMemoryQueue(db, clock, queue);
}

export async function createManualOverride(
  db: Db,
  companyId: string,
  employeeId: string,
  input: Omit<RuleInput, 'criteria'> & { criteria?: Predicate },
  effectiveAt: Date,
  clock: Clock,
  queue?: Queue,
): Promise<string> {
  const systemAt = clock.now();
  const ruleId = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  const criteria: Predicate =
    input.criteria === undefined ? { op: 'always' } : parsePredicate(input.criteria);
  const rule: Rule = {
    id: versionId,
    ruleId,
    ruleCreatedAt: systemAt,
    companyId,
    slotId: input.slotId,
    targetId: input.targetId,
    name: input.name,
    source: 'manual',
    effect: input.effect ?? 'grant',
    priority: input.priority ?? 0,
    criteria,
    subjectEmployeeId: employeeId,
    createdAt: systemAt,
  };
  const targetType = await slotTargetType(db, companyId, input.slotId);
  const candidates = await candidatesForRuleChange(db, companyId, null, rule, effectiveAt);

  await runTx(db, async (tx) => {
    const q = await txQueue(tx, db, queue);
    await supersede(tx, {
      table: 'assignment_rules',
      companyId,
      key: { rule_id: ruleId },
      payload: {
        slot_id: input.slotId,
        target_id: input.targetId,
        name: input.name,
        source: 'manual',
        effect: rule.effect,
        priority: rule.priority,
        criteria: JSON.stringify(criteria),
        subject_employee_id: employeeId,
        target_type: targetType,
        rule_created_at: systemAt,
        created_at: systemAt,
      },
      validFrom: effectiveAt,
      validTo: null,
      now: systemAt,
    });
    await tx.query(
      `INSERT INTO audit_events (company_id, actor_id, actor_kind, action, entity_type, entity_id, after, reason)
       VALUES ($1, NULL, 'system', 'create', 'assignment_rule', $2, $3::jsonb, $4)`,
      [companyId, ruleId, JSON.stringify(rule), input.reason ?? null],
    );
    for (const empId of candidates) {
      await q.send('resolve-assignment', { company_id: companyId, employee_ids: [empId], effective_at: effectiveAt.toISOString() });
      await recomputeNextMaterialDate(tx, companyId, empId, systemAt);
    }
  });
  if (queue) await drainMemoryQueue(db, clock, queue);
  return ruleId;
}

export async function createSlotDependency(
  db: Db,
  companyId: string,
  slotId: string,
  dependsOnSlotId: string,
): Promise<void> {
  const deps = await fetchDeps(db, companyId);
  validateSlotGraph([...deps, { companyId, slotId, dependsOnSlotId }]);
  await runTx(db, async (tx) => {
    await tx.query(
      `INSERT INTO slot_dependencies (company_id, slot_id, depends_on_slot) VALUES ($1, $2, $3)`,
      [companyId, slotId, dependsOnSlotId],
    );
    await tx.query(
      `INSERT INTO audit_events (company_id, actor_id, actor_kind, action, entity_type, entity_id, after)
       VALUES ($1, NULL, 'system', 'create', 'slot_dependency', $2, $3::jsonb)`,
      [companyId, slotId, JSON.stringify({ slotId, dependsOnSlotId })],
    );
  });
}

export async function createGroup(
  db: Db,
  companyId: string,
  key: string,
  kind: 'static' | 'dynamic',
  criteria: Predicate | undefined,
  clock: Clock,
): Promise<string> {
  // Store the parsed form, so what is persisted is exactly what was validated.
  let parsed: Predicate | undefined;
  if (kind === 'dynamic') {
    if (!criteria) throw new Error('Dynamic group requires criteria');
    parsed = parsePredicate(criteria);
    validateGroupPredicate(parsed);
    toSql(parsed, clock.now(), []);
  }
  let groupId = '';
  await runTx(db, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO groups (company_id, key, kind, criteria) VALUES ($1, $2, $3, $4) RETURNING id`,
      [companyId, key, kind, parsed ? JSON.stringify(parsed) : null],
    );
    groupId = rows[0].id;
    await tx.query(
      `INSERT INTO audit_events (company_id, actor_id, actor_kind, action, entity_type, entity_id, after)
       VALUES ($1, NULL, 'system', 'create', 'group', $2, $3::jsonb)`,
      [companyId, groupId, JSON.stringify({ groupId, key, kind, criteria: parsed ?? null })],
    );
  });
  return groupId;
}

export async function addGroupMember(
  db: Db,
  companyId: string,
  groupId: string,
  employeeId: string,
  effectiveAt: Date,
  clock: Clock,
  queue?: Queue,
): Promise<void> {
  const systemAt = clock.now();
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM group_memberships
     WHERE company_id = $1 AND group_id = $2 AND employee_id = $3
       AND valid @> $4::timestamptz AND upper_inf(system)`,
    [companyId, groupId, employeeId, effectiveAt.toISOString()],
  );
  if (rows.length > 0) return;

  await runTx(db, async (tx) => {
    const q = await txQueue(tx, db, queue);
    await supersede(tx, {
      table: 'group_memberships',
      companyId,
      key: { group_id: groupId, employee_id: employeeId },
      payload: {},
      validFrom: effectiveAt,
      validTo: null,
      now: systemAt,
    });
    await tx.query(
      `INSERT INTO audit_events (company_id, actor_id, actor_kind, action, entity_type, entity_id, after)
       VALUES ($1, NULL, 'system', 'create', 'group_membership', $2, $3::jsonb)`,
      [companyId, groupId, JSON.stringify({ groupId, employeeId })],
    );
    await q.send('resolve-assignment', { company_id: companyId, employee_ids: [employeeId], effective_at: effectiveAt.toISOString() });
    await recomputeNextMaterialDate(tx, companyId, employeeId, systemAt);
  });
  if (queue) await drainMemoryQueue(db, clock, queue);
}

export async function removeGroupMember(
  db: Db,
  companyId: string,
  groupId: string,
  employeeId: string,
  effectiveAt: Date,
  clock: Clock,
  queue?: Queue,
): Promise<void> {
  const systemAt = clock.now();
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM group_memberships
     WHERE company_id = $1 AND group_id = $2 AND employee_id = $3
       AND valid @> $4::timestamptz AND upper_inf(system)`,
    [companyId, groupId, employeeId, effectiveAt.toISOString()],
  );
  if (rows.length === 0) return;

  await runTx(db, async (tx) => {
    const q = await txQueue(tx, db, queue);
    await supersede(tx, {
      table: 'group_memberships',
      companyId,
      key: { group_id: groupId, employee_id: employeeId },
      payload: null,
      validFrom: effectiveAt,
      validTo: null,
      now: systemAt,
    });
    await tx.query(
      `INSERT INTO audit_events (company_id, actor_id, actor_kind, action, entity_type, entity_id, before)
       VALUES ($1, NULL, 'system', 'delete', 'group_membership', $2, $3::jsonb)`,
      [companyId, groupId, JSON.stringify({ groupId, employeeId })],
    );
    await q.send('resolve-assignment', { company_id: companyId, employee_ids: [employeeId], effective_at: effectiveAt.toISOString() });
    await recomputeNextMaterialDate(tx, companyId, employeeId, systemAt);
  });
  if (queue) await drainMemoryQueue(db, clock, queue);
}
