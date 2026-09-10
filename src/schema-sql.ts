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
 * Bring a database to the current schema and record what was applied.
 *
 * This replaces a chain of per-feature probes ("does assignment_rules have
 * target_type?") that had to grow by one branch per migration, and did not:
 * migration 007 shipped while both upgrade paths still stopped at 006, so freshly
 * created databases were protected and upgraded ones silently were not. A
 * migration is applied when `schema_migrations` does not name it. Adding a file
 * is now the whole of adding a migration.
 *
 * A database holding data but no `schema_migrations` predates this mechanism, and
 * there is no honest way to infer which migrations it has had -- inferring is the
 * per-feature probing this replaces. It is refused, with the recreate command.
 * The demo database is disposable and both READMEs already say so.
 */
export async function ensureSchema(
  db: Db,
  root: string = process.cwd(),
): Promise<{ applied: string[] }> {
  if (!(await tableExists(db, 'companies'))) {
    await db.exec(baseSchema(root));
  } else if (!(await tableExists(db, 'schema_migrations'))) {
    throw new Error(
      [
        'This database predates migration tracking, so which migrations it has is unknown.',
        'It is demo data; recreate it rather than guessing:',
        '  embedded PGlite:  rm -rf .pglite && npm run seed',
        '  real Postgres:    docker compose down -v && docker compose up -d postgres && npm run seed',
      ].join('\n'),
    );
  }

  const { rows } = await db.query<{ name: string }>(`SELECT name FROM schema_migrations`);
  const already = new Set(rows.map((r) => r.name));

  const applied: string[] = [];
  for (const m of migrationFiles(root)) {
    if (already.has(m.name)) continue;
    await db.exec(m.sql);
    await db.query(`INSERT INTO schema_migrations (name) VALUES ($1)`, [m.name]);
    applied.push(m.name);
  }
  return { applied };
}
