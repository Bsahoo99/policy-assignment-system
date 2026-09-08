# Policy Assignment System — Design Notes

## Data model

All fact tables are **bi-temporal**: they carry two ranges, `valid` (when the fact was true in the real world) and `system` (when the system believed it). GiST exclusion constraints prevent overlapping rows on both axes. `src/temporal.ts` provides `supersede()`, the single primitive for writing bi-temporal rows. It locks open rows, closes their `system` range, re-inserts any `valid`-range remnants the new assertion does not cover, and inserts the new fact. `valid` is never edited in place; every correction is a supersession. No `INSERT`/`UPDATE` against `valid` or `system` exists outside `src/temporal.ts`.

## Predicate language

One DSL, two compilers. `evaluate()` walks the predicate tree in memory and returns a match plus a `TraceNode` explanation tree. `toSql()` compiles the same predicate to a parameterized SQL `WHERE` fragment that can be pushed into Postgres. Property tests (`fast-check`) assert the two compilers agree on generated predicates and generated employee states, including boundary dates and `NULL` handling. `NOT` uses `NOT COALESCE(inner, FALSE)` so SQL `NULL` semantics match the in-memory evaluator.

## Resolver

`resolveSlot` filters rules to the slot, applies the predicate, and sorts matches by `(source='manual' first, priority DESC, rule_created_at ASC, rule_id ASC)`. Manual precedes priority: an ordering position is an invariant, while a priority ceiling would be a convention every write path had to maintain — the API default of `priority: 0` already broke it once. `priority` still orders manual rules against each other and automatic rules against each other. Every term is stable across versions of the same rule (DECISIONS.md D9). For `exactly_one`/`at_most_one` slots the top match wins; for `many` slots the highest-ranked rule per target wins. Manual `deny` rules can remove grants. All matched and shadowed rules carry their evaluation trace.

## Reconciliation

Reconciliation is **level-triggered** and **segmentized**. For each affected employee we rebuild the desired assignment set from source facts and rules — but a job with `effectiveAt = T` only knows what is true *at T*. It knows nothing about a date on the far side of a boundary it already knows about, so it must not assert over `[T, ∞)`.

`src/segments.ts` cuts `[T, …)` at every instant something could change and `reconcileEmployee` resolves at the start of each segment and asserts each piece over its own bounded `[from, to)`. Boundary sources are collected as **ranges** (`{from, to}`), not dates — both edges matter. A membership revoked on June 1 has a finite *end*; collecting only `lower(valid)` meant a delayed job never cut the timeline at the revocation and resurrected the assignment. The `Range[]` source type makes "pass only the starts" unrepresentable.

The five sources: open `employment_records`, `assignment_rules`, `group_memberships`, and `resolved_assignments` ranges with an edge after T, plus tenure thresholds from `nextMaterialDate`. Published ranges are load-bearing: without them a delayed older job silently swallows a later published segment instead of stopping at it. This is what "level-triggered so job ordering doesn't matter" actually requires — level-triggered recompute over the wrong time range is still the wrong answer.

`planSegments` caps by **boundary count** (`MAX_SEGMENTS_PER_RUN = 50`), not by time. When everything known fits, the final segment is **open-ended** — the common case, and it cannot expire. (The earlier fixed-horizon version closed the final segment, so reconciling an old date published a range that had already lapsed by the time it was read, and `nextMaterialDate` had no reason to extend it.) When the cap is hit the plan closes at the last boundary taken and returns `continueAt`, which the caller enqueues as a `resolve-assignment` job — a truncated range and an open range are different claims, and only one of them may be made silently.

Only differences are written through `supersede()`. Starting an assignment inserts a new row; ending one uses `supersede()` with `payload: null` over that segment. Audit events are emitted inside the reconcile transaction; downstream `resolve-assignment` jobs (manager cascade) are sent after the write transaction commits.

## Candidate selection

When a rule is created, edited, or deleted we do not reconcile the whole company. `candidatesForRuleChange` computes the union of:

1. Employees matching the **old** criteria (so employees who no longer match are still dirtied).
2. Employees matching the **new** criteria.
3. Employees with a currently-open `resolved_assignments` row whose `winning_rule_id` is the changed rule.
4. For `manager`-slot changes, the **outgoing and incoming manager employees** (they can cross the zero-direct-report boundary and gain/lose manager-dependent assignments).

Group membership changes follow the same rule: the candidate set includes the removed member, not just employees who still match the group. This was the fourth instance of a recurring failure mode in this codebase — forgetting the before-state — which is why it is called out here.

Each set is computed by compiling the predicate to SQL against an `employee_state` view that exposes scalar fields, `tenure_start_date`, derived `direct_report_count`, and `group_keys` (static memberships plus dynamic groups evaluated via the same `toSql` compiler).

## Time-based changes

`nextMaterialDate` computes the earliest future time at which a rule's predicate could flip for an employee. Today only `gte_tenure` contributes a material date; `employee_next_material_date` stores the earliest such date per employee. `recomputeNextMaterialDate()` is called inside every reconcile and every rule/record/group mutation so the schedule stays accurate.

