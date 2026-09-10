import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import type { Db } from './db';

/** The base schema. Creates `schema_migrations`, which everything below reads. */
export function baseSchema(root: string = process.cwd()): string {
  return readFileSync(join(root, 'db/schema.sql'), 'utf8');
}

/** Every migration, in filename order. */
export function migrationFiles(root: string = process.cwd()): { name: string; sql: string }[] {
  const dir = join(root, 'db/migrations');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') }));
}

/**
 * The base schema followed by every migration, in order. Used where a database
 * is being built from nothing and nothing needs recording -- `init.sh` and
 * one-shot fixtures.
 */
export function schemaStatements(root: string = process.cwd()): string[] {
  return [baseSchema(root), ...migrationFiles(root).map((m) => m.sql)];
}

async function tableExists(db: Db, name: string): Promise<boolean> {
  const { rows } = await db.query<{ t: string | null }>(`SELECT to_regclass($1) AS t`, [name]);
  return Boolean(rows[0]?.t);
}

/**
 * Arbitrary constant. Every process that migrates this database takes the same
 * advisory lock, so only one of them is ever inside the read-then-apply window.
 */
const MIGRATION_LOCK_KEY = 8274531;

const LEGACY_DATABASE_MESSAGE = [
  'This database predates migration tracking, so which migrations it has is unknown.',
  'It is demo data; recreate it rather than guessing:',
  '  embedded PGlite:  rm -rf .pglite && npm run seed',
  '  real Postgres:    docker compose down -v && docker compose up -d postgres && npm run seed',
].join('\n');

async function migrateWithin(tx: Db, root: string, locked: boolean): Promise<string[]> {
  // Transaction-scoped, so it releases on commit or rollback without a finally.
  // Taken before the state is read: two runners that both read "007 is pending"
  // would both apply it, and the second would fail on a duplicate constraint.
  if (locked) await tx.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_KEY]);

  if (!(await tableExists(tx, 'companies'))) {
    await tx.exec(baseSchema(root));
  } else if (!(await tableExists(tx, 'schema_migrations'))) {
    throw new Error(LEGACY_DATABASE_MESSAGE);
  }

  const { rows } = await tx.query<{ name: string }>(`SELECT name FROM schema_migrations`);
  const already = new Set(rows.map((r) => r.name));

  const applied: string[] = [];
  for (const m of migrationFiles(root)) {
    if (already.has(m.name)) continue;
    await tx.exec(m.sql);
    await tx.query(`INSERT INTO schema_migrations (name) VALUES ($1)`, [m.name]);
    applied.push(m.name);
  }
  return applied;
}

/**
 * Bring a database to the current schema and record what was applied.
 *
 * This replaces a chain of per-feature probes ("does assignment_rules have
 * target_type?") that had to grow by one branch per migration, and did not:
 * migration 007 shipped while both upgrade paths still stopped at 006, so freshly
 * created databases were protected and upgraded ones silently were not. A
 * migration is applied when `schema_migrations` does not name it. Adding a file
 * is now the whole of adding a migration.
 *
 * Two properties the first version of this lacked:
 *
 * - **Atomic.** The DDL and its ledger row commit together. Postgres has
 *   transactional DDL, so an interrupted run leaves the database on the last
 *   fully applied migration rather than in a state where the schema has moved
 *   but the ledger has not -- which the next startup would try to re-apply, and
 *   these migrations are not idempotent.
 * - **Serialised.** An advisory lock spans the read-then-apply window, so two
 *   processes starting together cannot both decide the same migration is
 *   pending.
 *
 * A database holding data but no `schema_migrations` predates this mechanism, and
 * there is no honest way to infer which migrations it has had -- inferring is the
 * per-feature probing this replaces. It is refused, with the recreate command.
 * The demo database is disposable and the README says so.
 */
export async function ensureSchema(
  db: Db,
  root: string = process.cwd(),
): Promise<{ applied: string[] }> {
  const withTx = db.withTransaction?.bind(db);
  if (!withTx) {
    // Single-connection fixtures (a raw PGlite handle in a test) have no
    // transaction wrapper and no concurrent writer to race with.
    return { applied: await migrateWithin(db, root, false) };
  }
  return { applied: await withTx((tx) => migrateWithin(tx, root, true)) };
}
