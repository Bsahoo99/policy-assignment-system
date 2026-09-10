import { describe, it, expect } from 'vitest';
import type { PoolClient } from 'pg';
import { serialClient } from '../src/runtime';

/**
 * A stand-in for a single Postgres connection that records the statements that
 * actually reach the wire, and fails the ones told to.
 */
function fakeClient(failOn: (sql: string) => boolean) {
  const seen: string[] = [];
  let inFlight = 0;
  let overlapped = false;
  const client = {
    query: async (text: string) => {
      inFlight += 1;
      if (inFlight > 1) overlapped = true;
      seen.push(text);
      await new Promise((r) => setTimeout(r, 1));
      inFlight -= 1;
      if (failOn(text)) throw new Error(`failed: ${text}`);
      return { rows: [] };
    },
  } as unknown as PoolClient;
  return { client, seen, didOverlap: () => overlapped };
}

describe('single-connection transaction boundary', () => {
  /**
   * The regression this exists for: an earlier adapter kept draining the queue
   * after a failure and let ROLLBACK bypass the queue, so a queued INSERT ran
   * after the rollback, outside any transaction, and autocommitted. Reproduced
   * against real Postgres as a surviving row.
   */
  it('test_statements_queued_behind_a_failure_never_reach_the_connection', async () => {
    const { client, seen } = fakeClient((sql) => sql.includes('1/0'));
    const { db, finalize } = serialClient(client);

    await finalize('BEGIN');
    await expect(
      Promise.all([
        db.query('SELECT 1/0'),
        db.query('SELECT 2'),
        db.query('INSERT INTO probe VALUES (42)'),
      ]),
    ).rejects.toThrow(/1\/0/);
    await finalize('ROLLBACK');

    expect(seen).not.toContain('INSERT INTO probe VALUES (42)');
    expect(seen).not.toContain('SELECT 2');
  });

  /**
   * Faithful to `withTransaction`: `Promise.all` rejects on the first failure and
   * the rollback is issued immediately, while later statements are still queued.
   * Awaiting the stragglers first would drain the queue and hide the defect --
   * which is exactly what an earlier version of this test did.
   */
  it('test_rollback_is_the_last_statement_even_while_work_is_still_queued', async () => {
    const { client, seen } = fakeClient((sql) => sql.includes('1/0'));
    const { db, finalize } = serialClient(client);

    await finalize('BEGIN');
    try {
      await Promise.all([
        db.query('SELECT 1/0'),
        db.query('SELECT 2'),
        db.query('INSERT INTO probe VALUES (42)'),
      ]);
    } catch {
      // no await on the outstanding queries, as withTransaction does not
      await finalize('ROLLBACK');
    }

    // Give anything still queued every chance to land before asserting.
    await new Promise((r) => setTimeout(r, 20));
    expect(seen[seen.length - 1]).toBe('ROLLBACK');
    expect(seen).not.toContain('INSERT INTO probe VALUES (42)');
  });

  it('test_queries_on_one_connection_never_overlap', async () => {
    const { client, didOverlap } = fakeClient(() => false);
    const { db, finalize } = serialClient(client);

    await finalize('BEGIN');
    await Promise.all([
      db.query('SELECT 1'),
      db.query('SELECT 2'),
      db.query('SELECT 3'),
      db.exec('SELECT 4'),
    ]);
    await finalize('COMMIT');

    expect(didOverlap()).toBe(false);
  });

  it('test_a_successful_transaction_still_runs_every_statement_in_order', async () => {
    const { client, seen } = fakeClient(() => false);
    const { db, finalize } = serialClient(client);

    await finalize('BEGIN');
    await Promise.all([db.query('SELECT 1'), db.query('SELECT 2')]);
    await finalize('COMMIT');

    expect(seen).toEqual(['BEGIN', 'SELECT 1', 'SELECT 2', 'COMMIT']);
  });
});
