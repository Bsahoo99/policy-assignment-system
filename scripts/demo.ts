import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { readFileSync } from 'fs';
import { join } from 'path';
import { FixedClock } from '../src/clock';
import { memoryQueue } from '../src/queue';
import { reconcileEmployee } from '../src/reconcile';
import { simulateEmployee } from '../src/simulate';
import { buildEmployeeState } from '../src/state';
import { handleJob } from '../src/worker';
import { updateEmploymentRecord } from '../src/api/writes';
import type { Db } from '../src/db';
import type { Clock } from '../src/clock';
import { randomUUID } from 'crypto';
import { schemaStatements } from '../src/schema-sql';

const seedSql = readFileSync(join(process.cwd(), 'db/seed.sql'), 'utf8');

const COMPANY_ID = '11111111-1111-1111-1111-111111111111';
const ALICE = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const BOB = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const JANE = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const PAYROLL_SLOT = 'd5555555-5555-5555-5555-555555555555';
const CANADIAN_TARGET = 'ea111111-1111-1111-1111-111111111111';

async function drain(queue: ReturnType<typeof memoryQueue>, db: Db, clock: Clock) {
  while (queue.sent.length > 0) {
    const job = queue.sent.shift()!;
    await handleJob(db, clock, queue, { name: job.name, data: job.data });
  }
}

async function targetName(db: Db, companyId: string) {
  const { rows } = await db.query(
    'SELECT id, display_name FROM assignment_targets WHERE company_id = $1',
    [companyId],
  );
  return new Map((rows as { id: string; display_name: string }[]).map((r) => [r.id, r.display_name]));
}

async function main() {
  const db = new PGlite({ extensions: { btree_gist } });
  for (const sql of schemaStatements()) await db.exec(sql);
  await db.exec(seedSql);

  // Add a state-dependent payroll target + rule for the Jane journey.
  const canadianRuleId = randomUUID();
  await db.query(
    `INSERT INTO assignment_targets (id, company_id, target_type, display_name) VALUES ($1, $2, 'pay_schedule', 'Canadian Payroll')`,
    [CANADIAN_TARGET, COMPANY_ID],
  );
  await db.query(
    `INSERT INTO assignment_rules
       (company_id, rule_id, rule_created_at, slot_id, target_id, name, source, effect, priority, criteria, valid, system)
     VALUES ($1, $2, $3, $4, $5, 'Canadian Payroll', 'rule', 'grant', 10, '{"op":"eq","field":"location_country","value":"CA"}'::jsonb,
             tstzrange('2024-01-01T00:00:00Z', NULL), tstzrange('2024-01-01T00:00:00Z', NULL))`,
    [COMPANY_ID, canadianRuleId, '2024-01-01T00:00:00Z', PAYROLL_SLOT, CANADIAN_TARGET],
  );

  const clock = new FixedClock(new Date('2026-01-01T00:00:00Z'));
  const queue = memoryQueue();
  const names = await targetName(db as unknown as Db, COMPANY_ID);

  console.log('=== 1. Initial reconcile at', clock.now().toISOString(), '===');
  for (const employeeId of [ALICE, BOB, JANE]) {
    const result = await reconcileEmployee(db as unknown as Db, COMPANY_ID, employeeId, clock.now(), clock, queue);
    console.log(`  ${employeeId}: changed=${result.changed}, assignments=${result.assignments.length}`);
  }
  await drain(queue, db as unknown as Db, clock);

  const show = async (who: string, when: Date, systemAt: Date) => {
    const { rows } = await (db as unknown as Db).query<{ target: string }>(
      `SELECT at.display_name AS target
       FROM resolved_assignments ra
       JOIN assignment_slots s ON s.id = ra.slot_id
       JOIN assignment_targets at ON at.id = ra.target_id
       WHERE ra.company_id = $1 AND ra.employee_id = $2
         AND ra.system @> $3::timestamptz AND ra.valid @> $4::timestamptz`,
      [COMPANY_ID, who, systemAt.toISOString(), when.toISOString()],
    );
    return rows.map((r) => r.target).join(', ');
  };

  console.log('\n=== 2. Jane payroll at 2026-08-10, system 2026-01-01 ===');
  console.log('   ', await show(JANE, new Date('2026-08-10T00:00:00Z'), clock.now()));

  console.log('\n=== 3. Jane relocates to Canada on 2026-08-15 (system time 2026-08-15) ===');
  clock.advanceTo(new Date('2026-08-15T00:00:00Z'));
  await updateEmploymentRecord(
    db as unknown as Db,
    COMPANY_ID,
    JANE,
    { location_country: 'CA' },
    new Date('2026-08-15T00:00:00Z'),
    clock,
    queue,
  );
  await drain(queue, db as unknown as Db, clock);
  console.log('   Jane payroll at 2026-08-20:', await show(JANE, new Date('2026-08-20T00:00:00Z'), clock.now()));

  console.log('\n=== 4. Retroactive correction: Jane actually moved on 2026-08-01 (system time 2026-09-04) ===');
  clock.advanceTo(new Date('2026-09-04T00:00:00Z'));
  await updateEmploymentRecord(
    db as unknown as Db,
    COMPANY_ID,
    JANE,
    { location_country: 'CA' },
    new Date('2026-08-01T00:00:00Z'),
    clock,
    queue,
  );
  await drain(queue, db as unknown as Db, clock);

  console.log('\n=== 5. Time-travel: same valid date, two system beliefs ===');
  const validAt = new Date('2026-08-10T00:00:00Z');
  console.log('  system 2026-08-20 (before correction):', await show(JANE, validAt, new Date('2026-08-20T00:00:00Z')));
  console.log('  system 2026-09-05 ( after correction):', await show(JANE, validAt, new Date('2026-09-05T00:00:00Z')));

  console.log('\n=== 6. Simulate Bob at 2025-01-01 (before 2-year tenure) ===');
  const sim = await simulateEmployee(
    db as unknown as Db,
    COMPANY_ID,
    BOB,
    new Date('2025-01-01T00:00:00Z'),
    clock.now(),
  );
  console.log('  added:', sim.added.map((i) => names.get(i.targetId) ?? i.targetId).join(', ') || '—');
  console.log('  removed:', sim.removed.map((i) => names.get(i.targetId) ?? i.targetId).join(', ') || '—');

  console.log('\n=== 7. Alice direct reports ===');
  const aliceState = await buildEmployeeState(db as unknown as Db, COMPANY_ID, ALICE, clock.now(), clock.now());
  console.log('  Alice direct_report_count:', aliceState.direct_report_count);

  await db.close();
  console.log('\nDemo complete.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
