import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

/**
 * The base schema followed by every migration, in filename order.
 *
 * Seven call sites used to hardcode this list, and they had already drifted: the
 * test helpers stopped at 004, and the Docker entrypoint stopped at 005 while 006
 * existed -- so the documented Postgres path built a schema whose first rule write
 * failed. (The test-helper drift was harmless in itself: db/schema.sql already
 * declares the employment_type check that 005 backfills for older databases.
 * Harmless drift is still drift.) Reading the directory removes the class of bug
 * instead of fixing instances -- adding a migration file is now sufficient.
 */
export function schemaStatements(root: string = process.cwd()): string[] {
  const migrationsDir = join(root, 'db/migrations');
  const migrations = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => readFileSync(join(migrationsDir, f), 'utf8'));
  return [readFileSync(join(root, 'db/schema.sql'), 'utf8'), ...migrations];
}
