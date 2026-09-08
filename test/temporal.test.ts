import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { supersede, sliceAround, type Db } from '../src/temporal';

let db: PGlite & Db;

const CO = '00000000-0000-0000-0000-0000000000c0';
const JANE = '00000000-0000-0000-0000-00000000ja11'.replace(/[^0-9a-f-]/g, '1');

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

beforeEach(async () => {
  // btree_gist must be loaded, or CREATE EXTENSION silently is not available and the
  // exclusion constraints never exist. Tests would then pass against a table with no
  // temporal invariants at all, which is worse than no tests.
  db = (await PGlite.create({ extensions: { btree_gist } })) as PGlite & Db;
  await db.exec(`
    SET TIME ZONE 'UTC';
    CREATE EXTENSION IF NOT EXISTS btree_gist;
    CREATE TABLE employment_records (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id UUID NOT NULL,
      employee_id UUID NOT NULL,
      department TEXT,
      location_state TEXT,
      valid TSTZRANGE NOT NULL,
      system TSTZRANGE NOT NULL,
      EXCLUDE USING gist (
        company_id WITH =, employee_id WITH =, valid WITH &&, system WITH &&
      )
    );
  `);
});

afterAll(async () => {
  await db?.close();
});

/** What we believe about Jane, viewed at a given system time. */
async function beliefAt(systemAt: Date) {
  const { rows } = await db.query<{ state: string; from: string; to: string | null }>(
    `SELECT location_state AS state,
            to_char(lower(valid), 'YYYY-MM-DD') AS from,
            to_char(upper(valid), 'YYYY-MM-DD') AS to
       FROM employment_records
      WHERE employee_id = $1 AND system @> $2::timestamptz
      ORDER BY lower(valid)`,
    [JANE, systemAt],
  );
  return rows.map((r) => `${r.state}:${r.from}..${r.to ?? 'open'}`);
}

async function record(state: string, from: string, to: string | null, now: string) {
  await supersede(db, {
    table: 'employment_records',
    companyId: CO,
    key: { employee_id: JANE },
    payload: { department: 'Sales', location_state: state },
    validFrom: d(from),
    validTo: to ? d(to) : null,
    now: d(now),
  });
}

describe('supersede', () => {
  it('test_retroactive_correction_of_move_date_does_not_violate_exclusion', async () => {
    // The exact reproduction from the phase review, finding 3.
    await record('CA', '2026-01-01', null, '2026-01-01');
    await record('NY', '2026-08-15', null, '2026-08-15');

    // "She actually moved on Aug 1, not Aug 15." Overlaps BOTH existing rows.
    await expect(record('NY', '2026-08-01', null, '2026-09-04')).resolves.not.toThrow();

    expect(await beliefAt(d('2026-09-05'))).toEqual([
      'CA:2026-01-01..2026-08-01',
      'NY:2026-08-01..open',
    ]);
  });

  it('test_earlier_system_time_still_returns_the_superseded_belief', async () => {
    await record('CA', '2026-01-01', null, '2026-01-01');
    await record('NY', '2026-08-15', null, '2026-08-15');
    await record('NY', '2026-08-01', null, '2026-09-04');

    // What we believed on Sept 1, before the correction was entered.
    expect(await beliefAt(d('2026-09-01'))).toEqual([
      'CA:2026-01-01..2026-08-15',
      'NY:2026-08-15..open',
    ]);
  });

  it('test_asserting_a_closed_range_leaves_leading_and_trailing_remnants', async () => {
    await record('CA', '2026-01-01', null, '2026-01-01');
    // A three-month secondment carved out of the middle of an open row.
    await record('TX', '2026-04-01', '2026-07-01', '2026-04-01');

    expect(await beliefAt(d('2026-08-01'))).toEqual([
      'CA:2026-01-01..2026-04-01',
      'TX:2026-04-01..2026-07-01',
      'CA:2026-07-01..open',
    ]);
  });

  it('test_repeated_edits_to_the_same_timeline_do_not_collide', async () => {
    // Finding 2: the second edit failed because closed historical versions were
    // being reselected. Three consecutive edits must all succeed.
    await record('CA', '2026-01-01', null, '2026-01-01');
    await record('NY', '2026-03-01', null, '2026-03-02');
    await record('TX', '2026-03-01', null, '2026-03-03');
    await expect(record('CA', '2026-03-01', null, '2026-03-04')).resolves.not.toThrow();

    expect(await beliefAt(d('2026-04-01'))).toEqual([
      'CA:2026-01-01..2026-03-01',
      'CA:2026-03-01..open',
    ]);
  });

  it('test_null_payload_ends_the_timeline_without_editing_prior_rows', async () => {
    await record('CA', '2026-01-01', null, '2026-01-01');
    await supersede(db, {
      table: 'employment_records',
      companyId: CO,
      key: { employee_id: JANE },
      payload: null,
      validFrom: d('2026-06-01'),
      validTo: null,
      now: d('2026-06-01'),
    });

    expect(await beliefAt(d('2026-07-01'))).toEqual(['CA:2026-01-01..2026-06-01']);
    // The original open-ended belief is still readable before the termination.
    expect(await beliefAt(d('2026-05-01'))).toEqual(['CA:2026-01-01..open']);
  });
});

