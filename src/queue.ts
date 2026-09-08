import { PgBoss } from 'pg-boss';
import type { Db } from './db';
import type { Queue } from './types';

export function createBoss(connectionString: string): PgBoss {
  return new PgBoss({ connectionString });
}

export function createQueue(boss: PgBoss, db: Db): Queue {
  return {
    send: async (name, data) => {
      await boss.send(name, data, {
        db: {
          executeSql: (text: string, values?: unknown[]) => db.query(text, values ?? []),
        },
      });
    },
  };
}

export function memoryQueue(): Queue & { sent: { name: string; data: unknown }[] } {
  const sent: { name: string; data: unknown }[] = [];
  return {
    sent,
    send: async (name, data) => {
      sent.push({ name, data });
    },
  };
}
