import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import {
  createTestDb,
  insertCompany,
  insertEmployee,
  insertEmploymentRecord,
  insertSlot,
  insertAssignmentTarget,
  insertRule,
  insertResolvedAssignment,
  insertGroup,
} from './helpers';
import { simulateEmployee, type FactPatch } from '../src/simulate';
import { explainEmployee } from '../src/explain';
import { updateEmploymentRecord, updateRule, addGroupMember, removeGroupMember, createGroup, createSlotDependency, createRule } from '../src/api/writes';
import { reconcileEmployee, fetchRules } from '../src/reconcile';
import { resolveEmployee } from '../src/resolver';
import { buildEmployeeState } from '../src/state';
import { FixedClock } from '../src/clock';
import { memoryQueue } from '../src/queue';
import { fetchCurrentAssignments } from '../src/reconcile';
import type { Db } from '../src/db';

let db: PGlite;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

async function resolvedCount(companyId: string, employeeId: string): Promise<number> {
  const { rows } = await (db as unknown as Db).query<{ c: unknown }>(
    'SELECT COUNT(*) AS c FROM resolved_assignments WHERE company_id = $1 AND employee_id = $2',
    [companyId, employeeId],
  );
  return Number(rows[0].c);
}

describe('simulate and explain', () => {
  it('test_simulate_returns_added_removed_unchanged_with_reasons_and_writes_no_rows', async () => {
    const companyId = await insertCompany(db, 'api1');
    const employeeId = await insertEmployee(db, companyId, 'api1@example.com');
    await insertEmploymentRecord(db, companyId, employeeId);
    const vacationSlot = await insertSlot(db, companyId, 'vacation', 'exactly_one', 'policy');
    const appsSlot = await insertSlot(db, companyId, 'apps', 'many', 'app');
    const vacationTarget = await insertAssignmentTarget(db, companyId, 'policy', 'Old Vacation');
    const newVacationTarget = await insertAssignmentTarget(db, companyId, 'policy', 'New Vacation');
    const appTarget = await insertAssignmentTarget(db, companyId, 'app', 'Slack');
    const r1 = await insertRule(db, companyId, vacationSlot, vacationTarget, 'Old Vacation Rule', { op: 'always' });
    const rApps = await insertRule(db, companyId, appsSlot, appTarget, 'Slack Rule', { op: 'always' });
    await insertResolvedAssignment(db as unknown as Db, companyId, employeeId, vacationSlot, vacationTarget, r1);
    await insertResolvedAssignment(db as unknown as Db, companyId, employeeId, appsSlot, appTarget, rApps, false);

    await insertRule(db, companyId, vacationSlot, newVacationTarget, 'New Vacation Rule', { op: 'always' }, { priority: 10 });

    const before = await resolvedCount(companyId, employeeId);
    const result = await simulateEmployee(db as unknown as Db, companyId, employeeId, new Date('2024-06-01'), new Date('2024-06-01'));
    const after = await resolvedCount(companyId, employeeId);

    expect(after).toBe(before);
    expect(result.added.map((i) => i.targetId)).toContain(newVacationTarget);
    expect(result.removed.map((i) => i.targetId)).toContain(vacationTarget);
    expect(result.unchanged.map((i) => i.targetId)).toContain(appTarget);
    expect(result.added.find((i) => i.targetId === newVacationTarget)?.reason).toContain('New Vacation Rule');
    expect(result.removed.find((i) => i.targetId === vacationTarget)?.reason).toBe('no longer matched');
    expect(result.unchanged.find((i) => i.targetId === appTarget)?.reason).toBe('already assigned');
  });

  it('test_simulate_applies_fact_patch_to_compute_added_and_removed', async () => {
    const companyId = await insertCompany(db, 'apipatch');
    const employeeId = await insertEmployee(db, companyId, 'apipatch@example.com');
    await insertEmploymentRecord(db, companyId, employeeId, '2024-01-01');
    const vacationSlot = await insertSlot(db, companyId, 'vacation', 'exactly_one', 'policy');
    const appsSlot = await insertSlot(db, companyId, 'apps', 'many', 'app');
    const standardTarget = await insertAssignmentTarget(db, companyId, 'policy', 'Standard Vacation');
    const seniorTarget = await insertAssignmentTarget(db, companyId, 'policy', 'Senior Vacation');
    const appTarget = await insertAssignmentTarget(db, companyId, 'app', 'Slack');
    await insertRule(db, companyId, vacationSlot, seniorTarget, 'Senior after 2 years', { op: 'gte_tenure', years: 2 }, { priority: 10 });
    const rStandard = await insertRule(db, companyId, vacationSlot, standardTarget, 'Standard base', { op: 'always' });
    const rSlack = await insertRule(db, companyId, appsSlot, appTarget, 'Slack', { op: 'always' });

    // Seed current resolved state: standard vacation + Slack (employee is not yet senior).
    await insertResolvedAssignment(db as unknown as Db, companyId, employeeId, vacationSlot, standardTarget, rStandard);
    await insertResolvedAssignment(db as unknown as Db, companyId, employeeId, appsSlot, appTarget, rSlack, false);

    // At 2025-06-01 the employee has only 1.5 years tenure => standard vacation.
    const before = await resolvedCount(companyId, employeeId);
    const patch: FactPatch = { tenure_start_date: '2022-01-01' };
    const result = await simulateEmployee(
      db as unknown as Db,
      companyId,
      employeeId,
      new Date('2025-06-01T00:00:00Z'),
      new Date('2025-06-01T00:00:00Z'),
      patch,
    );
    const after = await resolvedCount(companyId, employeeId);

    expect(after).toBe(before);
    expect(result.added.map((i) => i.targetId)).toContain(seniorTarget);
    expect(result.removed.map((i) => i.targetId)).toContain(standardTarget);
    expect(result.unchanged.map((i) => i.targetId)).toContain(appTarget);
  });

  it('test_explain_returns_stored_trace_at_historical_system_time', async () => {
    const companyId = await insertCompany(db, 'api2');
    const employeeId = await insertEmployee(db, companyId, 'api2@example.com');
    await insertEmploymentRecord(db, companyId, employeeId);
    const slotId = await insertSlot(db, companyId, 'vacation', 'exactly_one', 'policy');
    const targetId = await insertAssignmentTarget(db, companyId, 'policy', 'Old');
    const ruleId = '00000000-0000-0000-0000-0000000000b1';

    await insertResolvedAssignment(
      db as unknown as Db,
      companyId,
      employeeId,
      slotId,
      targetId,
      ruleId,
      true,
      { marker: 'old-belief' },
      '2024-01-01T00:00:00Z',
      null,
      '2024-01-01T00:00:00Z',
      '2024-09-01T00:00:00Z',
    );

    const historical = await explainEmployee(db as unknown as Db, companyId, employeeId, new Date('2024-03-01'));
    expect(historical).toHaveLength(1);
    expect(historical[0].targetId).toBe(targetId);
    expect((historical[0].explainTrace as { marker?: string }).marker).toBe('old-belief');

    const current = await explainEmployee(db as unknown as Db, companyId, employeeId, new Date('2024-10-01'));
    expect(current).toHaveLength(0);
  });

  it('test_simulate_and_explain_are_multi_tenant_safe', async () => {
    const companyA = await insertCompany(db, 'api3a');
    const employeeA = await insertEmployee(db, companyA, 'a@example.com');
    await insertEmploymentRecord(db, companyA, employeeA);
    const slotA = await insertSlot(db, companyA, 'vacation', 'exactly_one', 'policy');
    const targetA = await insertAssignmentTarget(db, companyA, 'policy', 'A');
    const ruleA = await insertRule(db, companyA, slotA, targetA, 'A rule', { op: 'always' });
    await insertResolvedAssignment(db as unknown as Db, companyA, employeeA, slotA, targetA, ruleA);

    const companyB = await insertCompany(db, 'api3b');
    const employeeB = await insertEmployee(db, companyB, 'b@example.com');
    await insertEmploymentRecord(db, companyB, employeeB);
    const slotB = await insertSlot(db, companyB, 'vacation', 'exactly_one', 'policy');
    const targetB = await insertAssignmentTarget(db, companyB, 'policy', 'B');
    await insertRule(db, companyB, slotB, targetB, 'B rule', { op: 'always' });

    const simB = await simulateEmployee(db as unknown as Db, companyB, employeeB, new Date('2024-06-01'), new Date('2024-06-01'));
    expect(simB.added.map((i) => i.targetId)).toEqual([targetB]);
    expect(simB.removed).toHaveLength(0);
    expect(simB.unchanged).toHaveLength(0);

    const explainB = await explainEmployee(db as unknown as Db, companyB, employeeB, new Date('2024-06-01'));
    expect(explainB).toHaveLength(0);

    const explainA = await explainEmployee(db as unknown as Db, companyA, employeeA, new Date('2024-06-01'));
    expect(explainA.map((i) => i.targetId)).toEqual([targetA]);
  });

  it('test_simulated_relocation_drops_dynamic_group_and_its_apps', async () => {
    const companyId = await insertCompany(db, 'apigroup');
    const employeeId = await insertEmployee(db, companyId, 'apigroup@example.com');
    await insertEmploymentRecord(db, companyId, employeeId, '2024-01-01');
    await insertGroup(db, companyId, 'engineering', 'dynamic', { op: 'eq', field: 'department', value: 'Engineering' });

    const appsSlot = await insertSlot(db, companyId, 'apps', 'many', 'app');
    const slackTarget = await insertAssignmentTarget(db, companyId, 'app', 'Slack');
    const ruleId = await insertRule(db, companyId, appsSlot, slackTarget, 'Slack for engineering', { op: 'in_group', group: 'engineering' });
    await insertResolvedAssignment(db as unknown as Db, companyId, employeeId, appsSlot, slackTarget, ruleId, false);

    const asOf = new Date('2024-06-01T00:00:00Z');
    const result = await simulateEmployee(db as unknown as Db, companyId, employeeId, asOf, asOf, { department: 'Sales' });

    expect(result.removed.map((i) => i.targetId)).toContain(slackTarget);
  });

  it('test_simulate_result_matches_actual_reconcile_result', async () => {
    const companyId = await insertCompany(db, 'apimatch');
    const employeeId = await insertEmployee(db, companyId, 'apimatch@example.com');
    await insertEmploymentRecord(db, companyId, employeeId, '2024-01-01');
    await insertGroup(db, companyId, 'engineering', 'dynamic', { op: 'eq', field: 'department', value: 'Engineering' });

    const appsSlot = await insertSlot(db, companyId, 'apps', 'many', 'app');
    const slackTarget = await insertAssignmentTarget(db, companyId, 'app', 'Slack');
    const ruleId = await insertRule(db, companyId, appsSlot, slackTarget, 'Slack for engineering', { op: 'in_group', group: 'engineering' });
    await insertResolvedAssignment(db as unknown as Db, companyId, employeeId, appsSlot, slackTarget, ruleId, false);

    const asOf = new Date('2024-06-01T00:00:00Z');
    const clock = new FixedClock(asOf);
    const queue = memoryQueue();

    const sim = await simulateEmployee(db as unknown as Db, companyId, employeeId, asOf, asOf, { department: 'Sales' });
    await updateEmploymentRecord(db as unknown as Db, companyId, employeeId, { department: 'Sales' }, asOf, clock, queue);
    await reconcileEmployee(db as unknown as Db, companyId, employeeId, asOf, clock, queue);

    const after = await fetchCurrentAssignments(db as unknown as Db, companyId, employeeId, asOf, asOf);
    const actualTargetIds = [...after.values()].map((r) => r.target_id).sort();
    const simRemainingIds = [...sim.unchanged, ...sim.added].map((i) => i.targetId).sort();

    expect(simRemainingIds).toEqual(actualTargetIds);
    expect(sim.removed.map((i) => i.targetId)).toContain(slackTarget);
  });

  it('test_future_effective_rename_does_not_change_past_resolution', async () => {
    // Regression for H1: an edit effective from T must not change resolution for any date before T.
    const companyId = await insertCompany(db, 'h1');
    const employeeId = await insertEmployee(db, companyId, 'h1@example.com');
    await insertEmploymentRecord(db, companyId, employeeId);

    const vacationSlot = await insertSlot(db, companyId, 'vacation', 'exactly_one', 'policy');
    const targetA = await insertAssignmentTarget(db, companyId, 'policy', 'A');
    const targetB = await insertAssignmentTarget(db, companyId, 'policy', 'B');

    // Rule A was authored in January, Rule B in February; same priority => A wins in March.
    const ruleA = await insertRule(db, companyId, vacationSlot, targetA, 'Rule A', { op: 'always' });
    const ruleB = await insertRule(db, companyId, vacationSlot, targetB, 'Rule B', { op: 'always' });
    await (db as unknown as Db).query(
      'UPDATE assignment_rules SET rule_created_at = $1 WHERE rule_id = $2',
      ['2026-01-01T00:00:00Z', ruleA],
    );
    await (db as unknown as Db).query(
      'UPDATE assignment_rules SET rule_created_at = $1 WHERE rule_id = $2',
      ['2026-02-01T00:00:00Z', ruleB],
    );

    const march = new Date('2026-03-15T00:00:00Z');
    const first = await reconcileEmployee(db as unknown as Db, companyId, employeeId, march, new FixedClock(new Date('2026-01-15T00:00:00Z')));

    // Rename rule A, effective June. The system records the edit on Sept 4.
    await updateRule(db as unknown as Db, companyId, ruleA, { name: 'Renamed A' }, new Date('2026-06-01T00:00:00Z'), new FixedClock(new Date('2026-09-04T00:00:00Z')));

    // Resolve March again from the Sept 5 belief. The result must be byte-identical.
    const second = await reconcileEmployee(db as unknown as Db, companyId, employeeId, march, new FixedClock(new Date('2026-09-05T00:00:00Z')));

    expect(second.assignments.map((a) => a.targetId)).toEqual(first.assignments.map((a) => a.targetId));
    expect(second.assignments[0].targetId).toBe(targetA);
  });

  it('test_removing_a_member_revokes_group_granted_assignments', async () => {
    const companyId = await insertCompany(db, 'groups');
    const employeeId = await insertEmployee(db, companyId, 'g@example.com');
    await insertEmploymentRecord(db, companyId, employeeId);

    const slotId = await insertSlot(db, companyId, 'eng_perk', 'many', 'app');
    const targetId = await insertAssignmentTarget(db, companyId, 'app', 'Perk');
    await insertRule(db, companyId, slotId, targetId, 'eng-only', { op: 'in_group', group: 'eng' });

    const groupId = await insertGroup(db, companyId, 'eng', 'static');
    const asOf = new Date('2026-01-15T00:00:00Z');
    const clock = new FixedClock(asOf);
    const queue = memoryQueue();

    await addGroupMember(db as unknown as Db, companyId, groupId, employeeId, asOf, clock, queue);
    let current = await fetchCurrentAssignments(db as unknown as Db, companyId, employeeId, asOf, asOf);
    expect([...current.values()].map((r) => r.target_id)).toContain(targetId);

    await removeGroupMember(db as unknown as Db, companyId, groupId, employeeId, asOf, clock, queue);
    current = await fetchCurrentAssignments(db as unknown as Db, companyId, employeeId, asOf, asOf);
    expect([...current.values()].map((r) => r.target_id)).not.toContain(targetId);
  });

  it('test_membership_change_candidates_include_removed_member', async () => {
    const companyId = await insertCompany(db, 'groups2');
    const employeeId = await insertEmployee(db, companyId, 'g2@example.com');
    await insertEmploymentRecord(db, companyId, employeeId);
    const groupId = await insertGroup(db, companyId, 'hq', 'static');
    const asOf = new Date('2026-01-15T00:00:00Z');

    const jobs: { name: string; data: unknown }[] = [];
    const queue = { send: async (name: string, data: unknown) => { jobs.push({ name, data }); } };

    await addGroupMember(db as unknown as Db, companyId, groupId, employeeId, asOf, new FixedClock(asOf), queue);
    await removeGroupMember(db as unknown as Db, companyId, groupId, employeeId, asOf, new FixedClock(asOf), queue);

    const enqueued = jobs
      .filter((j) => j.name === 'resolve-assignment')
      .map((j) => (j.data as { employee_ids: string[] }).employee_ids[0]);
    expect(enqueued).toEqual(expect.arrayContaining([employeeId, employeeId]));
  });

  it('test_create_group_emits_audit_event', async () => {
    const companyId = await insertCompany(db, 'audit');
    const clock = new FixedClock(new Date('2026-01-15T00:00:00Z'));
    const groupId = await createGroup(db as unknown as Db, companyId, 'hq', 'static', undefined, clock);

    const { rows } = await (db as unknown as Db).query<{ entity_type: string; entity_id: string; action: string }>(
      'SELECT entity_type, entity_id, action FROM audit_events WHERE entity_id = $1',
      [groupId],
    );
    expect(rows).toEqual([{ entity_type: 'group', entity_id: groupId, action: 'create' }]);
  });

  it('test_slot_dependency_creation_is_transactional_and_audited', async () => {
    const companyId = await insertCompany(db, 'deps');
    const slotA = await insertSlot(db, companyId, 'a', 'many', 'app');
    const slotB = await insertSlot(db, companyId, 'b', 'many', 'app');

    await createSlotDependency(db as unknown as Db, companyId, slotA, slotB);

    const { rows: deps } = await (db as unknown as Db).query<{ slot_id: string }>(
      'SELECT slot_id FROM slot_dependencies WHERE company_id = $1',
      [companyId],
    );
    expect(deps).toHaveLength(1);

    const { rows: audit } = await (db as unknown as Db).query<{ entity_type: string; action: string }>(
      'SELECT entity_type, action FROM audit_events WHERE entity_type = $1',
      ['slot_dependency'],
    );
    expect(audit).toEqual([{ entity_type: 'slot_dependency', action: 'create' }]);
  });

  it('test_failed_rule_creation_does_not_enqueue_resolve_assignment', async () => {
    const companyId = await insertCompany(db, 'rollback');
    const employeeId = await insertEmployee(db, companyId, 'rb@example.com');
    await insertEmploymentRecord(db, companyId, employeeId);
    const badSlot = '00000000-0000-0000-0000-000000000000';
    const targetId = await insertAssignmentTarget(db, companyId, 'policy', 'X');
    const queue = memoryQueue();

    await expect(
      createRule(
        db as unknown as Db,
        companyId,
        {
          name: 'Bad rule',
          slotId: badSlot,
          targetId,
          criteria: { op: 'always' },
        },
        new Date('2026-01-15T00:00:00Z'),
        new FixedClock(new Date('2026-01-15T00:00:00Z')),
        queue,
      ),
    ).rejects.toThrow();

    expect(queue.sent).toHaveLength(0);
  });

  it('test_same_result_regardless_of_job_arrival_order', async () => {
    // Two different effective dates, both arrival orders, identical timelines.
    // The property being defended: a reconciliation at T asserts only what it
    // knows — [T, next boundary) — so a delayed older job cannot overwrite a
    // later transition that has already been published.
    async function scenario(testDb: PGlite, order: 'old-first' | 'new-first') {
      const companyId = await insertCompany(testDb, 'ooo');
      const employeeId = await insertEmployee(testDb, companyId, 'ooo@example.com');
      await insertEmploymentRecord(testDb, companyId, employeeId, '2024-01-01');
      const slotId = await insertSlot(testDb, companyId, 'vacation', 'exactly_one', 'policy');
      const std = await insertAssignmentTarget(testDb, companyId, 'policy', 'Standard');
      const sen = await insertAssignmentTarget(testDb, companyId, 'policy', 'Senior');
      await insertRule(testDb, companyId, slotId, std, 'Standard', { op: 'always' }, { priority: 0 });
      await insertRule(testDb, companyId, slotId, sen, 'Senior', { op: 'gte_tenure', years: 2 }, { priority: 10 });

      // effectiveAt is valid time; the system clock is always "now" and never
      // goes backwards. The delayed job for 2025 arrives at system time
      // 2026-02-01 — after the 2026 transition was already published.
      const runs: [effectiveAt: string, systemAt: string][] = order === 'old-first'
        ? [['2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z'], ['2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z']]
        : [['2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'], ['2025-01-01T00:00:00Z', '2026-02-01T00:00:00Z']];
      for (const [effectiveAt, systemAt] of runs) {
        await reconcileEmployee(testDb as unknown as Db, companyId, employeeId, new Date(effectiveAt), new FixedClock(new Date(systemAt)));
      }
      // to_char renders timestamptz in the session timezone; pin it to UTC so
      // the timeline comparison is timezone-independent.
      await (testDb as unknown as Db).exec?.("SET TIME ZONE 'UTC'");
      const { rows } = await (testDb as unknown as Db).query<{ f: string; u: string | null; t: string }>(
        `SELECT to_char(lower(ra.valid),'YYYY-MM-DD') AS f, to_char(upper(ra.valid),'YYYY-MM-DD') AS u, at.display_name AS t
         FROM resolved_assignments ra JOIN assignment_targets at ON at.id = ra.target_id
         WHERE ra.company_id = $1 AND upper_inf(ra.system) ORDER BY lower(ra.valid)`,
        [companyId],
      );
      return rows.map((r) => `${r.t}:${r.f}..${r.u ?? 'open'}`);
    }

    const dbA = await createTestDb();
    const dbB = await createTestDb();
    const a = await scenario(dbA, 'new-first');
    const b = await scenario(dbB, 'old-first');
    expect(b).toEqual(a);
    expect(a).toEqual([
      'Standard:2025-01-01..2026-01-01',
      'Senior:2026-01-01..open',
    ]);
  });

  it('test_resolved_assignments_rebuildable_from_facts_and_rules', async () => {
    const companyId = await insertCompany(db, 'rebuild');
    const employeeId = await insertEmployee(db, companyId, 'rebuild@example.com');
    await insertEmploymentRecord(db, companyId, employeeId);
    const slotId = await insertSlot(db, companyId, 'vacation', 'exactly_one', 'policy');
    const targetId = await insertAssignmentTarget(db, companyId, 'policy', 'Vacation');
    await insertRule(db, companyId, slotId, targetId, 'vacation', { op: 'always' });

    const clock = new FixedClock(new Date('2026-01-15T00:00:00Z'));
    await reconcileEmployee(db as unknown as Db, companyId, employeeId, clock.now(), clock);

    const [state, rules] = await Promise.all([
      buildEmployeeState(db as unknown as Db, companyId, employeeId, clock.now(), clock.now()),
      fetchRules(db as unknown as Db, companyId, employeeId, clock.now(), clock.now()),
    ]);
    const slots = [{ id: slotId, companyId, key: 'vacation', displayName: 'Vacation', cardinality: 'exactly_one' as const, targetType: 'policy' as const }];
    const rebuilt = resolveEmployee(slots, rules, state!, clock.now());
    const expected = new Set(rebuilt.assignments.map((a) => `${a.slotId}:${a.targetId}`));

    const current = await fetchCurrentAssignments(db as unknown as Db, companyId, employeeId, clock.now(), clock.now());
    const actual = new Set([...current.keys()]);
    expect(actual).toEqual(expected);
  });
});