describe('sliceAround', () => {
  it('test_assertion_covering_whole_row_leaves_no_remnants', () => {
    expect(sliceAround(d('2026-03-01'), d('2026-04-01'), d('2026-01-01'), null)).toEqual([]);
  });

  it('test_open_row_sliced_by_open_assertion_leaves_only_leading', () => {
    expect(sliceAround(d('2026-01-01'), null, d('2026-06-01'), null)).toEqual([
      [d('2026-01-01'), d('2026-06-01')],
    ]);
  });

  it('test_open_row_sliced_by_closed_assertion_leaves_both_sides', () => {
    expect(sliceAround(d('2026-01-01'), null, d('2026-04-01'), d('2026-07-01'))).toEqual([
      [d('2026-01-01'), d('2026-04-01')],
      [d('2026-07-01'), null],
    ]);
  });
});

/**
 * The repeated-edit tests above use employment_records, where `id` is unique per
 * version. That shape cannot expose a primitive that closes every version sharing an
 * id. assignment_rules has the other shape (versions share a timeline key), so the
 * same scenarios must run against it too. This gap is what let the second-edit bug
 * survive the first review.
 */
describe('supersede on a versioned-timeline table', () => {
  const RULE = '00000000-0000-0000-0000-0000000000r1'.replace(/[^0-9a-f-]/g, '1');

  beforeEach(async () => {
    await db.exec(`
      CREATE TABLE assignment_rules (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        company_id UUID NOT NULL,
        rule_id UUID NOT NULL,
        name TEXT NOT NULL,
        priority INT NOT NULL,
        valid TSTZRANGE NOT NULL,
        system TSTZRANGE NOT NULL,
        EXCLUDE USING gist (
          company_id WITH =, rule_id WITH =, valid WITH &&, system WITH &&
        )
      );
    `);
  });

  async function editRule(priority: number, from: string, now: string) {
    await supersede(db, {
      table: 'assignment_rules',
      companyId: CO,
      key: { rule_id: RULE },
      payload: { name: 'CA meal break', priority },
      validFrom: d(from),
      validTo: null,
      now: d(now),
    });
  }

  it('test_repeated_rule_edits_on_shared_timeline_key_do_not_collide', async () => {
    await editRule(10, '2026-01-01', '2026-01-01');
    await editRule(20, '2026-01-01', '2026-02-01');
    await expect(editRule(30, '2026-01-01', '2026-03-01')).resolves.not.toThrow();

    const { rows } = await db.query<{ priority: number }>(
      `SELECT priority FROM assignment_rules
        WHERE rule_id = $1 AND upper_inf(system)`,
      [RULE],
    );
    expect(rows.map((r) => r.priority)).toEqual([30]);
  });

  it('test_superseded_rule_versions_remain_readable_at_earlier_system_time', async () => {
    await editRule(10, '2026-01-01', '2026-01-01');
    await editRule(20, '2026-01-01', '2026-02-01');
    await editRule(30, '2026-01-01', '2026-03-01');

    for (const [systemAt, expected] of [
      ['2026-01-15', 10],
      ['2026-02-15', 20],
      ['2026-03-15', 30],
    ] as const) {
      const { rows } = await db.query<{ priority: number }>(
        `SELECT priority FROM assignment_rules
          WHERE rule_id = $1 AND system @> $2::timestamptz`,
        [RULE, d(systemAt)],
      );
      expect(rows.map((r) => r.priority)).toEqual([expected]);
    }
  });

  it('test_closed_versions_are_never_rewritten_by_a_later_edit', async () => {
    // Shaped the way assignment_rules used to be: `id` is the timeline key, so a
    // naive "close the affected rows" UPDATE reaches every version ever recorded.
    // The upper_inf(system) predicate is what makes that unreachable.
    await db.exec(`
      CREATE TABLE bad_shape (
        id UUID NOT NULL,
        company_id UUID NOT NULL,
        note TEXT,
        valid TSTZRANGE NOT NULL,
        system TSTZRANGE NOT NULL,
        EXCLUDE USING gist (company_id WITH =, id WITH =, valid WITH &&, system WITH &&)
      );
    `);
    const write = (note: string, now: string) =>
      supersede(db, {
        table: 'bad_shape',
        companyId: CO,
        key: { id: RULE },
        payload: { note },
        validFrom: d('2026-01-01'),
        validTo: null,
        now: d(now),
      });

    await write('v1', '2026-01-01');
    await write('v2', '2026-02-01');
    await expect(write('v3', '2026-03-01')).resolves.not.toThrow();

    const { rows } = await db.query<{ note: string; closed: string | null }>(
      `SELECT note, to_char(upper(system), 'YYYY-MM-DD') AS closed
         FROM bad_shape ORDER BY lower(system)`,
    );
    // v1 must still show the moment v2 replaced it, not the moment v3 did.
    expect(rows).toEqual([
      { note: 'v1', closed: '2026-02-01' },
      { note: 'v2', closed: '2026-03-01' },
      { note: 'v3', closed: null },
    ]);
  });
});

