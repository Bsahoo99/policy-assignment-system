/**
 * The one bi-temporal write primitive. Every write to a bi-temporal table goes
 * through `supersede`. No route handler, worker, or migration constructs its own
 * INSERT/UPDATE against `valid` or `system`.
 *
 * Findings 2 and 3 in the phase review were both caused by call sites hand-rolling
 * this logic and each guessing differently. The fix is not to patch those sites; it
 * is to make them stop hand-rolling it.
 *
 * The rules (DECISIONS.md D2):
 *   - an existing row's `valid` range is NEVER edited
 *   - every change closes `system` on affected rows and inserts replacements
 *   - a correction and an ordinary termination are the same operation
 *
 * INVARIANT this primitive requires of every table it touches:
 *   `id` is a surrogate primary key identifying ONE VERSION ROW, and it is never the
 *   timeline key. The timeline key (employee_id, rule_id, ...) is what versions share.
 *   A table where `id` is the timeline key will have its history silently corrupted,
 *   because closing "the affected rows" would close every version ever recorded.
 *   `assignment_rules` originally violated this. See migration 003.
 *
 * The part that is easy to get wrong, and that findings 2 and 3 both got wrong:
 * asserting a fact over [from, to) must SLICE the open rows it overlaps, re-inserting
 * the non-overlapped remnants. Correcting "moved Aug 15" to "moved Aug 1" overlaps
 * both the pre-move row and the post-move row. Insert without slicing and the
 * exclusion constraint fires, which is exactly the error the reviewer reproduced.
 */

