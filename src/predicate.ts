/**
 * One predicate language, two compilers.
 *
 *   evaluate() -> per-node match results, which is what the explain trace is
 *                 built from. Used when resolving a single employee.
 *   toSql()    -> a WHERE fragment, used for reverse matching: "which
 *                 employees does this rule hit?" Needed when a rule is edited,
 *                 because looping the population does not scale.
 *
 * The two must always agree. That is asserted by property test, not assumed.
 */

export type Predicate =
  | { op: 'always' }
  | { op: 'eq'; field: ScalarField; value: string }
  | { op: 'in'; field: ScalarField; values: string[] }
  | { op: 'gte_tenure'; years: number }
  | { op: 'in_group'; group: string }
  | { op: 'is_manager' }
  | { op: 'and'; children: Predicate[] }
  | { op: 'or'; children: Predicate[] }
  | { op: 'not'; child: Predicate };

export type ScalarField =
  | 'department'
  | 'location_state'
  | 'location_country'
  | 'employment_type'
  | 'pay_type';

export const SCALAR_FIELDS: ScalarField[] = [
  'department',
  'location_state',
  'location_country',
  'employment_type',
  'pay_type',
];

/** The employee facts a predicate can see, already resolved to a point in time. */
import type { EmploymentType, PayType } from './types';

export interface EmployeeState {
  employee_id: string;
  department: string | null;
  location_state: string | null;
  location_country: string;
  employment_type: EmploymentType;
  pay_type: PayType;
  tenure_start_date: string; // YYYY-MM-DD
  /** Derived, never stored: computed at asOf from the manager slot. */
  direct_report_count: number;
  /** Derived, never stored: static memberships plus dynamic group evaluation. */
  group_keys: string[];
}

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

/**
 * Postgres clamps `date + interval 'n years'` to the last day of the month,
 * so 2024-02-29 + 1 year is 2025-02-28. Plain JS setFullYear rolls over to
 * March 1 instead. Matching Postgres here is what keeps the two compilers in
 * agreement; the property test finds this immediately if it drifts.
 */
export function addYearsClamped(isoDate: string, years: number): Date {
  const [y, m, d] = isoDate.split('-').map(Number);
  const targetYear = y + years;
  const lastDayOfMonth = new Date(Date.UTC(targetYear, m, 0)).getUTCDate();
  return new Date(Date.UTC(targetYear, m - 1, Math.min(d, lastDayOfMonth)));
}

/** The exact instant an employee crosses `years` of tenure. */
export function tenureBoundary(state: EmployeeState, years: number): Date {
  return addYearsClamped(state.tenure_start_date, years);
}

// ---------------------------------------------------------------------------
// Compiler 1: in-memory, with trace
// ---------------------------------------------------------------------------

export interface TraceNode {
  op: Predicate['op'];
  matched: boolean;
  detail: string;
  children?: TraceNode[];
}

export interface MatchResult {
  matched: boolean;
  trace: TraceNode;
}

export function evaluate(p: Predicate, s: EmployeeState, asOf: Date): MatchResult {
  const node = evalNode(p, s, asOf);
  return { matched: node.matched, trace: node };
}

function evalNode(p: Predicate, s: EmployeeState, asOf: Date): TraceNode {
  switch (p.op) {
    case 'always':
      return { op: p.op, matched: true, detail: 'default rule, matches everyone' };

    case 'eq': {
      const actual = s[p.field];
      const matched = actual === p.value;
      return { op: p.op, matched, detail: `${p.field} is ${fmt(actual)}, needs ${fmt(p.value)}` };
    }

    case 'in': {
      const actual = s[p.field];
      const matched = actual !== null && p.values.includes(actual);
      return {
        op: p.op,
        matched,
        detail: `${p.field} is ${fmt(actual)}, needs one of [${p.values.join(', ')}]`,
      };
    }

    case 'gte_tenure': {
      const boundary = tenureBoundary(s, p.years);
      const matched = asOf.getTime() >= boundary.getTime();
      return {
        op: p.op,
        matched,
        detail: `reaches ${p.years}y tenure on ${boundary.toISOString().slice(0, 10)}`,
      };
    }

    case 'in_group': {
      const matched = s.group_keys.includes(p.group);
      return { op: p.op, matched, detail: `member of ${p.group}: ${matched}` };
    }

    case 'is_manager': {
      const matched = s.direct_report_count > 0;
      return { op: p.op, matched, detail: `${s.direct_report_count} direct reports` };
    }

    case 'and': {
      const children = p.children.map((c) => evalNode(c, s, asOf));
      const matched = children.every((c) => c.matched);
      return { op: p.op, matched, detail: `${children.filter((c) => c.matched).length}/${children.length} conditions met`, children };
    }

    case 'or': {
      const children = p.children.map((c) => evalNode(c, s, asOf));
      const matched = children.some((c) => c.matched);
      return { op: p.op, matched, detail: `${children.filter((c) => c.matched).length}/${children.length} conditions met`, children };
    }

    case 'not': {
      const child = evalNode(p.child, s, asOf);
      return { op: p.op, matched: !child.matched, detail: 'negated', children: [child] };
    }
  }
}

