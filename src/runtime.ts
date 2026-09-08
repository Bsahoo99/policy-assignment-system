import { Pool, type PoolClient } from 'pg';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { readFileSync } from 'fs';
import { join } from 'path';
import { PgBoss } from 'pg-boss';
import { SystemClock } from './clock';
import { createQueue, memoryQueue } from './queue';
import { reconcileEmployee } from './reconcile';
import { computeEmployeeMaterialDates, dispatchDueMaterialDates, dispatchAllDueMaterialDates, upsertMaterialDates } from './scheduler';
import type { Clock } from './clock';
import type { Db } from './db';
import type { Queue } from './types';

// globalThis, not module scope: Turbopack dev re-executes this module when a
// new route bundle compiles, and a second `new PGlite` on the same dataDir
// aborts the wasm runtime ("RuntimeError: Aborted()").
const globalForDb = globalThis as { __warpDb?: Db; __warpDbInit?: Promise<Db> };

let boss: PgBoss | null = null;
let queue: Queue | null = null;
let clock: Clock | null = null;

function poolClientDb(client: PoolClient): Db {
  return {
    query: <T = Record<string, unknown>>(text: string, params?: unknown[]) =>
      client.query(text, params as never[]) as unknown as Promise<{ rows: T[] }>,
    exec: (sql: string) => client.query(sql),
  };
}

