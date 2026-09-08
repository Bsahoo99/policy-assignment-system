import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { supersede, type Db } from '../src/temporal.js';
import { segmentize, planSegments, boundariesFrom, MAX_SEGMENTS_PER_RUN } from '../src/segments.js';

let db: PGlite & Db;

const CO = '00000000-0000-0000-0000-0000000000c0';
const EMP = '00000000-0000-0000-0000-00000000ffe1';
const SLOT = '00000000-0000-0000-0000-00000000ff51';

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

beforeEach(async () => {
  db = (await PGlite.create({ extensions: { btree_gist } })) as PGlite & Db;
  await db.exec(`
    SET TIME ZONE 'UTC';
    CREATE EXTENSION IF NOT EXISTS btree_gist;
    CREATE TABLE resolved_assignments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id UUID NOT NULL,
      employee_id UUID NOT NULL,
      slot_id UUID NOT NULL,
      target_name TEXT NOT NULL,
      valid TSTZRANGE NOT NULL,
      system TSTZRANGE NOT NULL,
      EXCLUDE USING gist (
        company_id WITH =, employee_id WITH =, slot_id WITH =,
        valid WITH &&, system WITH &&
      )
    );
  `);
});

afterAll(async () => {
  await db?.close();
});

/** One reconciliation job: assert `target` over exactly [from, to). */
async function publish(target: string, from: string, to: string | null, now: string) {
  await supersede(db, {
    table: 'resolved_assignments',
    companyId: CO,
    key: { employee_id: EMP, slot_id: SLOT },
    payload: { target_name: target },
    validFrom: d(from),
    validTo: to ? d(to) : null,
    now: d(now),
  });
}

async function timeline() {
  const { rows } = await db.query<{ t: string; f: string; u: string | null }>(
    `SELECT target_name AS t,
            to_char(lower(valid), 'YYYY-MM-DD') AS f,
            to_char(upper(valid), 'YYYY-MM-DD') AS u
       FROM resolved_assignments
      WHERE upper_inf(system) ORDER BY lower(valid)`,
  );
  return rows.map((r) => `${r.t}:${r.f}..${r.u ?? 'open'}`);
}

describe('out-of-order reconciliation', () => {
  it('test_delayed_older_job_does_not_overwrite_a_later_transition', async () => {
    // The reviewer's reproduction. The 2026 tenure transition is processed first.
    await publish('Senior Vacation', '2026-01-01', null, '2026-01-01');

    // Then a delayed job for 2025 arrives. Its conclusion is only good until the
    // boundary it already knows about, so it asserts [2025-01-01, 2026-01-01).
    await expect(publish('Standard Vacation', '2025-01-01', '2026-01-01', '2026-02-01'))
      .resolves.not.toThrow();

    expect(await timeline()).toEqual([
      'Standard Vacation:2025-01-01..2026-01-01',
      'Senior Vacation:2026-01-01..open',
    ]);
  });

  it('test_same_result_regardless_of_job_arrival_order', async () => {
    // Order A: newer first, then older.
    await publish('Senior Vacation', '2026-01-01', null, '2026-01-01');
    await publish('Standard Vacation', '2025-01-01', '2026-01-01', '2026-02-01');
    const orderA = await timeline();

    // Order B: older first, then newer. Fresh database.
    await db.close();
    db = (await PGlite.create({ extensions: { btree_gist } })) as PGlite & Db;
    await db.exec(`
      SET TIME ZONE 'UTC';
    CREATE EXTENSION IF NOT EXISTS btree_gist;
      CREATE TABLE resolved_assignments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        company_id UUID NOT NULL, employee_id UUID NOT NULL, slot_id UUID NOT NULL,
        target_name TEXT NOT NULL, valid TSTZRANGE NOT NULL, system TSTZRANGE NOT NULL,
        EXCLUDE USING gist (company_id WITH =, employee_id WITH =, slot_id WITH =,
                            valid WITH &&, system WITH &&)
      );
    `);
    await publish('Standard Vacation', '2025-01-01', '2026-01-01', '2025-01-01');
    await publish('Senior Vacation', '2026-01-01', null, '2026-01-01');

    expect(await timeline()).toEqual(orderA);
  });

  it('test_unbounded_assertion_swallows_a_later_segment', async () => {
    // Documents why segment bounds are load-bearing rather than tidiness. This is the
    // old behaviour: the 2026 conclusion is silently destroyed, with no error raised.
    await publish('Senior Vacation', '2026-01-01', null, '2026-01-01');
    await publish('Standard Vacation', '2025-01-01', null, '2026-02-01');

    expect(await timeline()).toEqual(['Standard Vacation:2025-01-01..open']);
  });
});

