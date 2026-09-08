import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

/**
 * The base schema followed by every migration, in filename order.
 *
 * Six call sites used to hardcode this list, and they had already drifted: the
 * test helpers stopped at 004, so the suite ran against a schema missing 005's
 * employment_type check. Reading the directory removes the class of bug instead
 * of fixing one instance -- adding a migration file is now sufficient.
 */
export function schemaStatements(root: string = process.cwd()): string[] {
  const migrationsDir = join(root, 'db/migrations');
  const migrations = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => readFileSync(join(migrationsDir, f), 'utf8'));
  return [readFileSync(join(root, 'db/schema.sql'), 'utf8'), ...migrations];
}
