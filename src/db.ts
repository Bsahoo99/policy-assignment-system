export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  exec(sql: string): Promise<unknown>;
  /**
   * Runs `fn` inside a transaction bound to a single connection. Every write
   * path, every `supersede` call, every audit insert, and every enqueue must
   * take `tx` as its Db — nothing reaches for the pool inside a transaction.
   * Optional because embedded adapters (PGlite) may run on a single connection.
   */
  withTransaction?<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
}