const fmt = (v: string | null) => (v === null ? 'unset' : v);

// ---------------------------------------------------------------------------
// Compiler 2: SQL, for reverse matching
// ---------------------------------------------------------------------------

export interface SqlFragment {
  text: string;
  params: unknown[];
}

/**
 * Compiles against `employee_state`, a view exposing the same shape as
 * EmployeeState for a given (asOf valid time, asOf system time).
 *
 * NOT NULL handling is explicit: a NULL department must fail `eq` and also
 * fail `not(eq)`, matching three-valued SQL logic to the JS `===` semantics
 * above. This is the single most common place the two compilers diverge.
 */
/**
 * Scalar fields resolve to column text through this map and never through
 * interpolation. Even if an unparsed predicate reached `toSql`, an unknown
 * field would raise here rather than become SQL.
 */
const COLUMN: Record<ScalarField, string> = {
  department: 'e.department',
  location_state: 'e.location_state',
  location_country: 'e.location_country',
  employment_type: 'e.employment_type',
  pay_type: 'e.pay_type',
};

function column(field: ScalarField): string {
  const c = Object.prototype.hasOwnProperty.call(COLUMN, field) ? COLUMN[field] : undefined;
  if (!c) throw new PredicateValidationError(`unknown field ${JSON.stringify(field)}`, 'field');
  return c;
}

export function toSql(p: Predicate, asOf: Date, params: unknown[] = []): SqlFragment {
  switch (p.op) {
    case 'always':
      return { text: 'TRUE', params };

    case 'eq':
      params.push(p.value);
      return { text: `(${column(p.field)} = $${params.length})`, params };

    case 'in': {
      if (p.values.length === 0) return { text: 'FALSE', params };
      params.push(p.values);
      return { text: `(${column(p.field)} = ANY($${params.length}))`, params };
    }

    case 'gte_tenure': {
      params.push(p.years);
      const yearsParam = params.length;
      params.push(asOf.toISOString());
      return {
        text: `((e.tenure_start_date + make_interval(years => $${yearsParam}::int)) <= $${params.length}::timestamptz)`,
        params,
      };
    }

    case 'in_group':
      params.push(p.group);
      return { text: `($${params.length} = ANY(e.group_keys))`, params };

    case 'is_manager':
      return { text: '(e.direct_report_count > 0)', params };

    case 'and': {
      if (p.children.length === 0) return { text: 'TRUE', params };
      const parts = p.children.map((c) => toSql(c, asOf, params).text);
      return { text: `(${parts.join(' AND ')})`, params };
    }

    case 'or': {
      if (p.children.length === 0) return { text: 'FALSE', params };
      const parts = p.children.map((c) => toSql(c, asOf, params).text);
      return { text: `(${parts.join(' OR ')})`, params };
    }

    case 'not': {
      const inner = toSql(p.child, asOf, params);
      // COALESCE collapses SQL's UNKNOWN to FALSE before negation, so
      // NOT(department = 'Sales') on a NULL department is FALSE in both
      // compilers rather than FALSE in JS and UNKNOWN in SQL.
      return { text: `(NOT COALESCE(${inner.text}, FALSE))`, params };
    }
  }
}

// ---------------------------------------------------------------------------
// Scheduling support
// ---------------------------------------------------------------------------

/**
 * Earliest future instant at which this predicate could change value for this
 * employee. Drives one scheduled job per employee instead of a nightly sweep
 * over the whole population.
 */
