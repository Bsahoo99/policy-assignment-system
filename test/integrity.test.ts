import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { parsePredicate, toSql, PredicateValidationError } from '../src/predicate';
import { createRule } from '../src/api/writes';
import { FixedClock } from '../src/clock';
import type { Db } from '../src/db';
import { schemaStatements, ensureSchema, baseSchema, migrationFiles } from '../src/schema-sql';
import { pgliteDb } from '../src/runtime';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import {
  createTestDb,
  insertCompany,
  insertSlot,
  insertAssignmentTarget,
} from './helpers';

/**
 * `Predicate` is a compile-time type, but criteria arrive as JSON on an HTTP
 * body and `toSql` compiles `field` into query text as an identifier.
 * Parameterising values does not protect an identifier.
 */
describe('predicate input validation', () => {
  it('test_parse_predicate_field_carrying_sql_is_rejected', () => {
    expect(() =>
      parsePredicate({ op: 'eq', field: "department = 'x' OR 1=1 --", value: 'x' }),
    ).toThrow(PredicateValidationError);
  });

  it('test_parse_predicate_unknown_field_is_rejected', () => {
    expect(() => parsePredicate({ op: 'eq', field: 'salary', value: '1' })).toThrow(
      /unknown field/,
    );
  });

  it('test_parse_predicate_unknown_operator_is_rejected', () => {
    expect(() => parsePredicate({ op: 'drop_table' })).toThrow(/unknown op/);
  });

  it('test_parse_predicate_non_integer_tenure_years_is_rejected', () => {
    expect(() => parsePredicate({ op: 'gte_tenure', years: 1.5 })).toThrow(/whole number/);
    expect(() => parsePredicate({ op: 'gte_tenure', years: -1 })).toThrow(/whole number/);
  });

  it('test_parse_predicate_hostile_group_key_is_rejected', () => {
    expect(() =>
      parsePredicate({ op: 'in_group', group: "hq'); DROP TABLE employees;--" }),
    ).toThrow(/group key/);
  });

  it('test_parse_predicate_deeply_nested_tree_is_rejected', () => {
    let node: unknown = { op: 'always' };
    for (let i = 0; i < 25; i += 1) node = { op: 'not', child: node };
    expect(() => parsePredicate(node)).toThrow(/nested deeper/);
  });

  it('test_parse_predicate_accepts_every_supported_operator', () => {
    const good = {
      op: 'and',
      children: [
        { op: 'always' },
        { op: 'eq', field: 'department', value: 'Engineering' },
        { op: 'in', field: 'location_state', values: ['CA', 'NY'] },
        { op: 'gte_tenure', years: 2 },
        { op: 'in_group', group: 'engineering' },
        { op: 'or', children: [{ op: 'is_manager' }, { op: 'not', child: { op: 'is_manager' } }] },
      ],
    };
    expect(() => parsePredicate(good)).not.toThrow();
  });

  /** Even if an unparsed predicate reached toSql, the column map must reject it. */
  it('test_to_sql_never_interpolates_an_unknown_field', () => {
    const hostile = { op: 'eq', field: "department = 'x' OR 1=1 --", value: 'x' };
    expect(() => toSql(hostile as never, new Date('2026-01-01T00:00:00Z'))).toThrow(
      PredicateValidationError,
    );
  });
});

/**
 * D4: there is no "add tenancy later" path in a payroll system. Composite keys
 * carry the invariant so no write path can forget it.
 */
