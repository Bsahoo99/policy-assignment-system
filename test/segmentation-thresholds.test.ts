import { describe, it, expect, beforeEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import {
  createTestDb,
  insertCompany,
  insertEmployee,
  insertEmploymentRecord,
  insertSlot,
  insertAssignmentTarget,
  insertRule,
  insertGroup,
} from './helpers';
import { reconcileEmployee } from '../src/reconcile';
import { memoryQueue } from '../src/queue';
import { drainMemoryQueue } from '../src/runtime';
import { FixedClock } from '../src/clock';
import type { Db } from '../src/db';
import type { Predicate } from '../src/predicate';

let pg: PGlite;
let db: Db;

beforeEach(async () => {
  pg = await createTestDb();
  db = pg as unknown as Db;
});

const at = (iso: string) => new Date(iso.includes('T') ? iso : `${iso}T00:00:00Z`);

/** Eligible from one year of tenure until two. Bounded on both sides. */
const betweenOneAndTwo: Predicate = {
  op: 'and',
  children: [
    { op: 'gte_tenure', years: 1 },
    { op: 'not', child: { op: 'gte_tenure', years: 2 } },
  ],
};

async function holds(companyId: string, employeeId: string, target: string, instant: string) {
  const { rows } = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM resolved_assignments ra
       JOIN assignment_targets t ON t.id = ra.target_id
      WHERE ra.company_id = $1 AND ra.employee_id = $2 AND t.display_name = $3
        AND ra.valid @> $4::timestamptz AND upper_inf(ra.system)`,
    [companyId, employeeId, target, at(instant).toISOString()],
  );
  return rows[0].n > 0;
}

async function fixture(name: string) {
  const companyId = await insertCompany(db, name);
  const employeeId = await insertEmployee(db, companyId, `${name}@example.com`);
  await insertEmploymentRecord(db, companyId, employeeId, '2024-01-01');
  const slotId = await insertSlot(db, companyId, 'vacation', 'exactly_one', 'policy');
  const targetId = await insertAssignmentTarget(db, companyId, 'policy', 'Mid-Tenure Policy');
  await insertRule(db, companyId, slotId, targetId, 'One to two years', betweenOneAndTwo);
  return { companyId, employeeId, slotId, targetId };
}

/**
 * Boundary collection asked each rule for its *next* threshold after the job's
 * instant, so a predicate bounded on both sides contributed only its opening
 * one. The window opened correctly and never closed: the policy was published
 * open-ended past the second anniversary, and by the time anyone looked,
 * `next_at` was null and nothing would revisit it.
 */
describe('a predicate bounded on both sides', () => {
  async function reconcileFrom(companyId: string, employeeId: string, from: string, processedAt: string) {
    const clock = new FixedClock(at(processedAt));
    const queue = memoryQueue();
    await reconcileEmployee(db, companyId, employeeId, at(from), clock, queue);
    await drainMemoryQueue(db, clock, queue);
  }

  it('test_the_window_opens_and_closes_at_its_two_thresholds', async () => {
    const { companyId, employeeId } = await fixture('seg-window');
    await reconcileFrom(companyId, employeeId, '2024-06-01', '2024-06-01');

    expect(await holds(companyId, employeeId, 'Mid-Tenure Policy', '2024-12-31T23:59:59Z'),
      'not yet eligible the instant before the first anniversary').toBe(false);
    expect(await holds(companyId, employeeId, 'Mid-Tenure Policy', '2025-01-01T00:00:00Z'),
      'eligible exactly at the first anniversary').toBe(true);
    expect(await holds(companyId, employeeId, 'Mid-Tenure Policy', '2025-12-31T23:59:59Z'),
      'still eligible the instant before the second').toBe(true);
    expect(await holds(companyId, employeeId, 'Mid-Tenure Policy', '2026-01-01T00:00:00Z'),
      'eligibility ends exactly at the second anniversary').toBe(false);
  });

  it('test_the_same_timeline_when_processed_after_both_anniversaries', async () => {
    const { companyId, employeeId } = await fixture('seg-late');
    await reconcileFrom(companyId, employeeId, '2024-06-01', '2027-01-01');

    expect(await holds(companyId, employeeId, 'Mid-Tenure Policy', '2024-12-31T23:59:59Z')).toBe(false);
    expect(await holds(companyId, employeeId, 'Mid-Tenure Policy', '2025-06-01T00:00:00Z')).toBe(true);
    expect(await holds(companyId, employeeId, 'Mid-Tenure Policy', '2026-01-01T00:00:00Z')).toBe(false);
    expect(await holds(companyId, employeeId, 'Mid-Tenure Policy', '2027-06-01T00:00:00Z')).toBe(false);
  });

  it('test_replaying_from_the_original_date_produces_the_same_timeline', async () => {
    const { companyId, employeeId } = await fixture('seg-replay');
    await reconcileFrom(companyId, employeeId, '2024-06-01', '2024-06-01');
    await reconcileFrom(companyId, employeeId, '2024-06-01', '2027-01-01');

    expect(await holds(companyId, employeeId, 'Mid-Tenure Policy', '2024-12-31T23:59:59Z')).toBe(false);
    expect(await holds(companyId, employeeId, 'Mid-Tenure Policy', '2025-06-01T00:00:00Z')).toBe(true);
    expect(await holds(companyId, employeeId, 'Mid-Tenure Policy', '2026-01-01T00:00:00Z')).toBe(false);
  });

  /**
   * The regression guard on everything already built: collecting more tenure
   * boundaries must not displace the ones that come from facts, memberships,
   * rules or published ranges.
   */
  it('test_other_boundary_sources_still_cut_the_timeline', async () => {
    const { companyId, employeeId, slotId } = await fixture('seg-others');
    const appTarget = await insertAssignmentTarget(db, companyId, 'policy', 'HQ Perk');
    const groupId = await insertGroup(db, companyId, 'hq', 'static');
    await db.query(
      `INSERT INTO group_memberships (company_id, group_id, employee_id, valid, system)
       VALUES ($1, $2, $3, tstzrange('2024-01-01T00:00:00Z'::timestamptz, '2025-07-01T00:00:00Z'::timestamptz),
               tstzrange('2024-01-01T00:00:00Z'::timestamptz, NULL))`,
      [companyId, groupId, employeeId],
    );
    const perkSlot = await insertSlot(db, companyId, 'perk', 'at_most_one', 'policy');
    await insertRule(db, companyId, perkSlot, appTarget, 'HQ perk', { op: 'in_group', group: 'hq' });
    void slotId;

    await reconcileFrom(companyId, employeeId, '2024-06-01', '2024-06-01');

    // The membership boundary still ends the perk.
    expect(await holds(companyId, employeeId, 'HQ Perk', '2025-06-30T00:00:00Z')).toBe(true);
    expect(await holds(companyId, employeeId, 'HQ Perk', '2025-07-01T00:00:00Z')).toBe(false);
    // And the tenure window is unaffected by it.
    expect(await holds(companyId, employeeId, 'Mid-Tenure Policy', '2025-06-01T00:00:00Z')).toBe(true);
    expect(await holds(companyId, employeeId, 'Mid-Tenure Policy', '2026-01-01T00:00:00Z')).toBe(false);
  });

  /**
   * Collecting every threshold can now push a plan past MAX_SEGMENTS_PER_RUN.
   * A truncated plan closes at its last boundary and returns `continueAt`, which
   * the worker enqueues; the resulting timeline must be continuous across that
   * seam rather than stopping at it.
   */
  it('test_a_plan_past_the_segment_cap_continues_without_gaps', async () => {
    const companyId = await insertCompany(db, 'seg-cap');
    const employeeId = await insertEmployee(db, companyId, 'cap@example.com');
    await insertEmploymentRecord(db, companyId, employeeId, '2024-01-01');
    const slotId = await insertSlot(db, companyId, 'vacation', 'exactly_one', 'policy');
    const targetId = await insertAssignmentTarget(db, companyId, 'policy', 'Long Service');

    // Sixty thresholds, one per year. The predicate is true from year one
    // onwards, so the assignment should be continuous despite the boundaries.
    const many: Predicate = {
      op: 'or',
      children: Array.from({ length: 60 }, (_, i) => ({ op: 'gte_tenure', years: i + 1 }) as Predicate),
    };
    await insertRule(db, companyId, slotId, targetId, 'Long service', many);

    const clock = new FixedClock(at('2024-06-01'));
    const queue = memoryQueue();
    await reconcileEmployee(db, companyId, employeeId, at('2024-06-01'), clock, queue);
    await drainMemoryQueue(db, clock, queue);

    // Continuous from the first anniversary across the truncation seam.
    for (const instant of ['2025-01-01', '2030-01-01', '2050-01-01', '2070-01-01']) {
      expect(
        await holds(companyId, employeeId, 'Long Service', instant),
        `assignment must cover ${instant}`,
      ).toBe(true);
    }
    expect(await holds(companyId, employeeId, 'Long Service', '2024-12-31T23:59:59Z')).toBe(false);

    // No gaps: adjacent published ranges must meet exactly.
    const { rows } = await db.query<{ f: string; t: string | null }>(
      `SELECT lower(valid) AS f, upper(valid) AS t FROM resolved_assignments
        WHERE company_id = $1 AND employee_id = $2 AND upper_inf(system)
        ORDER BY lower(valid)`,
      [companyId, employeeId],
    );
    for (let i = 1; i < rows.length; i += 1) {
      expect(rows[i - 1].t, 'a closed range must meet the next one').not.toBeNull();
      expect(new Date(rows[i - 1].t!).getTime()).toBe(new Date(rows[i].f).getTime());
    }
  });
});