describe('segmentize', () => {
  it('test_no_boundaries_produces_one_open_segment', () => {
    expect(segmentize(d('2026-01-01'), [], null)).toEqual([[d('2026-01-01'), null]]);
  });

  it('test_boundaries_cut_the_range_in_order', () => {
    expect(segmentize(d('2025-01-01'), [d('2026-01-01'), d('2025-06-01')], null)).toEqual([
      [d('2025-01-01'), d('2025-06-01')],
      [d('2025-06-01'), d('2026-01-01')],
      [d('2026-01-01'), null],
    ]);
  });

  it('test_boundaries_at_or_before_start_are_ignored', () => {
    expect(segmentize(d('2026-01-01'), [d('2025-01-01'), d('2026-01-01')], null)).toEqual([
      [d('2026-01-01'), null],
    ]);
  });

  it('test_duplicate_boundaries_collapse', () => {
    expect(segmentize(d('2025-01-01'), [d('2026-01-01'), d('2026-01-01')], null)).toEqual([
      [d('2025-01-01'), d('2026-01-01')],
      [d('2026-01-01'), null],
    ]);
  });

  it('test_explicit_horizon_closes_the_final_segment_and_clips_beyond', () => {
    const h = d('2027-01-01');
    expect(segmentize(d('2026-01-01'), [d('2026-06-01'), d('2030-01-01')], h)).toEqual([
      [d('2026-01-01'), d('2026-06-01')],
      [d('2026-06-01'), h],
    ]);
  });
});

describe('boundary collection', () => {
  const range = (from: string, to: string | null) => ({ from: d(from), to: to ? d(to) : null });
  const empty = { factRanges: [], ruleRanges: [], membershipRanges: [], publishedRanges: [], tenureThresholds: [] };

  it('test_membership_end_date_is_collected_as_a_boundary', () => {
    // The finding: a revoked membership has a finite END. Collecting only starts meant
    // a delayed job never cut the timeline at the revocation and resurrected the app.
    const b = boundariesFrom({ ...empty, membershipRanges: [range('2025-01-01', '2026-03-01')] });
    expect(b.map((x) => x.toISOString().slice(0, 10)).sort()).toEqual(['2025-01-01', '2026-03-01']);
  });

  it('test_open_ended_range_contributes_only_its_start', () => {
    const b = boundariesFrom({ ...empty, factRanges: [range('2025-01-01', null)] });
    expect(b).toHaveLength(1);
  });

  it('test_every_source_contributes_both_edges', () => {
    const b = boundariesFrom({
      factRanges: [range('2020-01-01', '2021-01-01')],
      ruleRanges: [range('2022-01-01', '2023-01-01')],
      membershipRanges: [range('2024-01-01', '2025-01-01')],
      publishedRanges: [range('2026-01-01', '2027-01-01')],
      tenureThresholds: [d('2028-01-01')],
    });
    expect(b).toHaveLength(9);
  });
});

describe('planSegments', () => {
  it('test_ongoing_assignment_stays_open_ended_and_does_not_expire', () => {
    // The finding: reconciling Jan 2024 under an always-applicable rule used to publish
    // a range that had already expired by March 2026, with nothing scheduled to extend it.
    const plan = planSegments(d('2024-01-01'), []);
    expect(plan.segments).toEqual([[d('2024-01-01'), null]]);
    expect(plan.continueAt).toBeNull();

    const [, end] = plan.segments[plan.segments.length - 1];
    expect(end).toBeNull(); // still covers "now", whenever now is
  });

  it('test_known_boundaries_still_leave_the_last_segment_open', () => {
    const plan = planSegments(d('2024-01-01'), [d('2026-01-01')]);
    expect(plan.segments).toEqual([
      [d('2024-01-01'), d('2026-01-01')],
      [d('2026-01-01'), null],
    ]);
    expect(plan.continueAt).toBeNull();
  });

  it('test_truncation_closes_the_range_and_returns_a_continuation', () => {
    const many = Array.from({ length: 10 }, (_, i) => d(`2026-0${(i % 9) + 1}-01`));
    const plan = planSegments(d('2025-01-01'), many, 4);
    expect(plan.continueAt).not.toBeNull();
    // A truncated plan must never claim open-endedness it has not verified.
    expect(plan.segments[plan.segments.length - 1][1]).toEqual(plan.continueAt);
  });

  it('test_default_cap_is_not_hit_by_ordinary_populations', () => {
    const few = Array.from({ length: 5 }, (_, i) => d(`202${i}-01-01`));
    expect(planSegments(d('2019-01-01'), few).continueAt).toBeNull();
    expect(MAX_SEGMENTS_PER_RUN).toBeGreaterThan(few.length);
  });
});
