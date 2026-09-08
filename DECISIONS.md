# DECISIONS.md

Locked architectural decisions for the Policy Assignment System.

**These are settled. Do not reopen them.** If implementation reveals a decision is
actually wrong (not merely different from what you would have chosen), stop, write
the specific failure it causes, and escalate to the human. Do not silently
substitute an alternative.

---

## D1. Stack

Next.js 15 (App Router) + TypeScript. Postgres. Drizzle ORM. pg-boss for the queue.
Vitest + fast-check for tests. pglite for test-time Postgres. shadcn/ui + Tailwind.

Rationale: one language across resolver and UI means the predicate types are shared
between the rule builder and the engine, which is itself a developer-experience
argument. Drizzle over Prisma specifically because this system needs raw `tstzrange`,
GiST exclusion constraints, and dynamically generated `WHERE` clauses; Prisma fights
all three.

## D2. Two time axes, not one

Every fact table carries `valid TSTZRANGE` (when the fact is true in the world) and
`system TSTZRANGE` (when we believed it).

**There is exactly one mutation operation, used for every change without exception:**

```
close system on the affected row (set its upper bound to now)
insert a new row carrying the corrected valid range and an open system range
```

The `valid` range of an existing row is never edited. This applies to ordinary
terminations as much as to retroactive corrections, and the distinction between them
is not a distinction the write path makes.

Worked example. On Jan 1 we record that Jane has Standard Vacation, `valid = [Jan 1, ∞)`.
On Mar 15 she crosses two years and moves to Senior Vacation. The Jan 1 row is *not*
edited to `[Jan 1, Mar 15)`. Instead its `system` range is closed, and two new rows are
inserted: Standard Vacation `valid = [Jan 1, Mar 15)` and Senior Vacation
`valid = [Mar 15, ∞)`, both with open system ranges. Setting system time back to
February still returns "Standard Vacation, forever", which is what we actually believed
in February.

Editing `valid` in place would silently destroy that. It is the most likely way this
system gets quietly broken.

Rationale: payroll runs against a belief. "Jane moved to CA on Aug 1, HR recorded it
Sept 4" means August payroll was computed on a belief we now know was wrong, and the
system must reconstruct both answers.

## D3. Exclusion constraints on both axes

```sql
EXCLUDE USING gist (company_id WITH =, employee_id WITH =, valid WITH &&, system WITH &&)
```

Not a partial index scoped to open system ranges. The invariant is that no two rows
are simultaneously applicable on both axes, including in historical belief states.

## D4. Multi-tenant from the first line

`company_id` on every table, inside every exclusion constraint, and in every query
predicate. There is no "add tenancy later" path in a payroll system.

## D5. Typed employment record, not EAV

`employment_records` has typed columns. Adding an attribute is a migration.

Rationale: this is what lets the predicate DSL be typed end to end and compile to
indexed SQL. State the tradeoff in the architecture doc rather than hiding it.

## D6. Cardinality lives on the slot

`assignment_slots.cardinality` is `exactly_one | at_most_one | many`. It is not a
property of an individual policy or app, because two targets in one category could
then disagree.

Be precise about what each level guarantees, because they are not the same kind of thing:

| | enforced by | on violation |
|---|---|---|
| at most one target in an exclusive slot | database exclusion constraint on `is_exclusive` | write fails |
| `exactly_one` slot is actually filled | nothing | `unassignedWarning`, surfaced to the admin |

`exactly_one` is a business requirement the system reports on, not an invariant the
resolver can guarantee. An employee with no matching manager rule genuinely has no
manager, and the correct behaviour is to say so loudly rather than to throw or to invent
one. The resolver never fabricates an assignment to satisfy a cardinality declaration.

## D7. Targets are one canonical registry

`assignment_targets` with typed subtype tables (`policy_targets`, `app_targets`,
`employee_targets`) pinned by composite foreign key on `(id, target_type)`.

Rationale: "manager" is listed in the brief as an assignment. A schema that hardcodes
`policy_id` cannot represent it without a special case.

**Corollary: the manager slot is the only source of manager authority.**
`employment_records` has no `manager_id` column. Reporting lines are resolved through
the `manager` slot like every other assignment, which means they get priority
resolution, explain traces, and bi-temporal history for free.

`direct_report_count` is therefore derived from `resolved_assignments` where the slot is
`manager` and the target is this employee, at the same two timestamps. `is_manager`
depends on the manager slot being resolved first, which is precisely what the slot
dependency DAG (D13) is for.

This has a consequence the reconciler must handle: reassigning Jane's manager changes
the direct-report count of **both the old and the new manager**, either of whom may
cross the zero boundary and gain or lose manager-only trainings. Both are dirty.

## D8. Manual overrides are rules

`assignment_rules.source = 'manual'`, `subject_employee_id` set. Precedence comes from
the comparator's ordering (D9), not from a priority value, so there is no ceiling to
maintain and no write path that can forget it.
There is exactly one resolution mechanism and one explain-trace format.

