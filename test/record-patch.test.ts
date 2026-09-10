import { describe, it, expect, beforeEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { createTestDb, insertCompany, insertEmployee, insertEmploymentRecord } from './helpers';
import { updateEmploymentRecord } from '../src/api/writes';
import { buildEmployeeState } from '../src/state';
import { memoryQueue } from '../src/queue';
import { FixedClock } from '../src/clock';
import type { Db } from '../src/db';

let pg: PGlite;
let db: Db;

beforeEach(async () => {
  pg = await createTestDb();
  db = pg as unknown as Db;
});

const on = (iso: string) => new Date(`${iso}T00:00:00Z`);

/**
 * A field-level PATCH built one snapshot from the record in force at its
 * effective date and asserted it over all future time, so correcting a location
 * in April silently deleted a department transfer already scheduled for June.
 * The caller never mentioned department; saying nothing about a field must not
 * mean reverting it.
 */
async function fixture() {
  const companyId = await insertCompany(db, 'patch');
  const employeeId = await insertEmployee(db, companyId, 'patch@example.com');
  await insertEmploymentRecord(db, companyId, employeeId, '2024-01-01', 'Engineering');

  // February: schedule a transfer to Sales, effective June.
  const feb = on('2025-02-01');
  await updateEmploymentRecord(
    db, companyId, employeeId, { department: 'Sales' }, on('2025-06-01'), new FixedClock(feb), memoryQueue(),
  );
  return { companyId, employeeId };
}

async function stateAt(companyId: string, employeeId: string, validAt: string, systemAt: string) {
  return buildEmployeeState(db, companyId, employeeId, on(validAt), on(systemAt));
}

describe('a field-level record correction', () => {
  it('test_a_location_correction_preserves_a_scheduled_department_transfer', async () => {
    const { companyId, employeeId } = await fixture();

    // March: correct the location, effective April. Department is not mentioned.
    await updateEmploymentRecord(
      db, companyId, employeeId, { location_country: 'CA' }, on('2025-04-01'),
      new FixedClock(on('2025-03-01')), memoryQueue(),
    );

    const july = await stateAt(companyId, employeeId, '2025-07-01', '2025-03-02');
    expect(july.department, 'the June transfer must survive an unrelated correction').toBe('Sales');
  });

  it('test_the_corrected_field_applies_across_every_later_segment', async () => {
    const { companyId, employeeId } = await fixture();
    await updateEmploymentRecord(
      db, companyId, employeeId, { location_country: 'CA' }, on('2025-04-01'),
      new FixedClock(on('2025-03-01')), memoryQueue(),
    );

    // Before the correction takes effect: untouched.
    const feb = await stateAt(companyId, employeeId, '2025-02-15', '2025-03-02');
    expect(feb.location_country).toBe('US');
    expect(feb.department).toBe('Engineering');

    // Between the correction and the transfer.
    const may = await stateAt(companyId, employeeId, '2025-05-01', '2025-03-02');
    expect(may.location_country).toBe('CA');
    expect(may.department).toBe('Engineering');

    // After the transfer: both the correction and the transfer hold.
    const july = await stateAt(companyId, employeeId, '2025-07-01', '2025-03-02');
    expect(july.location_country).toBe('CA');
    expect(july.department).toBe('Sales');
  });

  it('test_the_earlier_belief_still_reproduces_the_original_records', async () => {
    const { companyId, employeeId } = await fixture();
    await updateEmploymentRecord(
      db, companyId, employeeId, { location_country: 'CA' }, on('2025-04-01'),
      new FixedClock(on('2025-03-01')), memoryQueue(),
    );

    // As believed in mid-February, before the correction was recorded.
    const asBelieved = await stateAt(companyId, employeeId, '2025-07-01', '2025-02-15');
    expect(asBelieved.location_country, 'the correction was not known yet').toBe('US');
    expect(asBelieved.department, 'but the transfer was').toBe('Sales');
  });
});

/**
 * A correction has to land inside an employment period. Asking for one outside
 * every period used to fall back to the earliest known segment, apply the fields
 * from there, commit, and only then fail when the queued reconcile could not
 * build a state at the requested instant. Partial success reported as failure is
 * the worst of both: the caller sees an error and the data has moved.
 */
describe('a correction outside any employment period', () => {
  async function snapshot(companyId: string, employeeId: string, readAt = '2025-01-01') {
    const recs = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM employment_records WHERE company_id = $1 AND employee_id = $2`,
      [companyId, employeeId],
    );
    const audit = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_events WHERE company_id = $1`,
      [companyId],
    );
    const state = await buildEmployeeState(db, companyId, employeeId, on(readAt), on('2030-01-01'));
    return { records: recs.rows[0].n, audit: audit.rows[0].n, country: state.location_country };
  }

  it('test_a_date_before_the_first_record_is_rejected_and_changes_nothing', async () => {
    const companyId = await insertCompany(db, 'gap-before');
    const employeeId = await insertEmployee(db, companyId, 'gap@example.com');
    await insertEmploymentRecord(db, companyId, employeeId, '2024-01-01', 'Engineering');

    const before = await snapshot(companyId, employeeId);
    const queue = memoryQueue();

    await expect(
      updateEmploymentRecord(
        db, companyId, employeeId, { location_country: 'GB' }, on('2023-01-01'),
        new FixedClock(on('2025-03-01')), queue,
      ),
    ).rejects.toThrow(/no employment record/i);

    const after = await snapshot(companyId, employeeId);
    expect(after.country, 'the correction must not have been applied').toBe(before.country);
    expect(after.records, 'no rows written').toBe(before.records);
    expect(after.audit, 'no audit event emitted').toBe(before.audit);
    expect(queue.sent, 'no work queued').toHaveLength(0);
  });

  it('test_a_date_inside_an_employment_gap_is_rejected_and_changes_nothing', async () => {
    const companyId = await insertCompany(db, 'gap-inside');
    const employeeId = await insertEmployee(db, companyId, 'gap2@example.com');
    // Employed 2022, left, rehired 2026: nothing covers 2024.
    for (const [from, to] of [['2022-01-01', '2023-01-01'], ['2026-01-01', null]] as const) {
      await db.query(
        `INSERT INTO employment_records
           (company_id, employee_id, department, location_state, location_country,
            employment_type, pay_type, tenure_start_date, valid, system)
         VALUES ($1, $2, 'Engineering', 'CA', 'US', 'w2_employee', 'salary', '2022-01-01',
                 tstzrange($3::timestamptz, $4::timestamptz),
                 tstzrange('2022-01-01T00:00:00Z'::timestamptz, NULL))`,
        [companyId, employeeId, `${from}T00:00:00Z`, to ? `${to}T00:00:00Z` : null],
      );
    }

    const before = await snapshot(companyId, employeeId, '2026-06-01');
    const queue = memoryQueue();

    await expect(
      updateEmploymentRecord(
        db, companyId, employeeId, { location_country: 'GB' }, on('2024-06-01'),
        new FixedClock(on('2026-03-01')), queue,
      ),
    ).rejects.toThrow(/no employment record/i);

    const after = await snapshot(companyId, employeeId, '2026-06-01');
    expect(after.country, 'the correction must not have been applied').toBe(before.country);
    expect(after.records).toBe(before.records);
    expect(after.audit).toBe(before.audit);
    expect(queue.sent).toHaveLength(0);
  });
});