export function nextMaterialDate(p: Predicate, s: EmployeeState, after: Date): Date | null {
  switch (p.op) {
    case 'gte_tenure': {
      const boundary = tenureBoundary(s, p.years);
      return boundary.getTime() > after.getTime() ? boundary : null;
    }
    case 'and':
    case 'or':
      return earliest(p.children.map((c) => nextMaterialDate(c, s, after)));
    case 'not':
      return nextMaterialDate(p.child, s, after);
    default:
      return null; // attribute and group predicates flip on writes, not on time
  }
}

function earliest(dates: (Date | null)[]): Date | null {
  return dates.filter((d): d is Date => d !== null).sort((a, b) => a.getTime() - b.getTime())[0] ?? null;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Runtime validation
//
// `Predicate` is a compile-time type. Criteria arrive as JSON on an HTTP body,
// where the type system is not present, and `toSql` places `field` into the
// query text as an *identifier*. Parameterising values does not protect an
// identifier, so a predicate that has not been through `parsePredicate` must
// never reach `toSql`. Every write and preview path parses first.
// ---------------------------------------------------------------------------

export class PredicateValidationError extends Error {
  readonly path: string;
  constructor(message: string, path: string) {
    super(`${message} (at ${path || 'criteria'})`);
    this.name = 'PredicateValidationError';
    this.path = path;
  }
}

const MAX_NODES = 200;
const MAX_DEPTH = 20;
const MAX_STRING = 200;
const MAX_IN_VALUES = 500;
const MAX_TENURE_YEARS = 200;
/** Group keys reach SQL as a parameter, but keep them boring anyway. */
const GROUP_KEY = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/**
 * Parse untrusted JSON into a Predicate, or throw. Bounds tree size and depth so
 * a hostile body cannot exhaust the compiler, and allowlists every field and
 * operator rather than trusting the declared type.
 */
export function parsePredicate(input: unknown): Predicate {
  let nodes = 0;

  const str = (v: unknown, path: string, what: string): string => {
    if (typeof v !== 'string') throw new PredicateValidationError(`${what} must be a string`, path);
    if (v.length === 0) throw new PredicateValidationError(`${what} must not be empty`, path);
    if (v.length > MAX_STRING) {
      throw new PredicateValidationError(`${what} exceeds ${MAX_STRING} characters`, path);
    }
    return v;
  };

  const scalarField = (v: unknown, path: string): ScalarField => {
    const f = str(v, path, 'field');
    if (!(SCALAR_FIELDS as string[]).includes(f)) {
      throw new PredicateValidationError(
        `unknown field ${JSON.stringify(f)}; expected one of ${SCALAR_FIELDS.join(', ')}`,
        path,
      );
    }
    return f as ScalarField;
  };

  const parse = (v: unknown, path: string, depth: number): Predicate => {
    nodes += 1;
    if (nodes > MAX_NODES) {
      throw new PredicateValidationError(`predicate has more than ${MAX_NODES} nodes`, path);
    }
    if (depth > MAX_DEPTH) {
      throw new PredicateValidationError(`predicate nested deeper than ${MAX_DEPTH}`, path);
    }
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
      throw new PredicateValidationError('expected an object', path);
    }
    const n = v as Record<string, unknown>;

    switch (n.op) {
      case 'always':
        return { op: 'always' };
      case 'is_manager':
        return { op: 'is_manager' };
      case 'eq':
        return {
          op: 'eq',
          field: scalarField(n.field, `${path}.field`),
          value: str(n.value, `${path}.value`, 'value'),
        };
      case 'in': {
        if (!Array.isArray(n.values)) {
          throw new PredicateValidationError('values must be an array', `${path}.values`);
        }
        if (n.values.length > MAX_IN_VALUES) {
          throw new PredicateValidationError(
            `values exceeds ${MAX_IN_VALUES} entries`,
            `${path}.values`,
          );
        }
        return {
          op: 'in',
          field: scalarField(n.field, `${path}.field`),
          values: n.values.map((x, i) => str(x, `${path}.values[${i}]`, 'value')),
        };
      }
      case 'gte_tenure': {
        const y = n.years;
        if (typeof y !== 'number' || !Number.isInteger(y) || y < 0 || y > MAX_TENURE_YEARS) {
          throw new PredicateValidationError(
            `years must be a whole number between 0 and ${MAX_TENURE_YEARS}`,
            `${path}.years`,
          );
        }
        return { op: 'gte_tenure', years: y };
      }
      case 'in_group': {
        const g = str(n.group, `${path}.group`, 'group');
        if (!GROUP_KEY.test(g)) {
          throw new PredicateValidationError(
            'group key must be alphanumeric, with - or _',
            `${path}.group`,
          );
        }
        return { op: 'in_group', group: g };
      }
      case 'and':
      case 'or': {
        if (!Array.isArray(n.children)) {
          throw new PredicateValidationError('children must be an array', `${path}.children`);
        }
        const children = n.children.map((c, i) => parse(c, `${path}.children[${i}]`, depth + 1));
        return n.op === 'and' ? { op: 'and', children } : { op: 'or', children };
      }
      case 'not':
        return { op: 'not', child: parse(n.child, `${path}.child`, depth + 1) };
      default:
        throw new PredicateValidationError(`unknown op ${JSON.stringify(n.op)}`, path);
    }
  };

  return parse(input, '', 0);
}

