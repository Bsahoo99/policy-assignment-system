import { PgBoss } from 'pg-boss';
import { SystemClock } from '../src/clock';
import { createQueue } from '../src/queue';
import { handleJob } from '../src/worker';
import { getDb } from '../src/runtime';
import type { Queue } from '../src/types';

async function main() {
  if (!process.env.DATABASE_URL) {
    console.log('DATABASE_URL is not set — worker requires real Postgres for pg-boss. Embedded PGlite mode uses an in-memory queue instead.');
    process.exit(0);
  }
  const db = await getDb();
  const clock = new SystemClock();
  const boss = new PgBoss({ connectionString: process.env.DATABASE_URL });
  await boss.start();

  const QUEUES = ['resolve-assignment', 'recompute-material-dates', 'dispatch-material-dates'] as const;
  for (const q of QUEUES) await boss.createQueue(q);

  const queue: Queue = createQueue(boss, db);

  await boss.work('resolve-assignment', async ([job]) => {
    await handleJob(db, clock, queue, { name: 'resolve-assignment', data: job.data as object });
  });
  await boss.work('recompute-material-dates', async ([job]) => {
    await handleJob(db, clock, queue, { name: 'recompute-material-dates', data: job.data as object });
  });
  await boss.work('dispatch-material-dates', async ([job]) => {
    await handleJob(db, clock, queue, { name: 'dispatch-material-dates', data: job.data as object });
  });
  // Poll due material dates every minute. The enqueued reconcile jobs stamp the
  // stored next_at as their effective_at, not the dispatch time (D14).
  await boss.schedule('dispatch-material-dates', '* * * * *', {});
  console.log('worker started: resolve-assignment + recompute-material-dates + dispatch-material-dates');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