describe('segmented reconciliation (FIXES-6)', () => {
  it('test_delayed_job_does_not_restore_a_revoked_group_assignment', async () => {
    // Reproduction for finding 1: a membership with a finite END must cut the
    // timeline. Without the end edge, the delayed job below asserted
    // [2025-03-01, ∞) and resurrected the app past its revocation.
    const companyId = await insertCompany(db, 'revoked');
    const employeeId = await insertEmployee(db, companyId, 'revoked@example.com');
    await insertEmploymentRecord(db, companyId, employeeId);
    const slotId = await insertSlot(db, companyId, 'apps', 'many', 'app');
    const appId = await insertAssignmentTarget(db, companyId, 'app', 'VPN');
    const groupId = await insertGroup(db, companyId, 'grp', 'static');
    await insertRule(db, companyId, slotId, appId, 'grp app', { op: 'in_group', group: 'grp' });

    // Membership was valid [2024-01-01, 2025-06-01) and then revoked.
    await db.query(
      `INSERT INTO group_memberships (company_id, group_id, employee_id, valid, system)
       VALUES ($1, $2, $3,
               tstzrange('2024-01-01T00:00:00Z'::timestamptz, '2025-06-01T00:00:00Z'::timestamptz),
               tstzrange('2024-01-01T00:00:00Z'::timestamptz, NULL))`,
      [companyId, groupId, employeeId],
    );

    // Post-revocation reconcile runs first and publishes nothing.
    await reconcileEmployee(db as unknown as Db, companyId, employeeId,
      new Date('2025-07-01T00:00:00Z'), new FixedClock(new Date('2025-07-01T00:00:00Z')));

    // A delayed job for during-membership arrives later. Its conclusion is only
    // good until the revocation edge it already knows about.
    await reconcileEmployee(db as unknown as Db, companyId, employeeId,
      new Date('2025-03-01T00:00:00Z'), new FixedClock(new Date('2025-08-01T00:00:00Z')));

    // The grant exists over [2025-03-01, 2025-06-01) and nowhere else.
    const during = await fetchCurrentAssignments(db as unknown as Db, companyId, employeeId,
      new Date('2025-04-01T00:00:00Z'), new Date('2025-08-01T00:00:00Z'));
    expect([...during.keys()]).toEqual([`${slotId}:${appId}`]);

    const after = await fetchCurrentAssignments(db as unknown as Db, companyId, employeeId,
      new Date('2025-07-01T00:00:00Z'), new Date('2025-08-01T00:00:00Z'));
    expect(after.size).toBe(0);
  });

  it('test_reconciling_an_old_date_still_covers_today', async () => {
    // Reproduction for finding 2: a reconcile at an old effective date with
    // nothing known to change must publish an OPEN-ENDED final segment. The
    // fixed-horizon version closed it at T+2y, so it had already expired by the
    // time anyone read it, and nothing was scheduled to extend it.
    const companyId = await insertCompany(db, 'olddate');
    const employeeId = await insertEmployee(db, companyId, 'olddate@example.com');
    await insertEmploymentRecord(db, companyId, employeeId);
    const slotId = await insertSlot(db, companyId, 'vacation', 'exactly_one', 'policy');
    const targetId = await insertAssignmentTarget(db, companyId, 'policy', 'Vacation');
    await insertRule(db, companyId, slotId, targetId, 'vacation', { op: 'always' });

    await reconcileEmployee(db as unknown as Db, companyId, employeeId,
      new Date('2024-01-01T00:00:00Z'), new FixedClock(new Date('2026-03-01T00:00:00Z')));

    const current = await fetchCurrentAssignments(db as unknown as Db, companyId, employeeId,
      new Date('2026-03-01T00:00:00Z'), new Date('2026-03-01T00:00:00Z'));
    expect([...current.keys()]).toEqual([`${slotId}:${targetId}`]);

    const { rows } = await (db as unknown as Db).query<{ u: string | null }>(
      `SELECT upper(valid) AS u FROM resolved_assignments
       WHERE company_id = $1 AND employee_id = $2 AND upper_inf(system)`,
      [companyId, employeeId],
    );
    expect(rows[0].u).toBeNull();
  });

  it('test_truncated_plan_enqueues_a_continuation_job', async () => {
    // With more boundaries than MAX_SEGMENTS_PER_RUN the plan truncates; the
    // caller must enqueue a continuation at continueAt or the timeline stops.
    const companyId = await insertCompany(db, 'trunc');
    const employeeId = await insertEmployee(db, companyId, 'trunc@example.com');
    await insertEmploymentRecord(db, companyId, employeeId);
    const slotId = await insertSlot(db, companyId, 'apps', 'many', 'app');

    // 60 already-published consecutive segments: 59 distinct boundary instants
    // (each lower edge; uppers coincide with the next lower). Ranges on the same
    // timeline key may not overlap, so they are made adjacent rather than open.
    const targetId = await insertAssignmentTarget(db, companyId, 'app', 'App');
    const boundaryDates: string[] = [];
    for (let i = 1; i <= 60; i++) {
      const lo = new Date(Date.UTC(2026, 0, 1 + i)).toISOString();
      const hi = i < 60 ? new Date(Date.UTC(2026, 0, 2 + i)).toISOString() : null;
      boundaryDates.push(lo);
      await insertResolvedAssignment(db, companyId, employeeId, slotId, targetId,
        crypto.randomUUID(), false, {}, lo, hi);
    }
    const cuts = [...new Set(boundaryDates)].sort();
    // planSegments takes the first MAX_SEGMENTS_PER_RUN - 1 = 49 cuts; the last
    // taken cut is continueAt.
    const expectedContinue = cuts[48];

    const queue = memoryQueue();
    await reconcileEmployee(db as unknown as Db, companyId, employeeId,
      new Date('2025-01-01T00:00:00Z'), new FixedClock(new Date('2025-01-01T00:00:00Z')), queue);

    const continuations = queue.sent.filter((j) =>
      j.name === 'resolve-assignment'
      && (j.data as { employee_ids: string[] }).employee_ids.includes(employeeId));
    expect(continuations).toHaveLength(1);
    expect((continuations[0].data as { effective_at: string }).effective_at).toBe(new Date(expectedContinue).toISOString());
  });

  it('test_dynamic_group_tenure_transition_publishes_the_app', async () => {
    // The rule references a dynamic group; the tenure threshold lives one level
    // down inside the group definition. Without expansion, no anniversary job
    // is ever scheduled and no boundary is ever cut.
    const companyId = await insertCompany(db, 'dyngrp');
    const employeeId = await insertEmployee(db, companyId, 'dyngrp@example.com');
    await insertEmploymentRecord(db, companyId, employeeId, '2024-01-01');
    const slotId = await insertSlot(db, companyId, 'apps', 'many', 'app');
    const appId = await insertAssignmentTarget(db, companyId, 'app', 'VPN');
    await insertGroup(db, companyId, 'two-year-club', 'dynamic', { op: 'gte_tenure', years: 2 });
    await insertRule(db, companyId, slotId, appId, 'club app', { op: 'in_group', group: 'two-year-club' });

    // Reconcile before the anniversary. The assignment is absent now, but the
    // threshold must still be scheduled AND cut as a segment boundary, so the
    // future transition is published immediately.
    await reconcileEmployee(db as unknown as Db, companyId, employeeId,
      new Date('2025-01-01T00:00:00Z'), new FixedClock(new Date('2025-01-01T00:00:00Z')));

    let current = await fetchCurrentAssignments(db as unknown as Db, companyId, employeeId,
      new Date('2025-01-01T00:00:00Z'), new Date('2025-01-01T00:00:00Z'));
    expect(current.size).toBe(0);

    const { rows } = await (db as unknown as Db).query<{ next_at: string | null }>(
      `SELECT next_at FROM employee_next_material_date
       WHERE company_id = $1 AND employee_id = $2`,
      [companyId, employeeId],
    );
    expect(rows[0].next_at).not.toBeNull();
    expect(new Date(rows[0].next_at as string).toISOString().slice(0, 10)).toBe('2026-01-01');

    // At the anniversary the app is already published.
    current = await fetchCurrentAssignments(db as unknown as Db, companyId, employeeId,
      new Date('2026-01-01T00:00:00Z'), new Date('2025-01-01T00:00:00Z'));
    expect([...current.keys()]).toEqual([`${slotId}:${appId}`]);
  });
});