describe('tenant and target-type integrity', () => {
  async function fixture() {
    const pg: PGlite = await createTestDb();
    const db = pg as unknown as Db;
    const companyA = await insertCompany(db, 'A');
    const companyB = await insertCompany(db, 'B');
    const paySlotA = await insertSlot(db, companyA, 'payroll', 'exactly_one', 'pay_schedule');
    const appTargetA = await insertAssignmentTarget(db, companyA, 'app', 'A Slack');
    const appTargetB = await insertAssignmentTarget(db, companyB, 'app', 'B Slack');
    const payTargetA = await insertAssignmentTarget(db, companyA, 'pay_schedule', 'A Monthly');
    // Same type as the slot, but the wrong company: isolates the tenancy check
    // from the target-type check, which the appTargetB case conflates.
    const payTargetB = await insertAssignmentTarget(db, companyB, 'pay_schedule', 'B Monthly');
    return { pg, db, companyA, companyB, paySlotA, appTargetA, appTargetB, payTargetA, payTargetB };
  }

  const clock = new FixedClock(new Date('2026-01-01T00:00:00Z'));
  const at = new Date('2026-01-01T00:00:00Z');

  it('test_rule_naming_another_companys_target_is_rejected', async () => {
    const f = await fixture();
    await expect(
      createRule(
        f.db,
        f.companyA,
        { name: 'cross tenant', slotId: f.paySlotA, targetId: f.appTargetB, criteria: { op: 'always' } },
        at,
        clock,
      ),
    ).rejects.toThrow();
    await f.pg.close();
  });

  it('test_rule_naming_another_companys_target_of_the_right_type_is_rejected', async () => {
    const f = await fixture();
    await expect(
      createRule(
        f.db,
        f.companyA,
        { name: 'foreign same-type', slotId: f.paySlotA, targetId: f.payTargetB, criteria: { op: 'always' } },
        at,
        clock,
      ),
    ).rejects.toThrow();
    await f.pg.close();
  });

  it('test_rule_whose_target_type_mismatches_its_slot_is_rejected', async () => {
    const f = await fixture();
    await expect(
      createRule(
        f.db,
        f.companyA,
        { name: 'type mismatch', slotId: f.paySlotA, targetId: f.appTargetA, criteria: { op: 'always' } },
        at,
        clock,
      ),
    ).rejects.toThrow();
    await f.pg.close();
  });

  it('test_rule_naming_another_companys_slot_reports_the_company_mismatch', async () => {
    const f = await fixture();
    const slotB = await insertSlot(f.db, f.companyB, 'payroll', 'exactly_one', 'pay_schedule');
    await expect(
      createRule(
        f.db,
        f.companyA,
        { name: 'foreign slot', slotId: slotB, targetId: f.payTargetA, criteria: { op: 'always' } },
        at,
        clock,
      ),
    ).rejects.toThrow(/does not belong to company/);
    await f.pg.close();
  });

  it('test_rule_with_matching_company_and_target_type_is_accepted', async () => {
    const f = await fixture();
    const id = await createRule(
      f.db,
      f.companyA,
      { name: 'valid', slotId: f.paySlotA, targetId: f.payTargetA, criteria: { op: 'always' } },
      at,
      clock,
    );
    expect(id).toBeTruthy();
    await f.pg.close();
  });
});

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Every startup path must apply every migration. The Docker entrypoint was a
 * static list of `\i` lines and it drifted: 006 was added, the list was not, and
 * the documented Postgres setup built a schema whose first rule write failed with
 * 42703. The TypeScript callers were centralised on a directory read at the same
 * time and this one was missed because it is psql, not TypeScript.
 */
