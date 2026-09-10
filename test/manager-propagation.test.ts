import { describe, it, expect, beforeEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import {
  createTestDb,
  insertCompany,
  insertEmployee,
  insertEmploymentRecord,
  insertSlot,
  insertAssignmentTarget,
} from './helpers';
import { createRule, createManualOverride } from '../src/api/writes';
import { reconcileEmployee } from '../src/reconcile';
import { memoryQueue } from '../src/queue';
import { drainMemoryQueue } from '../src/runtime';
import { FixedClock } from '../src/clock';
import type { Db } from '../src/db';

let pg: PGlite;
let db: Db;

beforeEach(async () => {
  pg = await createTestDb();
  db = pg as unknown as Db;
});

const on = (iso: string) => new Date(`${iso}T00:00:00Z`);

/** Does this employee hold the given target at this instant? */
async function holds(companyId: string, employeeId: string, target: string, at: string) {
  const instant = at.includes('T') ? at : `${at}T00:00:00Z`;
  const { rows } = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM resolved_assignments ra
       JOIN assignment_targets t ON t.id = ra.target_id
      WHERE ra.company_id = $1 AND ra.employee_id = $2 AND t.display_name = $3
        AND ra.valid @> $4::timestamptz AND upper_inf(ra.system)`,
    [companyId, employeeId, target, instant],
  );
  return rows[0].n > 0;
}

/**
 * Alice manages Carol. In June, Carol transfers to Bob. Manager-only training
 * must follow the reporting line: Alice keeps it up to June and loses it after,
 * Bob gains it in June and not before.
 */
async function scenario(processedAt: Date) {
  const companyId = await insertCompany(db, `mgr-${processedAt.getTime()}`);
  const alice = await insertEmployee(db, companyId, 'alice@example.com');
  const bob = await insertEmployee(db, companyId, 'bob@example.com');
  const carol = await insertEmployee(db, companyId, 'carol@example.com');
  for (const e of [alice, bob, carol]) {
    await insertEmploymentRecord(db, companyId, e, '2020-01-01');
  }

  const managerSlot = await insertSlot(db, companyId, 'manager', 'exactly_one', 'employee');
  const trainingSlot = await insertSlot(db, companyId, 'training', 'many', 'policy');
  await db.query(
    `INSERT INTO slot_dependencies (company_id, slot_id, depends_on_slot) VALUES ($1, $2, $3)`,
    [companyId, trainingSlot, managerSlot],
  );

  const aliceTarget = await insertAssignmentTarget(db, companyId, 'employee', 'Alice');
  const bobTarget = await insertAssignmentTarget(db, companyId, 'employee', 'Bob');
  for (const [t, e] of [[aliceTarget, alice], [bobTarget, bob]] as const) {
    await db.query(
      `INSERT INTO employee_targets (target_id, target_type, employee_id) VALUES ($1, 'employee', $2)`,
      [t, e],
    );
  }
  const training = await insertAssignmentTarget(db, companyId, 'policy', 'Manager Training');

  const start = on('2025-01-01');
  const queue = memoryQueue();
  const startClock = new FixedClock(start);

  await createRule(
    db,
    companyId,
    { name: 'Managers train', slotId: trainingSlot, targetId: training, criteria: { op: 'is_manager' } },
    start,
    startClock,
    queue,
  );
  const reportsTo = await createManualOverride(
    db,
    companyId,
    carol,
    { name: 'Carol reports to Alice', slotId: managerSlot, targetId: aliceTarget },
    start,
    startClock,
    queue,
  );
  for (const e of [alice, bob, carol]) {
    await reconcileEmployee(db, companyId, e, start, startClock, queue);
  }
  await drainMemoryQueue(db, startClock, queue);

  // Record the transfer directly as two versions of the same rule, so the only
  // thing that can propagate it to Alice and Bob is reconciling Carol. Going
  // through updateRule would hide the defect: its candidate set already contains
  // both managers and enqueues them at the transfer date.
  const clock = new FixedClock(processedAt);
  await db.query(
    `UPDATE assignment_rules
        SET valid = tstzrange(lower(valid), '2025-06-01T00:00:00Z'::timestamptz)
      WHERE company_id = $1 AND rule_id = $2 AND upper_inf(system)`,
    [companyId, reportsTo],
  );
  await db.query(
    `INSERT INTO assignment_rules
       (company_id, rule_id, rule_created_at, slot_id, target_id, name, source, effect, priority,
        criteria, subject_employee_id, valid, system)
     VALUES ($1, $2, '2025-01-01T00:00:00Z', $3, $4, 'Carol reports to Bob', 'manual', 'grant', 100,
             '{"op":"always"}'::jsonb, $5,
             tstzrange('2025-06-01T00:00:00Z'::timestamptz, NULL),
             tstzrange('2025-01-01T00:00:00Z'::timestamptz, NULL))`,
    [companyId, reportsTo, managerSlot, bobTarget, carol],
  );

  // A job for Carol effective in January -- before the boundary it must discover.
  const cascadeQueue = memoryQueue();
  await reconcileEmployee(db, companyId, carol, on('2025-01-01'), clock, cascadeQueue);
  await drainMemoryQueue(db, clock, cascadeQueue);

  return { companyId, alice, bob, carol, queue: cascadeQueue, clock };
}

describe('manager propagation across a reporting-line change', () => {
  it('test_manager_training_follows_the_reporting_line_at_the_boundary', async () => {
    const { companyId, alice, bob } = await scenario(on('2025-02-01'));

    // The instant before the transfer, and the transfer instant itself. A month
    // either side would pass even if the boundary landed in the wrong place.
    const before = '2025-05-31T23:59:59Z';
    const at = '2025-06-01T00:00:00Z';

    expect(await holds(companyId, alice, 'Manager Training', before),
      'Alice still manages Carol up to the transfer').toBe(true);
    expect(await holds(companyId, bob, 'Manager Training', before),
      'Bob manages nobody up to the transfer').toBe(false);

    expect(await holds(companyId, alice, 'Manager Training', at),
      'Alice loses the training exactly at the transfer').toBe(false);
    expect(await holds(companyId, bob, 'Manager Training', at),
      'Bob gains the training exactly at the transfer').toBe(true);
  });

  it('test_the_same_holds_when_the_transfer_is_processed_late', async () => {
    // Written and processed in August, effective back in June.
    const { companyId, alice, bob } = await scenario(on('2025-08-01'));

    expect(await holds(companyId, alice, 'Manager Training', '2025-05-31T23:59:59Z')).toBe(true);
    expect(await holds(companyId, bob, 'Manager Training', '2025-05-31T23:59:59Z')).toBe(false);
    expect(await holds(companyId, alice, 'Manager Training', '2025-06-01T00:00:00Z')).toBe(false);
    expect(await holds(companyId, bob, 'Manager Training', '2025-06-01T00:00:00Z')).toBe(true);
  });

  it('test_replaying_the_cascade_produces_the_same_result', async () => {
    const { companyId, alice, bob, carol, clock } = await scenario(on('2025-02-01'));

    // Replay from the original January instant, not from the boundary: a job
    // replayed at the boundary would find it without having to discover it.
    const queue = memoryQueue();
    for (const e of [carol, alice, bob]) {
      await reconcileEmployee(db, companyId, e, on('2025-01-01'), clock, queue);
    }
    await drainMemoryQueue(db, clock, queue);

    expect(await holds(companyId, alice, 'Manager Training', '2025-05-31T23:59:59Z')).toBe(true);
    expect(await holds(companyId, bob, 'Manager Training', '2025-05-31T23:59:59Z')).toBe(false);
    expect(await holds(companyId, alice, 'Manager Training', '2025-06-01T00:00:00Z')).toBe(false);
    expect(await holds(companyId, bob, 'Manager Training', '2025-06-01T00:00:00Z')).toBe(true);
  });
});
