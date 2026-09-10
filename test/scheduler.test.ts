import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { createTestDb, insertCompany, insertEmployee, insertEmploymentRecord, insertSlot, insertAssignmentTarget, insertRule } from './helpers';
import { computeEmployeeMaterialDates, dispatchDueMaterialDates, recomputeNextMaterialDate, upsertMaterialDates } from '../src/scheduler';
import { memoryQueue } from '../src/queue';
import type { Db } from '../src/db';
import type { Queue } from '../src/types';

let db: PGlite;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

function sentQueue(queue: Queue) {
  return queue as unknown as { sent: { name: string; data: { effective_at: string } }[] };
}

describe('scheduler', () => {
  it('test_scheduler_computes_earliest_material_date', async () => {
    const companyId = await insertCompany(db, 'sched1');
    const employeeId = await insertEmployee(db, companyId, 'sched1@example.com');
    await insertEmploymentRecord(db, companyId, employeeId, '2024-01-01');
    const slotId = await insertSlot(db, companyId, 'vacation', 'exactly_one', 'policy');
    const targetId = await insertAssignmentTarget(db, companyId, 'policy', 'Senior');
    await insertRule(db, companyId, slotId, targetId, 'Two years', { op: 'gte_tenure', years: 2 });

    const asOf = new Date('2025-01-01T00:00:00Z');
    const dates = await computeEmployeeMaterialDates(db as unknown as Db, companyId, asOf);
    expect(dates.get(employeeId)?.toISOString().slice(0, 10)).toBe('2026-01-01');
  });

  it('test_scheduler_upsert_material_dates_roundtrip', async () => {
    const companyId = await insertCompany(db, 'sched2');
    const employeeId = await insertEmployee(db, companyId, 'sched2@example.com');
    await insertEmploymentRecord(db, companyId, employeeId, '2024-01-01');

    const map = new Map<string, Date | null>([[employeeId, new Date('2026-01-01T00:00:00Z')]]);
    await upsertMaterialDates(db as unknown as Db, companyId, map, new Date('2025-01-01T00:00:00Z'));
    const { rows } = await (db as unknown as Db).query<{ next_at: string }>(
      'SELECT next_at FROM employee_next_material_date WHERE company_id = $1 AND employee_id = $2',
      [companyId, employeeId],
    );
    expect(rows).toHaveLength(1);
    expect(new Date(String(rows[0].next_at)).toISOString().slice(0, 10)).toBe('2026-01-01');
  });

  it('test_scheduled_reconcile_stamps_boundary_not_dispatch_time', async () => {
    const companyId = await insertCompany(db, 'sched3');
    const employeeId = await insertEmployee(db, companyId, 'sched3@example.com');
    await insertEmploymentRecord(db, companyId, employeeId, '2024-01-01');
    const slotId = await insertSlot(db, companyId, 'vacation', 'exactly_one', 'policy');
    const targetId = await insertAssignmentTarget(db, companyId, 'policy', 'Senior Vacation');
    await insertRule(db, companyId, slotId, targetId, 'Two years', { op: 'gte_tenure', years: 2 });

    // Seed the schedule from an earlier system time so next_at is the anniversary.
    await recomputeNextMaterialDate(db as unknown as Db, companyId, employeeId, new Date('2025-06-01T00:00:00Z'));
    const queue: Queue = memoryQueue();

    // Now six hours past the boundary. The dispatcher must use the stored
    // next_at (2026-01-01T00:00:00Z) as effective_at, not the dispatch time.
    const dispatchTime = new Date('2026-01-01T06:00:00Z');
    const n = await dispatchDueMaterialDates(db as unknown as Db, companyId, dispatchTime, queue);
    expect(n).toBe(1);
    const sent = sentQueue(queue).sent;
    expect(sent.length).toBeGreaterThan(0);
    const job = sent.at(-1);
    expect(job?.data.effective_at).toBe('2026-01-01T00:00:00.000Z');

    // Re-running should find nothing more due.
    const q2: Queue = memoryQueue();
    const n2 = await dispatchDueMaterialDates(db as unknown as Db, companyId, dispatchTime, q2);
    expect(n2).toBe(0);
  });
});
