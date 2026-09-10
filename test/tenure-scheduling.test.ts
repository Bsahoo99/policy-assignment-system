import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import {
  createTestDb,
  insertCompany,
  insertEmployee,
  insertEmploymentRecord,
  insertSlot,
  insertAssignmentTarget,
} from './helpers';
import { createRule } from '../src/api/writes';
import { dispatchDueMaterialDates } from '../src/scheduler';
import { memoryQueue } from '../src/queue';
import { FixedClock } from '../src/clock';
import { drainMemoryQueue } from '../src/runtime';
import type { Db } from '../src/db';

let pg: PGlite;
let db: Db;

beforeAll(async () => {
  pg = await createTestDb();
  db = pg as unknown as Db;
});
afterAll(async () => {
  await pg.close();
});

async function scheduleRow(companyId: string, employeeId: string) {
  const { rows } = await db.query<{ next_at: string | null }>(
    `SELECT next_at FROM employee_next_material_date WHERE company_id = $1 AND employee_id = $2`,
    [companyId, employeeId],
  );
  return rows[0] ?? null;
}

async function assignedTargets(companyId: string, employeeId: string, at: string) {
  const { rows } = await db.query<{ display_name: string }>(
    `SELECT t.display_name
       FROM resolved_assignments ra
       JOIN assignment_targets t ON t.id = ra.target_id
      WHERE ra.company_id = $1 AND ra.employee_id = $2
        AND ra.valid @> $3::timestamptz AND upper_inf(ra.system)`,
    [companyId, employeeId, at],
  );
  return rows.map((r) => r.display_name);
}

/**
 * The brief's own tenure example: "once an employee hits 2 years of tenure, they
 * get moved to a more generous time-off policy". Nothing happens at that moment —
 * no write, no user action, no event — so the assignment can only appear if the
 * system scheduled it in advance. An employee who does not match the rule *yet*
 * is exactly the employee the rule was written for.
 */
