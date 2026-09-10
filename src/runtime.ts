import { Pool, type PoolClient } from 'pg';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { PgBoss } from 'pg-boss';
import { SystemClock } from './clock';
import { ensureSchema } from './schema-sql';
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

/**
 * A Db bound to one connection, with every statement serialised through one
 * queue — including BEGIN, COMMIT and ROLLBACK.
 *
 * Why serialise at all: the engine issues independent reads together
 * (`Promise.all` in `reconcile`, `candidates`, `state`, `scheduler`). That is
 * correct against a Pool, where each query takes its own connection, and wrong
 * against the single client `withTransaction` binds, because a Postgres
 * connection cannot multiplex. `pg` warns today and throws in pg 9. PGlite
 * serialises internally and hid it entirely.
 *
 * Why the queue also owns transaction control: an earlier version of this
 * adapter serialised the queries but let the caller issue ROLLBACK directly on
 * the client, and kept draining the queue after a failure. Both were wrong, and
 * together they lost writes. Given
 *
 *     await Promise.all([tx.query('SELECT 1/0'), tx.query('INSERT ...')])
 *
 * `Promise.all` rejects as soon as the first query does, the caller rolls back
 * immediately, and the still-queued INSERT then runs *after* the ROLLBACK — on a
 * connection that is no longer in a transaction, so it autocommitted and
 * survived.
 *
 * Two rules prevent that. The first failure **poisons** the queue: everything
 * still queued rejects without touching the connection, which is also what
 * Postgres would do, since statements after an error in a transaction fail with
 * "current transaction is aborted". And transaction control goes through
 * `finalize`, which runs only once the queue has drained — so ROLLBACK is
 * genuinely last, and the client is not released while work remains.
 */
export function serialClient(client: PoolClient): { db: Db; finalize: (sql: string) => Promise<unknown> } {
  let tail: Promise<unknown> = Promise.resolve();
  let poison: unknown = null;

  const enqueue = <T>(run: () => Promise<T>): Promise<T> => {
    const result = tail.then(async () => {
      if (poison !== null) throw poison;
      try {
        return await run();
      } catch (e) {
        // First failure ends the transaction; nothing after it may reach the wire.
        if (poison === null) poison = e;
        throw e;
      }
    });
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  /** Runs after the queue drains, and runs even when the queue is poisoned. */
  const finalize = (sql: string): Promise<unknown> => {
    const result = tail.then(
      () => client.query(sql),
      () => client.query(sql),
    );
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  return {
    db: {
      query: <T = Record<string, unknown>>(text: string, params?: unknown[]) =>
        enqueue(() => client.query(text, params as never[])) as unknown as Promise<{ rows: T[] }>,
      exec: (sql: string) => enqueue(() => client.query(sql)),
    },
    finalize,
  };
}

function poolDb(pool: Pool): Db {
  return {
    query: <T = Record<string, unknown>>(text: string, params?: unknown[]) =>
      pool.query(text, params as never[]) as unknown as Promise<{ rows: T[] }>,
    exec: (sql: string) => pool.query(sql),
    withTransaction: async <T>(fn: (tx: Db) => Promise<T>): Promise<T> => {
      const client = await pool.connect();
      const { db: tx, finalize } = serialClient(client);
      try {
        await finalize('BEGIN');
        const out = await fn(tx);
        // Drains the queue first, so a statement still in flight cannot land
        // after the transaction has ended.
        await finalize('COMMIT');
        return out;
      } catch (e) {
        // Same ordering guarantee on the failure path, and a rollback that
        // itself fails must not mask the original error.
        await finalize('ROLLBACK').catch(() => undefined);
        throw e;
      } finally {
        client.release();
      }
    },
  };
}

/** Exported so tests can exercise the transactional path, not just raw PGlite. */
export function pgliteDb(pglite: PGlite): Db {
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

/**
 * Both backends take the same path: create the schema if absent, then apply any
 * migration `schema_migrations` does not already name. Previously each backend
 * had its own chain of per-feature probes, and migration 007 shipped while both
 * chains still stopped at 006.
 */
async function initDb(): Promise<Db> {
  if (process.env.DATABASE_URL) {
    const db = poolDb(new Pool({ connectionString: process.env.DATABASE_URL }));
    await ensureSchema(db);
    return db;
  }
  const pglite = new PGlite({ dataDir: process.env.PGLITE_DATA_DIR ?? './.pglite', extensions: { btree_gist } });
  await pglite.waitReady;
  const db = pgliteDb(pglite);
  await ensureSchema(db);
  return db;
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