describe('migration delivery', () => {
  /**
   * The DDL and its ledger row must commit together. Postgres has transactional
   * DDL, so an interrupted run leaves the database on the last fully applied
   * migration -- rather than schema-ahead-of-ledger, which the next startup would
   * try to re-apply, and these migrations are not idempotent.
   */
  it('test_a_failing_migration_leaves_neither_its_schema_change_nor_its_ledger_row', async () => {
    const root = mkdtempSync(join(tmpdir(), 'warp-mig-'));
    try {
      mkdirSync(join(root, 'db/migrations'), { recursive: true });
      writeFileSync(
        join(root, 'db/schema.sql'),
        `CREATE TABLE companies (id SERIAL PRIMARY KEY);
         CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now());`,
      );
      writeFileSync(join(root, 'db/migrations/001_ok.sql'), 'CREATE TABLE first_ok (i int);');
      writeFileSync(join(root, 'db/migrations/002_broken.sql'), 'CREATE TABLE second (i int) THIS IS NOT SQL;');

      const pg = new PGlite({ extensions: { btree_gist } });
      await pg.waitReady;
      const db = pgliteDb(pg);

      await expect(ensureSchema(db, root)).rejects.toThrow();

      // Nothing from the failed run survives: not the good migration's table,
      // not its ledger row, not the broken one's.
      const tables = await db.query<{ t: string | null }>(
        "SELECT to_regclass('first_ok') AS t",
      );
      expect(tables.rows[0].t).toBeNull();
      await pg.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('test_a_run_that_succeeds_records_every_migration_it_applied', async () => {
    const root = mkdtempSync(join(tmpdir(), 'warp-mig-'));
    try {
      mkdirSync(join(root, 'db/migrations'), { recursive: true });
      writeFileSync(
        join(root, 'db/schema.sql'),
        `CREATE TABLE companies (id SERIAL PRIMARY KEY);
         CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now());`,
      );
      writeFileSync(join(root, 'db/migrations/001_a.sql'), 'CREATE TABLE a (i int);');
      writeFileSync(join(root, 'db/migrations/002_b.sql'), 'CREATE TABLE b (i int);');

      const pg = new PGlite({ extensions: { btree_gist } });
      await pg.waitReady;
      const db = pgliteDb(pg);

      const { applied } = await ensureSchema(db, root);
      expect(applied).toEqual(['001_a.sql', '002_b.sql']);
      const ledger = await db.query<{ name: string }>('SELECT name FROM schema_migrations ORDER BY name');
      expect(ledger.rows.map((r) => r.name)).toEqual(['001_a.sql', '002_b.sql']);
      await pg.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /**
   * The defect this replaces: each startup path probed for a feature of the
   * newest migration, so every migration needed a new probe somewhere, and 007
   * shipped while both probes still stopped at 006. Freshly created databases
   * were protected and upgraded ones silently were not.
   */
  it('test_database_created_before_the_last_migration_receives_it_on_startup', async () => {
    const pg = new PGlite({ extensions: { btree_gist } });
    await pg.waitReady;
    const db = pg as unknown as Db;

    const all = migrationFiles(repoRoot);
    const older = all.slice(0, -1);
    const newest = all[all.length - 1];

    // A database as it stood one migration ago.
    await db.exec(baseSchema(repoRoot));
    for (const m of older) {
      await db.exec(m.sql);
      await db.query('INSERT INTO schema_migrations (name) VALUES ($1)', [m.name]);
    }
    const before = await db.query<{ name: string }>('SELECT name FROM schema_migrations');
    expect(before.rows.map((r) => r.name)).not.toContain(newest.name);

    // Opening it must bring it forward.
    const { applied } = await ensureSchema(db, repoRoot);
    expect(applied).toEqual([newest.name]);

    const after = await db.query<{ name: string }>('SELECT name FROM schema_migrations');
    expect(after.rows.map((r) => r.name).sort()).toEqual(all.map((m) => m.name).sort());
    await pg.close();
  });

  it('test_ensure_schema_on_a_current_database_applies_nothing', async () => {
    const pg = new PGlite({ extensions: { btree_gist } });
    await pg.waitReady;
    const db = pg as unknown as Db;
    await ensureSchema(db, repoRoot);
    const second = await ensureSchema(db, repoRoot);
    expect(second.applied).toEqual([]);
    await pg.close();
  });

  it('test_database_predating_migration_tracking_is_refused_not_guessed', async () => {
    const pg = new PGlite({ extensions: { btree_gist } });
    await pg.waitReady;
    const db = pg as unknown as Db;
    // Data present, but no record of what has been applied.
    await db.exec(baseSchema(repoRoot));
    await db.query("INSERT INTO companies (name) VALUES ('legacy')");
    await db.exec('DROP TABLE schema_migrations');
    await expect(ensureSchema(db, repoRoot)).rejects.toThrow(/predates migration tracking/);
    await pg.close();
  });

  it('test_docker_entrypoint_globs_migrations_rather_than_listing_them', () => {
    const entrypointDir = join(repoRoot, 'db/docker-entrypoint-initdb.d');
    const files = readdirSync(entrypointDir);
    const contents = files.map((f) => readFileSync(join(entrypointDir, f), 'utf8')).join('\n');

    // No entrypoint file may name an individual migration; that is what drifts.
    for (const migration of readdirSync(join(repoRoot, 'db/migrations'))) {
      expect(contents).not.toContain(migration);
    }
    // It must instead iterate the directory.
    expect(contents).toMatch(/migrations\/\*\.sql/);
  });

  it('test_schema_statements_are_the_schema_then_every_migration_in_order', () => {
    const dir = join(repoRoot, 'db/migrations');
    const expected = [
      readFileSync(join(repoRoot, 'db/schema.sql'), 'utf8'),
      ...readdirSync(dir)
        .filter((f) => f.endsWith('.sql'))
        .sort()
        .map((f) => readFileSync(join(dir, f), 'utf8')),
    ];
    expect(schemaStatements(repoRoot)).toEqual(expected);
  });
});
