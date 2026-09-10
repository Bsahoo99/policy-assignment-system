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