function poolDb(pool: Pool): Db {
  return {
    query: <T = Record<string, unknown>>(text: string, params?: unknown[]) =>
      pool.query(text, params as never[]) as unknown as Promise<{ rows: T[] }>,
    exec: (sql: string) => pool.query(sql),
    withTransaction: async <T>(fn: (tx: Db) => Promise<T>): Promise<T> => {
      const client = await pool.connect();
      const tx = poolClientDb(client);
      try {
        await client.query('BEGIN');
        const out = await fn(tx);
        await client.query('COMMIT');
        return out;
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    },
  };
}

function pgliteDb(pglite: PGlite): Db {
  return {
    query: <T = Record<string, unknown>>(text: string, params?: unknown[]) =>
      pglite.query(text, params) as Promise<{ rows: T[] }>,
    exec: (sql: string) => pglite.exec(sql),
    // PGlite is single-connection; its transaction() API runs the callback
    // inside BEGIN/COMMIT and rolls back on throw.
    withTransaction: <T>(fn: (tx: Db) => Promise<T>): Promise<T> =>
      pglite.transaction(async (pgTx) =>
        fn({
          query: <T = Record<string, unknown>>(text: string, params?: unknown[]) =>
            pgTx.query(text, params) as Promise<{ rows: T[] }>,
          exec: (sql: string) => pgTx.exec(sql),
        }),
      ),
  };
}

export function getDb(): Promise<Db> {
  if (globalForDb.__warpDb) return Promise.resolve(globalForDb.__warpDb);
  if (!globalForDb.__warpDbInit) {
    globalForDb.__warpDbInit = initDb()
      .then((d) => {
        globalForDb.__warpDb = d;
        return d;
      })
      .catch((e) => {
        // Allow a later call to retry instead of caching a rejected promise.
        globalForDb.__warpDbInit = undefined;
        throw e;
      });
  }
  return globalForDb.__warpDbInit;
}

async function applyMissingMigrations(pglite: PGlite): Promise<void> {
  const { rows } = await pglite.query<{ col: string | null }>(`SELECT to_regclass('assignment_rules') AS col`);
  if (!rows[0].col) return;
  const { rows: cols } = await pglite.query<{ column_name: string }>(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_name = 'assignment_rules' AND column_name = 'rule_created_at'`,
  );
  if (cols.length === 0) {
    await pglite.exec(readFileSync(join(process.cwd(), 'db/migrations/004_stable_tiebreak.sql'), 'utf8'));
  }
  // 005 is self-guarding (ADD CONSTRAINT ... IF NOT EXISTS equivalent via
  // pg_constraint), so it is safe to run on every boot.
  await pglite.exec(readFileSync(join(process.cwd(), 'db/migrations/005_employment_type_check.sql'), 'utf8'));
}

async function initDb(): Promise<Db> {
  if (process.env.DATABASE_URL) {
    return poolDb(new Pool({ connectionString: process.env.DATABASE_URL }));
  }
  const pglite = new PGlite({ dataDir: process.env.PGLITE_DATA_DIR ?? './.pglite', extensions: { btree_gist } });
  await pglite.waitReady;
  const { rows } = await pglite.query<{ t: string | null }>(`SELECT to_regclass('companies') AS t`);
  if (!rows[0].t) {
    await pglite.exec(readFileSync(join(process.cwd(), 'db/schema.sql'), 'utf8'));
    await pglite.exec(readFileSync(join(process.cwd(), 'db/migrations/002_rule_effect.sql'), 'utf8'));
    await pglite.exec(readFileSync(join(process.cwd(), 'db/migrations/003_rule_version_key.sql'), 'utf8'));
    await pglite.exec(readFileSync(join(process.cwd(), 'db/migrations/004_stable_tiebreak.sql'), 'utf8'));
    await pglite.exec(readFileSync(join(process.cwd(), 'db/migrations/005_employment_type_check.sql'), 'utf8'));
  } else {
    await applyMissingMigrations(pglite);
  }
  return pgliteDb(pglite);
}

export function getClock(): Clock {
  if (!clock) clock = new SystemClock();
  return clock;
}

/** The pg-boss instance, if running against real Postgres. Null in embedded mode. */
export async function getBoss(): Promise<PgBoss | null> {
  if (!process.env.DATABASE_URL) return null;
  if (!boss) {
    boss = new PgBoss({ connectionString: process.env.DATABASE_URL });
    await boss.start();
  }
  return boss;
}

/**
 * A Queue bound to `tx` so enqueues commit atomically with the write. Pass the
 * transaction handle; do not use a queue bound to the pool inside a tx.
 */
export async function transactionalQueue(tx: Db): Promise<Queue> {
  const b = await getBoss();
  return b ? createQueue(b, tx) : getQueue();
}

export async function getQueue(): Promise<Queue> {
  if (queue) return queue;
  const b = await getBoss();
  if (b) {
    for (const q of ['resolve-assignment', 'recompute-material-dates', 'dispatch-material-dates']) {
      await b.createQueue(q);
    }
    queue = createQueue(b, await getDb());
  } else {
    // Embedded PGlite mode: jobs are held in memory and drained synchronously
    // after each write so UI changes reconcile inline. Postgres mode uses the
    // separate `npm run worker` process.
    queue = memoryQueue();
  }
  return queue;
}

export interface ResolveAssignmentJob {
  company_id: string;
  employee_ids: string[];
  effective_at: string;
}

export interface RecomputeMaterialDatesJob {
  company_id: string;
}

export interface DispatchMaterialDatesJob {
  company_id?: string;
}

export async function handleJob(
  db: Db,
  clock: Clock,
  queue: Queue,
  job: { name: string; data: unknown },
): Promise<void> {
  const run = (fn: (tx: Db, q: Queue) => Promise<unknown>) =>
    db.withTransaction
      ? db.withTransaction(async (tx) => fn(tx, await transactionalQueue(tx)))
      : fn(db, queue);

  if (job.name === 'resolve-assignment') {
    const data = job.data as ResolveAssignmentJob;
    for (const employeeId of data.employee_ids) {
      await run((tx, q) =>
        reconcileEmployee(tx, data.company_id, employeeId, new Date(data.effective_at), clock, q),
      );
    }
    return;
  }

  if (job.name === 'recompute-material-dates') {
    const data = job.data as RecomputeMaterialDatesJob;
    await run(async (tx) => {
      const dates = await computeEmployeeMaterialDates(tx, data.company_id, clock.now());
      await upsertMaterialDates(tx, data.company_id, dates);
    });
    return;
  }

  if (job.name === 'dispatch-material-dates') {
    const data = job.data as DispatchMaterialDatesJob;
    await run(async (tx, q) => {
      if (data.company_id) {
        await dispatchDueMaterialDates(tx, data.company_id, clock.now(), q);
      } else {
        await dispatchAllDueMaterialDates(tx, clock.now(), q);
      }
    });
    return;
  }
}

/** Drain an in-memory queue synchronously (used by embedded PGlite mode). */
export async function drainMemoryQueue(db: Db, clock: Clock, queue: Queue): Promise<void> {
  if (!('sent' in queue)) return;
  const mq = queue as Queue & { sent: { name: string; data: unknown }[] };
  while (mq.sent.length > 0) {
    const job = mq.sent.shift()!;
    await handleJob(db, clock, queue, job);
  }
}