describe('tenure scheduling for employees who do not match yet', () => {
  /**
   * Eligibility that ends is as much a scheduled change as eligibility that
   * begins. A policy for employees between one and two years has to be taken
   * away on the second anniversary, and nothing happens at that instant either.
   */
  it('test_an_employee_who_will_lose_eligibility_is_scheduled_for_that_too', async () => {
    const companyId = await insertCompany(db, 'sched-lose');
    const employeeId = await insertEmployee(db, companyId, 'losing@example.com');
    await insertEmploymentRecord(db, companyId, employeeId, '2024-01-01');
    const slotId = await insertSlot(db, companyId, 'vacation', 'exactly_one', 'policy');
    const targetId = await insertAssignmentTarget(db, companyId, 'policy', 'Mid-Tenure Policy');

    // At the write the employee has 18 months: inside the window, and due to
    // leave it on 2026-01-01.
    const now = new Date('2025-07-01T00:00:00Z');
    const queue = memoryQueue();
    await createRule(
      db,
      companyId,
      {
        name: 'One to two years',
        slotId,
        targetId,
        criteria: {
          op: 'and',
          children: [
            { op: 'gte_tenure', years: 1 },
            { op: 'not', child: { op: 'gte_tenure', years: 2 } },
          ],
        },
      },
      now,
      new FixedClock(now),
      queue,
    );

    const row = await scheduleRow(companyId, employeeId);
    expect(row?.next_at, 'losing eligibility must be scheduled').not.toBeNull();
    expect(new Date(row!.next_at!).toISOString().slice(0, 10)).toBe('2026-01-01');
  });

  /**
   * A threshold can sit one level down inside a dynamic group: a rule that is
   * only `in_group('two-year-club')` contains no tenure node of its own.
   */
  it('test_a_threshold_inside_a_dynamic_group_still_schedules', async () => {
    const companyId = await insertCompany(db, 'sched-group');
    const employeeId = await insertEmployee(db, companyId, 'grouped@example.com');
    await insertEmploymentRecord(db, companyId, employeeId, '2024-01-01');
    const slotId = await insertSlot(db, companyId, 'vacation', 'exactly_one', 'policy');
    const targetId = await insertAssignmentTarget(db, companyId, 'policy', 'Club Policy');
    await db.query(
      `INSERT INTO groups (company_id, key, kind, criteria)
       VALUES ($1, 'two-year-club', 'dynamic', $2::jsonb)`,
      [companyId, JSON.stringify({ op: 'gte_tenure', years: 2 })],
    );

    const now = new Date('2025-01-01T00:00:00Z');
    const queue = memoryQueue();
    await createRule(
      db,
      companyId,
      { name: 'Club members', slotId, targetId, criteria: { op: 'in_group', group: 'two-year-club' } },
      now,
      new FixedClock(now),
      queue,
    );

    const row = await scheduleRow(companyId, employeeId);
    expect(row?.next_at, 'expansion must run before looking for thresholds').not.toBeNull();
    expect(new Date(row!.next_at!).toISOString().slice(0, 10)).toBe('2026-01-01');
  });

  it('test_new_tenure_rule_schedules_an_employee_who_will_match_later', async () => {
    const companyId = await insertCompany(db, 'sched-future-1');
    const employeeId = await insertEmployee(db, companyId, 'oneyear@example.com');
    // Hired 2024-01-01. At the moment of the write they have one year of tenure.
    await insertEmploymentRecord(db, companyId, employeeId, '2024-01-01');
    const slotId = await insertSlot(db, companyId, 'vacation', 'exactly_one', 'policy');
    const targetId = await insertAssignmentTarget(db, companyId, 'policy', 'Senior Vacation');

    const now = new Date('2025-01-01T00:00:00Z');
    const clock = new FixedClock(now);
    const queue = memoryQueue();

    await createRule(
      db,
      companyId,
      { name: 'Two years', slotId, targetId, criteria: { op: 'gte_tenure', years: 2 } },
      now,
      clock,
      queue,
    );

    const row = await scheduleRow(companyId, employeeId);
    expect(row, 'the employee needs a scheduled anniversary').not.toBeNull();
    expect(row?.next_at, 'and it must be their two-year anniversary').not.toBeNull();
    expect(new Date(row!.next_at!).toISOString().slice(0, 10)).toBe('2026-01-01');
  });

  it('test_the_scheduled_anniversary_actually_produces_the_assignment', async () => {
    const companyId = await insertCompany(db, 'sched-future-2');
    const employeeId = await insertEmployee(db, companyId, 'anniv@example.com');
    await insertEmploymentRecord(db, companyId, employeeId, '2024-01-01');
    const slotId = await insertSlot(db, companyId, 'vacation', 'exactly_one', 'policy');
    const targetId = await insertAssignmentTarget(db, companyId, 'policy', 'Senior Vacation');

    const now = new Date('2025-01-01T00:00:00Z');
    const queue = memoryQueue();
    await createRule(
      db,
      companyId,
      { name: 'Two years', slotId, targetId, criteria: { op: 'gte_tenure', years: 2 } },
      now,
      new FixedClock(now),
      queue,
    );

    expect(await assignedTargets(companyId, employeeId, '2025-06-01T00:00:00Z')).toEqual([]);

    // Time passes; the dispatcher fires whatever is due.
    const later = new Date('2026-02-01T00:00:00Z');
    const laterClock = new FixedClock(later);
    await dispatchDueMaterialDates(db, companyId, later, queue);
    await drainMemoryQueue(db, laterClock, queue);

    expect(await assignedTargets(companyId, employeeId, '2026-06-01T00:00:00Z')).toContain(
      'Senior Vacation',
    );
  });

  it('test_a_rule_that_becomes_effective_later_still_schedules_its_thresholds', async () => {
    const companyId = await insertCompany(db, 'sched-future-3');
    const employeeId = await insertEmployee(db, companyId, 'futurerule@example.com');
    await insertEmploymentRecord(db, companyId, employeeId, '2024-01-01');
    const slotId = await insertSlot(db, companyId, 'vacation', 'exactly_one', 'policy');
    const targetId = await insertAssignmentTarget(db, companyId, 'policy', 'Senior Vacation');

    const now = new Date('2025-01-01T00:00:00Z');
    const queue = memoryQueue();
    // Written today, effective in July — after which the two-year threshold applies.
    await createRule(
      db,
      companyId,
      { name: 'Two years, from July', slotId, targetId, criteria: { op: 'gte_tenure', years: 2 } },
      new Date('2025-07-01T00:00:00Z'),
      new FixedClock(now),
      queue,
    );

    const row = await scheduleRow(companyId, employeeId);
    expect(row, 'a rule in force later still carries thresholds').not.toBeNull();
    expect(row?.next_at).not.toBeNull();
  });
});

