/**
 * Reconciliation asserts over segments, not over an open-ended range.
 *
 * A job with `effectiveAt = T` computes the desired state at T. That is a claim about T,
 * not about a date on the far side of a boundary it already knows about. So cut
 * [T, ...) at every instant something could change, resolve at the start of each piece,
 * and assert each piece over its own bounded range. Job arrival order then stops
 * mattering.
 *
 * Two corrections to the first version of this file, both found by review:
 *
 *   1. Boundaries were collected from range STARTS only, so a membership that ended
 *      contributed nothing and a delayed job resurrected a revoked assignment. Sources
 *      are now ranges rather than dates, and both edges are collected. Passing only
 *      starts is no longer expressible.
 *
 *   2. A fixed two-year horizon CLOSED the final segment, so reconciling an old date
 *      published a range that had already expired by the time anyone read it, and the
 *      scheduler had no reason to extend it. The final segment is now open-ended
 *      whenever nothing is known to change after the last boundary, which is the common
 *      case. Truncation is by boundary count, and when it truncates it returns a
 *      `continueAt` the caller MUST schedule. A capped range and an open range are
 *      different claims, and only one of them can be made silently.
 */

export interface Range {
  from: Date;
  /** null means open-ended. */
  to: Date | null;
}

export interface BoundarySources {
  /** Open `employment_records` valid ranges for this employee. */
  factRanges: Range[];
  /** Open `assignment_rules` valid ranges for rules that could touch this employee. */
  ruleRanges: Range[];
  /** Open `group_memberships` valid ranges. Ends matter as much as starts. */
  membershipRanges: Range[];
  /**
   * Already-published `resolved_assignments` valid ranges. Without these, a late job
   * does not error, it silently swallows a later conclusion, which is worse.
   */
  publishedRanges: Range[];
  /** Tenure thresholds after T, from nextMaterialDate over active rules. */
  tenureThresholds: Date[];
}

/** Both edges of every range, plus the bare thresholds. Finite bounds only. */
export function boundariesFrom(s: BoundarySources): Date[] {
  const out: Date[] = [...s.tenureThresholds];
  for (const group of [s.factRanges, s.ruleRanges, s.membershipRanges, s.publishedRanges]) {
    for (const r of group) {
      out.push(r.from);
      if (r.to !== null) out.push(r.to);
    }
  }
  return out;
}

/**
 * Upper bound on segments materialised in one run. A cap on work, not on time: an
 * employee with a rule referencing a 25-year threshold produces two segments, which is
 * cheap, so capping by horizon punished the wrong thing.
 */
export const MAX_SEGMENTS_PER_RUN = 50;

export interface SegmentPlan {
  segments: [Date, Date | null][];
  /**
   * Non-null when boundaries were truncated. The caller MUST enqueue a reconciliation at
   * this instant, or the timeline stops there. Returned rather than handled internally so
   * a caller cannot forget it without ignoring a value.
   */
  continueAt: Date | null;
}

export function planSegments(
  from: Date,
  boundaries: Date[],
  maxSegments: number = MAX_SEGMENTS_PER_RUN,
): SegmentPlan {
  const cuts = [...new Set(
    boundaries.filter((b) => b.getTime() > from.getTime()).map((b) => b.getTime()),
  )].sort((a, b) => a - b);

  if (cuts.length < maxSegments) {
    // Everything known fits. The final segment is open-ended because nothing is known
    // to change after the last boundary.
    return { segments: segmentize(from, cuts.map((t) => new Date(t)), null), continueAt: null };
  }

  const taken = cuts.slice(0, maxSegments - 1).map((t) => new Date(t));
  const continueAt = taken[taken.length - 1];
  return { segments: segmentize(from, taken, continueAt), continueAt };
}

/**
 * Cut [from, horizon) at each boundary. Boundaries at or before `from`, and at or after
 * `horizon`, are ignored. A null horizon leaves the final segment open-ended.
 */
export function segmentize(
  from: Date,
  boundaries: Date[],
  horizon: Date | null,
): [Date, Date | null][] {
  const cuts = [...new Set(
    boundaries
      .filter((b) => b.getTime() > from.getTime())
      .filter((b) => horizon === null || b.getTime() < horizon.getTime())
      .map((b) => b.getTime()),
  )].sort((a, b) => a - b);

  const edges: (Date | null)[] = [from, ...cuts.map((t) => new Date(t)), horizon];
  const out: [Date, Date | null][] = [];
  for (let i = 0; i < edges.length - 1; i++) out.push([edges[i] as Date, edges[i + 1]]);
  return out;
}
