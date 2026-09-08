import { readFileSync } from 'fs';
import { join } from 'path';
import { getDb, drainMemoryQueue } from '../src/runtime';
import { SystemClock } from '../src/clock';
import { memoryQueue } from '../src/queue';
import { reconcileEmployee } from '../src/reconcile';
import type { Db } from '../src/db';

const schemaSql = readFileSync(join(process.cwd(), 'db/schema.sql'), 'utf8');
const effectMigrationSql = readFileSync(join(process.cwd(), 'db/migrations/002_rule_effect.sql'), 'utf8');
const versionMigrationSql = readFileSync(join(process.cwd(), 'db/migrations/003_rule_version_key.sql'), 'utf8');
const tiebreakMigrationSql = readFileSync(join(process.cwd(), 'db/migrations/004_stable_tiebreak.sql'), 'utf8');
const employmentTypeMigrationSql = readFileSync(join(process.cwd(), 'db/migrations/005_employment_type_check.sql'), 'utf8');

async function ensureSchema(db: Awaited<ReturnType<typeof getDb>>) {
  const { rows } = await db.query<{ t: string | null }>(`SELECT to_regclass('companies') AS t`);
  if (!rows[0].t) {
    await db.exec(schemaSql);
    await db.exec(effectMigrationSql);
    await db.exec(versionMigrationSql);
    await db.exec(tiebreakMigrationSql);
    await db.exec(employmentTypeMigrationSql);
  }
}

async function main() {
  const db = await getDb();
  await ensureSchema(db);
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM companies WHERE name = 'Acme Corp'`,
  );
  if (rows.length > 0) {
    // This script creates a demo company; it is deliberately not an upgrade path.
    // Several statements in seed.sql carry no conflict guard because they sit behind
    // bi-temporal exclusion constraints (employment_records, group_memberships,
    // assignment_rules), so replaying it over an existing company would fail rather
    // than converge. The demo database is disposable, so refreshing it is a delete
    // rather than a migration — say so instead of exiting silently.
    console.log(
      [
        "Acme Corp already exists — seed skipped.",
        "",
        "This seed creates a demo company; it does not upgrade one. If the seed data",
        "has changed (new slots, targets or rules), recreate the database.",
        "",
        "Stop the dev server and any worker first — deleting the data directory",
        "underneath a live process corrupts it. Then:",
        "",
        "  embedded PGlite:  rm -rf .pglite && npm run seed",
        "  real Postgres:    docker compose down -v && docker compose up -d postgres && npm run seed",
        "",
        "This destroys the database, including anything you created in the UI.",
      ].join('\n'),
    );
    await (db as { close?: () => Promise<void> }).close?.();
    process.exit(0);
  }
  await db.exec(readFileSync(join(process.cwd(), 'db/seed.sql'), 'utf8'));

  // Seed alone leaves zero published assignments — a fresh dev server would
  // show empty employee pages until the first write. Reconcile everyone once.
  const clock = new SystemClock();
  const queue = memoryQueue();
  const { rows: employees } = await db.query<{ id: string; company_id: string }>(
    'SELECT id, company_id FROM employees',
  );
  for (const e of employees) {
    await reconcileEmployee(db as unknown as Db, e.company_id, e.id, clock.now(), clock, queue);
  }
  await drainMemoryQueue(db as unknown as Db, clock, queue);
  console.log(`seeded and reconciled ${employees.length} employees`);

  await (db as { close?: () => Promise<void> }).close?.();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