/**
 * Rescheduling must never lose work that was already due.
 *
 * The company-wide pass added for the case above recomputes from *now*, and the
 * upsert overwrote whatever was stored. So an unrelated rule write, landing while
 * the dispatcher was behind, moved a missed anniversary forward to the next one
 * and the employee silently never got the policy. A spurious reconcile is
 * harmless — it is level-triggered and writes nothing when nothing changed. A
 * dropped one is data loss.
 */
describe('rescheduling must not discard overdue work', () => {
  it('test_an_unrelated_rule_write_does_not_advance_a_missed_anniversary', async () => {
    const companyId = await insertCompany(db, 'overdue-1');
    const employeeId = await insertEmployee(db, companyId, 'overdue@example.com');
    await insertEmploymentRecord(db, companyId, employeeId, '2024-01-01', 'Sales');
    const slotId = await insertSlot(db, companyId, 'vacation', 'exactly_one', 'policy');
    const targetId = await insertAssignmentTarget(db, companyId, 'policy', 'Senior Vacation');
    const otherSlot = await insertSlot(db, companyId, 'training', 'many', 'policy');
    const otherTarget = await insertAssignmentTarget(db, companyId, 'policy', 'Eng Training');

    const written = new Date('2025-01-01T00:00:00Z');
    const queue = memoryQueue();
    await createRule(
      db,
      companyId,
      { name: 'Two years', slotId, targetId, criteria: { op: 'gte_tenure', years: 2 } },
      written,
      new FixedClock(written),
      queue,
    );
    const before = await scheduleRow(companyId, employeeId);
    expect(new Date(before!.next_at!).toISOString().slice(0, 10)).toBe('2026-01-01');

    // The dispatcher is behind. Meanwhile someone writes an unrelated rule that
    // cannot apply to this employee at all.
    const late = new Date('2026-02-01T00:00:00Z');
    await createRule(
      db,
      companyId,
      {
        name: 'Engineering three years',
        slotId: otherSlot,
        targetId: otherTarget,
        criteria: {
          op: 'and',
          children: [
            { op: 'eq', field: 'department', value: 'Engineering' },
            { op: 'gte_tenure', years: 3 },
          ],
        },
      },
      late,
      new FixedClock(late),
      queue,
    );

    const after = await scheduleRow(companyId, employeeId);
    expect(
      new Date(after!.next_at!).toISOString().slice(0, 10),
      'the missed anniversary must survive an unrelated write',
    ).toBe('2026-01-01');

    // And it must still fire, stamping the anniversary rather than the run time.
    const lateClock = new FixedClock(late);
    await dispatchDueMaterialDates(db, companyId, late, queue);
    await drainMemoryQueue(db, lateClock, queue);

    expect(await assignedTargets(companyId, employeeId, '2026-06-01T00:00:00Z')).toContain(
      'Senior Vacation',
    );
    const { rows } = await db.query<{ f: string }>(
      `SELECT lower(valid) AS f FROM resolved_assignments
        WHERE company_id = $1 AND employee_id = $2 AND upper_inf(system)`,
      [companyId, employeeId],
    );
    expect(new Date(rows[0].f).toISOString().slice(0, 10)).toBe('2026-01-01');
  });
});