export interface Db {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface SupersedeOptions {
  /** Bi-temporal table name. */
  table: string;
  companyId: string;
  /**
   * Columns identifying the timeline being written. Employment facts key on
   * employee_id; rule versions key on id; group memberships key on
   * (group_id, employee_id).
   */
  key: Record<string, string>;
  /**
   * The new fact. `null` means "this timeline has no fact over [validFrom, validTo)",
   * which is how an assignment ends or a membership is revoked. Slicing still happens.
   */
  payload: Record<string, unknown> | null;
  validFrom: Date;
  /** Open-ended when null. */
  validTo: Date | null;
  /** From the injected Clock. Never `new Date()`. */
  now: Date;
}

interface OpenRow {
  id: string;
  valid_from: Date;
  valid_to: Date | null;
  [k: string]: unknown;
}

export async function supersede(db: Db, opts: SupersedeOptions): Promise<void> {
  const { table, companyId, key, payload, validFrom, validTo, now } = opts;

  const keyCols = Object.keys(key);
  const keyPreds = keyCols.map((c, i) => `${c} = $${i + 2}`).join(' AND ');
  const keyVals = keyCols.map((c) => key[c]);

  // 1. Lock every currently-believed row whose valid range overlaps what we are
  //    asserting. FOR UPDATE, because two concurrent corrections to the same
  //    timeline would otherwise both pass the overlap check and then collide on the
  //    exclusion constraint.
  const { rows: affected } = await db.query<OpenRow>(
    `SELECT *, lower(valid) AS valid_from, upper(valid) AS valid_to
       FROM ${table}
      WHERE company_id = $1 AND ${keyPreds}
        AND upper_inf(system)
        AND valid && tstzrange($${keyCols.length + 2}, $${keyCols.length + 3})
      FOR UPDATE`,
    [companyId, ...keyVals, validFrom, validTo],
  );

  // 2. Close system on all of them. They stay readable at any earlier system time,
  //    which is what preserves "what we believed in February".
  //
  //    `upper_inf(system)` is defence in depth, not decoration. If a table ever
  //    violates the surrogate-key invariant above, this at least stops the UPDATE
  //    from reaching back and rewriting already-closed historical versions, which is
  //    unrecoverable. Narrowing the blast radius of a schema mistake is worth one
  //    predicate.
  if (affected.length > 0) {
    const { rowCount } = await closeRows(db, table, affected.map((r) => r.id), now);
    if (rowCount !== affected.length) {
      throw new Error(
        `supersede(${table}): selected ${affected.length} open rows but closed ${rowCount}. ` +
        `This means \`id\` is not a per-version surrogate key on this table.`,
      );
    }
  }

  // 3. Re-insert the parts of those rows that our assertion does not cover.
  //    This is the step both failing call sites omitted.
  for (const row of affected) {
    const remnants = sliceAround(row.valid_from, row.valid_to, validFrom, validTo);
    for (const [from, to] of remnants) {
      await insertRow(db, table, companyId, key, extractPayload(row, keyCols), from, to, now);
    }
  }

  // 4. Insert the new fact, if there is one.
  if (payload !== null) {
    await insertRow(db, table, companyId, key, payload, validFrom, validTo, now);
  }
}

async function closeRows(db: Db, table: string, ids: string[], now: Date) {
  const { rows } = await db.query<{ id: string }>(
    `UPDATE ${table}
        SET system = tstzrange(lower(system), $1)
      WHERE id = ANY($2::uuid[]) AND upper_inf(system)
      RETURNING id`,
    [now, ids],
  );
  return { rowCount: rows.length };
}

/**
 * The portions of [rowFrom, rowTo) not covered by [newFrom, newTo).
 * At most two: a leading slice and a trailing slice.
 */
export function sliceAround(
  rowFrom: Date,
  rowTo: Date | null,
  newFrom: Date,
  newTo: Date | null,
): [Date, Date | null][] {
  const out: [Date, Date | null][] = [];

  if (rowFrom.getTime() < newFrom.getTime()) {
    out.push([rowFrom, newFrom]);
  }

  // A null upper bound is +infinity, so an open assertion leaves no trailing remnant
  // and an open row trails anything closed.
  if (newTo !== null) {
    const rowEndsAfter = rowTo === null || rowTo.getTime() > newTo.getTime();
    if (rowEndsAfter) out.push([newTo, rowTo]);
  }

  return out;
}

async function insertRow(
  db: Db,
  table: string,
  companyId: string,
  key: Record<string, string>,
  payload: Record<string, unknown>,
  validFrom: Date,
  validTo: Date | null,
  now: Date,
): Promise<void> {
  const cols = ['company_id', ...Object.keys(key), ...Object.keys(payload), 'valid', 'system'];
  const vals = [companyId, ...Object.values(key), ...Object.values(payload)];

  const placeholders = vals.map((_, i) => `$${i + 1}`);
  placeholders.push(`tstzrange($${vals.length + 1}, $${vals.length + 2})`);
  placeholders.push(`tstzrange($${vals.length + 3}, NULL)`);

  await db.query(
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders.join(', ')})`,
    [...vals, validFrom, validTo, now],
  );
}

/**
 * Columns that travel with a remnant. Excludes identity, tenancy, and both ranges.
 *
 * `created_at` is deliberately NOT carried: it is row metadata recording when this
 * version row was written, and a remnant is a new row. Anything resolution reads must
 * therefore live in a column with stable-across-versions semantics
 * (assignment_rules.rule_created_at), never in created_at. See migration 004 -- reading
 * created_at from a tie-break made past resolutions change when a future-effective
 * edit sliced a rule's valid range.
 */
const NON_PAYLOAD = new Set(['id', 'company_id', 'valid', 'system', 'valid_from', 'valid_to', 'created_at']);

function extractPayload(row: OpenRow, keyCols: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (NON_PAYLOAD.has(k)) continue;
    if (keyCols.includes(k)) continue;   // the caller supplies these separately
    out[k] = v;
  }
  return out;
}

// There was a hardcoded table -> key-columns map here. It was wrong by construction:
// a table missing from the map produced an INSERT listing its key column twice, and
// the failure surfaced as a Postgres syntax error at runtime rather than a type error
// at compile time. The key columns are already in `opts.key` at every call site, so
// derive them from there and the map cannot drift out of sync with reality.
