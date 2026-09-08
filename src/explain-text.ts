/**
 * Traces to sentences.
 *
 * Two jobs: replace the raw JSON on employee detail (explainability to non-engineers is
 * a graded criterion), and answer "why NOT", which is the ticket an HR admin actually
 * files. Both read what resolution already produced. No new engine work.
 *
 * REWRITTEN after review. The first version treated negation as a string prefix on a
 * node's `detail` and walked leaves by their own matched flag. Both were wrong:
 *
 *   - a satisfied `NOT contractors` rule reported no reasons at all, because the leaf
 *     underneath it had matched=false, so it read as "applies to everyone"
 *   - a nested exclusion negated the composite node instead of its leaves, so the text
 *     came out as "2/2 conditions met"
 *
 * The correct model is polarity. To explain why a node has value V, recurse asking each
 * child why it has the value that produced V, flipping polarity through `not`. A leaf is
 * then rendered from two independent facts: whether its own condition holds, and whether
 * it sits under an odd number of negations.
 */

import type { TraceNode, Predicate } from './predicate.js';

const FIELD_LABEL: Record<string, string> = {
  department: 'department',
  location_state: 'work state',
  location_country: 'work country',
  employment_type: 'employment type',
  pay_type: 'pay type',
};

interface Reason {
  node: TraceNode;
  negated: boolean;
}

/** Why a rule matched. */
export function describeMatch(trace: TraceNode): string[] {
  return trace.matched ? why(trace, true, false).map(render) : [];
}

/**
 * Why a rule did not match: the conditions actually responsible, not every condition in
 * the rule. For an `and`, only the failing branches; for an `or`, all of them. Blaming
 * satisfied conditions is how a "why not" answer becomes noise instead of an answer.
 */
export function describeFailure(trace: TraceNode): string[] {
  return trace.matched ? [] : why(trace, false, false).map(render);
}

/** One line an admin can read at a glance. */
export function summarize(trace: TraceNode): string {
  const parts = trace.matched ? describeMatch(trace) : describeFailure(trace);
  if (parts.length === 0) return trace.matched ? 'Applies to everyone.' : 'Did not match.';
  return parts.join(trace.matched ? ' and ' : ', and ') + '.';
}

/**
 * Leaves explaining why `n` has the value `expected`.
 * `negated` tracks whether we are under an odd number of `not` nodes.
 */
function why(n: TraceNode, expected: boolean, negated: boolean): Reason[] {
  switch (n.op) {
    case 'always':
      return [];

    case 'and':
      return expected
        // Everything had to hold, so everything is a reason.
        ? (n.children ?? []).flatMap((c) => why(c, true, negated))
        // Only the branches that failed are at fault.
        : (n.children ?? []).filter((c) => !c.matched).flatMap((c) => why(c, false, negated));

    case 'or':
      return expected
        ? (n.children ?? []).filter((c) => c.matched).flatMap((c) => why(c, true, negated))
        // Every branch failed, so every branch is part of the answer.
        : (n.children ?? []).flatMap((c) => why(c, false, negated));

    case 'not': {
      const child = (n.children ?? [])[0];
      if (!child) return [];
      // n.matched === !child.matched, so explaining n at `expected` means explaining the
      // child at the opposite value, one negation deeper.
      return why(child, !expected, !negated);
    }

    default:
      return [{ node: n, negated }];
  }
}

/**
 * Rendered from two independent facts: whether the condition itself holds
 * (`node.matched`) and whether it is being excluded (`negated`). Unrecognised shapes
 * fall through to the developer wording rather than vanishing, so a new predicate
 * degrades the sentence instead of erasing the explanation.
 */
function render({ node, negated }: Reason): string {
  const d = node.detail;
  const holds = node.matched;

  const attr = /^(\w+) is (.+?), needs (.+)$/.exec(d);
  if (attr) {
    const [, field, actual, needed] = attr;
    const label = FIELD_LABEL[field] ?? field;
    if (negated) {
      return holds
        ? `their ${label} is ${actual}, which this rule excludes`
        : `their ${label} is not ${needed}`;
    }
    if (actual === 'unset') return `their ${label} is not set, and this rule needs ${needed}`;
    return holds
      ? `their ${label} is ${actual}`
      : `their ${label} is ${actual}, but this rule needs ${needed}`;
  }

  const tenure = /^reaches (\d+)y tenure on (.+)$/.exec(d);
  if (tenure) {
    const [, years, date] = tenure;
    if (negated) {
      return holds
        ? `they passed ${years} years of tenure on ${date}, which this rule excludes`
        : `they have not yet reached ${years} years of tenure, due ${date}`;
    }
    return holds
      ? `they reached ${years} years of tenure on ${date}`
      : `this rule needs ${years} years of tenure, reached on ${date}`;
  }

  const group = /^member of (.+): (?:true|false)$/.exec(d);
  if (group) {
    const [, name] = group;
    if (negated) {
      return holds
        ? `they are in the ${name} group, which this rule excludes`
        : `they are not in the ${name} group`;
    }
    return holds ? `they are in the ${name} group` : `they are not in the ${name} group`;
  }

  const mgr = /^(\d+) direct reports$/.exec(d);
  if (mgr) {
    const [, count] = mgr;
    if (negated) {
      return holds
        ? `they manage ${count} people, which this rule excludes`
        : `they do not manage anyone`;
    }
    return holds
      ? `they manage ${count} people`
      : `they do not manage anyone, and this rule is for managers`;
  }

  return d;
}

/** The "why not" entry point for one target the employee does not have. */
export interface WhyNot {
  targetName: string;
  reasons: { ruleName: string; because: string }[];
}

export function whyNot(
  targetName: string,
  candidates: { ruleName: string; trace: TraceNode }[],
): WhyNot {
  return {
    targetName,
    reasons: candidates.map((c) => ({ ruleName: c.ruleName, because: summarize(c.trace) })),
  };
}

export type { Predicate };