/**
 * Regression for the third review's P0. The general property is stronger than the
 * reported case and worth stating as an invariant:
 *
 *   An edit effective from T must not change resolution for any date before T.
 *
 * Slicing a rule's valid range for a future-effective edit re-inserts the earlier
 * segment. If anything resolution reads is regenerated on that re-insert, history
 * silently rewrites itself.
 */
describe('edits effective in the future do not disturb the past', () => {
  const RULE_A = '00000000-0000-0000-0000-00000000000a';

  beforeEach(async () => {
    await db.exec(`
      CREATE TABLE tiebreak_rules (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        company_id UUID NOT NULL,
        rule_id UUID NOT NULL,
        name TEXT NOT NULL,
        priority INT NOT NULL,
        rule_created_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        valid TSTZRANGE NOT NULL,
        system TSTZRANGE NOT NULL,
        EXCLUDE USING gist (
          company_id WITH =, rule_id WITH =, valid WITH &&, system WITH &&
        )
      );
    `);
  });

  it('test_future_effective_rename_preserves_rule_created_at_on_earlier_segment', async () => {
    await supersede(db, {
      table: 'tiebreak_rules',
      companyId: CO,
      key: { rule_id: RULE_A },
      payload: { name: 'A', priority: 10, rule_created_at: d('2026-01-01') },
      validFrom: d('2026-01-01'),
      validTo: null,
      now: d('2026-01-01'),
    });

    // Rename, effective June. March must be untouched.
    await supersede(db, {
      table: 'tiebreak_rules',
      companyId: CO,
      key: { rule_id: RULE_A },
      payload: { name: 'A renamed', priority: 10, rule_created_at: d('2026-01-01') },
      validFrom: d('2026-06-01'),
      validTo: null,
      now: d('2026-09-01'),
    });

    const { rows } = await db.query<{ name: string; authored: string }>(
      `SELECT name, to_char(rule_created_at, 'YYYY-MM-DD') AS authored
         FROM tiebreak_rules
        WHERE upper_inf(system) AND valid @> $1::timestamptz`,
      [d('2026-03-01')],
    );

    // The March segment keeps January authorship, so its tie-break rank is unchanged.
    expect(rows).toEqual([{ name: 'A', authored: '2026-01-01' }]);
  });

  it('test_remnant_created_at_is_row_metadata_and_may_differ', async () => {
    // Documents the boundary: created_at legitimately changes on a remnant. That is
    // exactly why nothing resolution reads may live in it.
    await supersede(db, {
      table: 'tiebreak_rules',
      companyId: CO,
      key: { rule_id: RULE_A },
      payload: { name: 'A', priority: 10, rule_created_at: d('2026-01-01') },
      validFrom: d('2026-01-01'),
      validTo: null,
      now: d('2026-01-01'),
    });
    await supersede(db, {
      table: 'tiebreak_rules',
      companyId: CO,
      key: { rule_id: RULE_A },
      payload: { name: 'A2', priority: 10, rule_created_at: d('2026-01-01') },
      validFrom: d('2026-06-01'),
      validTo: null,
      now: d('2026-09-01'),
    });

    const { rows } = await db.query<{ n: number }>(
      `SELECT count(DISTINCT rule_created_at)::int AS n FROM tiebreak_rules WHERE upper_inf(system)`,
    );
    expect(rows[0].n).toBe(1);
  });
});