/**
 * Dynamic groups may not reference groups. Prohibiting the node outright is
 * simpler than validating a group dependency graph, and costs no real
 * expressiveness: a group of groups is an `or` over the underlying criteria.
 */
export function validateGroupPredicate(p: Predicate): void {
  walk(p, (n) => {
    if (n.op === 'in_group') {
      throw new Error('in_group is not allowed inside a dynamic group definition');
    }
  });
}

export function walk(p: Predicate, fn: (n: Predicate) => void): void {
  fn(p);
  if (p.op === 'and' || p.op === 'or') p.children.forEach((c) => walk(c, fn));
  if (p.op === 'not') walk(p.child, fn);
}

/** Groups referenced by a rule, so rule edits can subscribe to membership changes. */
export function referencedGroups(p: Predicate): string[] {
  const out = new Set<string>();
  walk(p, (n) => {
    if (n.op === 'in_group') out.add(n.group);
  });
  return [...out];
}

// ---------------------------------------------------------------------------
// Group expansion
// ---------------------------------------------------------------------------

/**
 * Replace `in_group(g)` with g's criteria, for DYNAMIC groups only.
 *
 * Why this exists: a rule whose criteria is `in_group('two-year-club')` contains no
 * tenure predicate, so `nextMaterialDate` found nothing and no job was ever scheduled
 * for the anniversary. The threshold was real but it lived one level down, inside the
 * group definition. Composition hid it.
 *
 * Static groups are deliberately left alone. Their membership changes by a write, which
 * already produces an event and a boundary. Only dynamic groups can transition with no
 * write at all, which is the case scheduling exists to cover.
 *
 * Single pass terminates: D11 forbids `in_group` inside a dynamic group's predicate, so
 * an expanded predicate cannot contain another dynamic reference. The assertion below
 * enforces that rather than trusting it.
 *
 * SCOPE: use this for scheduling and boundary collection only. Evaluation must keep
 * using `in_group` against `group_keys`, which is already derived correctly and which
 * handles static and dynamic groups uniformly.
 */
export function expandDynamicGroups(
  p: Predicate,
  dynamicGroups: Map<string, Predicate>,
): Predicate {
  const out = expandOnce(p, dynamicGroups);
  walk(out, (n) => {
    if (n.op === 'in_group' && dynamicGroups.has(n.group)) {
      throw new Error(
        `expandDynamicGroups: '${n.group}' still present after expansion, so a dynamic ` +
        `group references another group. D11 forbids this; validateGroupPredicate should ` +
        `have rejected it at write time.`,
      );
    }
  });
  return out;
}

function expandOnce(p: Predicate, groups: Map<string, Predicate>): Predicate {
  switch (p.op) {
    case 'in_group':
      return groups.get(p.group) ?? p; // static groups pass through untouched
    case 'and':
      return { op: 'and', children: p.children.map((c) => expandOnce(c, groups)) };
    case 'or':
      return { op: 'or', children: p.children.map((c) => expandOnce(c, groups)) };
    case 'not':
      return { op: 'not', child: expandOnce(p.child, groups) };
    default:
      return p;
  }
}

/**
 * The scheduling entry point. Always call this rather than `nextMaterialDate` directly
 * on raw rule criteria, or thresholds reachable only through a dynamic group are missed.
 */
export function nextMaterialDateForRule(
  criteria: Predicate,
  dynamicGroups: Map<string, Predicate>,
  s: EmployeeState,
  after: Date,
): Date | null {
  return nextMaterialDate(expandDynamicGroups(criteria, dynamicGroups), s, after);
}