## D9. Tie-break, with specificity removed

Order matched rules by:

```
(source = 'manual') DESC, priority DESC, rule_created_at ASC, rule_id ASC
```

**Manual comes first, before priority.** An earlier version put `priority` first, which
meant an automatic rule at priority 200 beat a manual override at priority 100 and D8's
"manual overrides always win" was true only if every write path maintained a numeric
convention. It did not: the API defaulted manual priority to zero.

Ordering position is an invariant; a priority ceiling is a convention someone has to
remember. No priority value can now break manual precedence, and the API default stops
mattering. `priority` still orders manual rules against each other, and automatic rules
against each other.

**Every term must be stable across versions of the same rule.** This is the constraint,
not a detail of it. An earlier draft ordered on `created_at` and `id`; both are
regenerated by the write path when a future-effective edit slices a rule's valid range,
so renaming a rule effective in June retroactively changed which rule won in March.
Resolution for a past date must be a function of the facts and rules in force on that
date, and of nothing else. See migration 004.

Before adding any term to this comparator, ask whether the write path can ever
regenerate it. If it can, it is disqualified.

Specificity scoring is deliberately not implemented. AST node count is not business
specificity, and it adds an explanation mechanism admins cannot predict. Equal-priority
collisions are surfaced in the rule builder UI as a warning instead.

## D10. One predicate language, two compilers

`evaluate()` produces per-node match results for the explain trace.
`toSql()` produces a `WHERE` fragment for reverse matching ("which employees does this
rule hit?"). Agreement between them is asserted by property test.

Reverse matching is required because rule edits cannot loop the population.

## D11. Dynamic groups may not reference groups

`in_group` is rejected inside a dynamic group predicate. Prohibiting the node removes
group-to-group recursion by construction and costs no expressiveness (a group of groups
is an `or` over the underlying criteria).

## D12. Level-triggered reconciliation

The worker recomputes the full desired state for an employee from source facts and
rules, diffs it against current, and writes only differences. It does not apply event
deltas.

Rationale: duplicated, out-of-order, and replayed events are all harmless. An event
means "this employee is dirty", nothing more.

## D13. Slot dependencies are a validated DAG

`slot_dependencies` is a real table, validated acyclic at rule-save time, walked
topologically during reconciliation. A depth bound exists only as a runaway guard that
raises an alert; it is not the correctness mechanism.

## D14. Effective time is separate from processing time

A scheduled reconciliation fires approximately. The resulting `resolved_assignments`
row must carry `valid` starting at the exact boundary instant (the tenure anniversary),
not at job execution time. Convergence latency is an SLA, not a correctness property.

## D15. Resolved assignments are append-only and authoritative

`resolved_assignments` is bi-temporal, never updated in place. It is authoritative for
"what we told the world on date D". It is also independently rebuildable from
`employment_records` + `assignment_rules`, and that rebuildability is asserted by test
rather than assumed.

Do not treat it as a mutable cache and simultaneously as audit history.

**What rebuildability claims, precisely.** For any valid time `V`, replaying the
resolver over `employment_records` and `assignment_rules` as known at system time `now`
produces the same *set of (slot, target) pairs* as the currently-open
`resolved_assignments` rows at `V`.

**What it does not claim.** It does not reproduce historical system-time stamps. Those
record when an asynchronous worker got there, which is a fact about our infrastructure,
not about the world. Two runs of the same worker on different days legitimately produce
different system stamps for the same conclusion.

So the rebuild test compares resolved sets at given valid times, ignoring system
timestamps. Say this explicitly in the architecture document; the distinction between
"what the rules imply" and "what we published, when" is the kind of thing an
interviewer will probe.

## D16. pg-boss enqueue is explicitly transactional

Sharing a database is necessary but not sufficient. The enqueue call must be passed the
application's transaction. Verify against pg-boss's current API rather than assuming.

## D17. AI at the authoring boundary only

An LLM compiles natural language into a predicate AST. The AST is schema-validated,
rendered back as editable structured criteria, and confirmed by the admin against a
live match count before it is saved. No model runs at resolution time, ever.

Build this last. If it is not solid, it ships as a static mockup.

---

## Explicitly rejected

**Temporal.io for reconciliation.** This is a convergence problem (a controller loop
with no terminal state), not an orchestration problem. Entity workflows would need
versioning across the lifetime of an employment. Temporal *would* be right for outbound
provisioning sagas (GitHub, Slack, benefits carriers), and the architecture doc says so.

**Agentic AI anywhere in the system.** The first evaluation criterion is deterministic,
explainable resolution. Nothing in this problem needs autonomy.

**Redis / BullMQ.** Would forfeit transactional enqueue with the source-of-truth write.

**Specificity-based conflict resolution.** See D9.

**Full CRUD for every entity.** Only what the demo journey needs.