Rules are never handed to `nextMaterialDate` raw — `nextMaterialDateForRule` first runs `expandDynamicGroups`, which substitutes a dynamic group's criteria into `in_group` references. A rule that is just `in_group('two-year-club')` contains no tenure node itself; the threshold lives one level down inside the group definition, and without expansion no anniversary job is ever scheduled. Static groups pass through untouched (their membership changes by write, which already produces an event and a boundary). Expansion is a single pass that terminates by construction — D11 forbids `in_group` inside a dynamic group predicate, and `expandDynamicGroups` asserts that rather than trusting it. Expansion is for scheduling and boundary collection only; evaluation still uses `in_group` against derived `group_keys`, which handles both group kinds uniformly. A `dispatch-material-dates` worker polls `employee_next_material_date` for due rows, enqueues `resolve-assignment` with `effective_at = stored next_at` (not the dispatch time), and clears the row.

## AI authoring

Anthropic is used **only at rule-authoring time** to propose a predicate from a natural-language description. The output is validated with Zod and `validateGroupPredicate`, compiled with `toSql` as a dry run, and returned to the user for review/edit before it is written. AI is never consulted during resolution or reconciliation.

## Multi-tenancy

Every table carries `company_id`. Query predicates are scoped by `company_id`; the only company-wide reads are worker maintenance loops that aggregate across tenants by design. All employee lookup is `company_id + employee_id`.

## Testing

`PGlite` provides an embedded Postgres with real `tstzrange`, `make_interval`, `to_char`, and `date` semantics, including the `btree_gist` extension needed for the schema's exclusion constraints. Property tests cover compiler agreement; unit tests cover resolver determinism, state reads, reconciliation mutation, candidate selection, scheduling, and read-path safety. Audit coverage is complete for rule, fact, membership, slot-dependency, and group writes.

## A note on where the bugs were

Across the review passes, the defects that survived were almost never inside a component — they lived at the boundary between two correct pieces: `TIMELINE_KEYS` hand-synced with column names, `created_at`/`id` doing double duty as stable tie-break keys, reconciliation asserting `[T, ∞)` over facts it only knew at `T`, boundary collection asking for `Date[]` when it needed ranges, `priority` ordered before `source` in the comparator, and a tenure threshold hidden inside a group definition one level down. The durable fix each time was the same: make the wrong call unrepresentable (`Range[]` sources, `rule_created_at` stored per version, manual-first ordering, `continueAt` returned so it cannot be silently dropped) rather than relying on a convention someone has to remember. That is the developer-experience argument this codebase makes.

## Transactions

`Db` adapters returned by `getDb()` expose `withTransaction`. On `pg` this binds a single `PoolClient`; on PGlite it uses `pglite.transaction()`. Every write path — `supersede()`, audit insert, and queue send — takes the transactional `tx` as its `Db`. A `Queue` bound to `tx` makes `pg-boss` enqueues commit atomically with the write transaction. No code reaches for the pool inside a transaction.

Every `audit_events` insert shares a transaction with the write it describes — group creation, slot dependencies, record/rule/membership writes, and reconcile all insert audit inside `runTx`. This was a repeated failure mode, so it is now a rule: if an audit insert is a separate statement from the write, it is a bug.

## Two-time reads

The explain and simulate APIs accept `valid_at` and `system_at` independently. `explainEmployee(validAt, systemAt?)` reads the resolved-assignment row that was believed at `systemAt` and effective at `validAt`. `simulateEmployee(..., patch?)` builds a hypothetical `EmployeeState` by applying the patch over the current one, resolves against it, and diffs against current resolved state without writing rows.

## Runtime split

- `npm run dev` / `npm run build` — embedded PGlite when `DATABASE_URL` is absent. Schema auto-applies; `memoryQueue` records jobs and `drainMemoryQueue` processes them synchronously after each write, so UI changes reconcile inline.
- `npm run worker` — `pg-boss` worker against real Postgres; processes `resolve-assignment`, `recompute-material-dates`, and `dispatch-material-dates`.
- `npm run demo` — scripted Jane journey including a retroactive correction and a time-travel explain.

## UI scope

Implemented: employees list/detail, assignment history, explain trace, record edit with impact preview, simulate, manual override (with per-slot target picker), rule list/create/AI author, rule-impact preview (candidate set before save), group membership add (removal is API-only), audit feed, and a global valid_at/system_at picker in the header that threads through the employee and rules screens. A structured rule builder covers the common predicate forms — equals, in, tenure, group, and manager — with a live match count and an equal-priority collision warning. Onboarding preview simulates a hypothetical new hire without creating rows.

Design-only (not built): an arbitrary predicate-AST editor with nested `and`/`or`/`not` composition, a full onboarding wizard, and an existing-rule edit form — rule editing remains API-only (`PATCH /api/rules/[id]`). The predicate DSL is intentionally restricted to the operators that compile to both in-memory and SQL evaluation, so a generic AST editor would expose more surface than the resolver supports.

## Demo

`npm run demo` runs the five-step Jane journey: initial reconcile, tenure-driven vacation, relocation to Canada, retroactive correction of the move date, and an explain of the same valid date at two different system times showing two different payroll schedules. This is the visible proof that the bi-temporal model is real.
