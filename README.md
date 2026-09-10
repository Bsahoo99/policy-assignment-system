# Policy Assignment System

A deterministic, bi-temporal engine for assigning policies to employees — rules
defined against the employee population, resolved for any employee on any date,
and reconciled automatically when the inputs change.

Built for the Warp engineering take-home
([problem statement](https://www.warp.co/eng/problems/assignments)).
Next.js 15 · TypeScript · Postgres.

---

## Start here: see it work in 60 seconds

```bash
npm install
npm run demo
```

No Docker, no database setup — the demo runs the whole engine against an
embedded Postgres. It walks one employee through the hardest case in the brief:

```
=== 2. Jane payroll at 2026-08-10, system 2026-01-01 ===
    Senior Vacation, Slack, GitHub, Alice Martinez, US Semi-Monthly

=== 3. Jane relocates to Canada on 2026-08-15 ===
    Senior Vacation, Slack, GitHub, Alice Martinez, Canadian Payroll

=== 4. Retroactive correction: she actually moved on 2026-08-01 ===

=== 5. Time-travel: same valid date, two system beliefs ===
  system 2026-08-20 (before correction): ... US Semi-Monthly
  system 2026-09-05 ( after correction): ... Canadian Payroll
```

That last step is the point. Payroll ran in August against a belief we now know
was wrong. The system reproduces **both** answers — what we believed then, and
what we know now — because the facts that drive resolution (employment records,
rules, group memberships, and the resolved assignments themselves) each carry two
time axes rather than one. Configuration — slots, targets, group *definitions* —
does not; `ARCHITECTURE.md` states that boundary and why it is a gap.

---

## The three things the brief asks for

| The ask | Where it lives |
| --- | --- |
| **Define assignment rules** against the population — attribute, location, tenure, department, org-chart, manual | `src/predicate.ts` — one DSL, two compilers (in-memory + SQL). Manual overrides are rules, not a second mechanism. |
| **Resolve** the full policy set for any employee on any date, respecting cardinality, resolving conflicts deterministically | `src/resolver.ts` — a pure function. Cardinality lives on the slot. `compareRules` is a total order, so output never depends on input order. |
| **Reconcile** when attributes change, rules are edited, or group membership changes | `src/reconcile.ts` + `src/segments.ts` + `src/candidates.ts` — level-triggered, segmented over time, with a bounded candidate set instead of a full sweep. |

The subtle one is tenure. Nothing happens: no user action, no write, no event —
a date simply passes and the assignment must change. `src/scheduler.ts` handles
that by computing each employee's *next material date* (the earliest instant any
predicate could flip) and scheduling a job at that exact boundary instant.

### What the seeded company covers

All nine policy categories the brief names, across both cardinality regimes:

| Category | Slot | Cardinality |
| --- | --- | --- |
| Time off | `vacation` | exactly one |
| Pay schedules | `payroll_schedule` | exactly one |
| Work schedules | `work_schedule` | exactly one |
| Shift policies | `shift_policy` | at most one |
| Holiday calendar | `holiday_calendar` | exactly one |
| Benefit plans | `benefit_plan` | many |
| Application access | `apps` | many |
| Compliance trainings | `training` | many |
| Manager | `manager` | exactly one |

Adding a category is a row in `assignment_slots` — not new code. The seeded
rules are the brief's own example sentences, including *"Hourly US W-2 employees
are subject to a specific shift tracking policy"* (matches only Bob) and
*"California-based employees must sign the CA Meal Break policy"* (matches Alice
and Jane, and correctly detaches when Jane relocates to Canada).

---

## Reading order

1. **[ARCHITECTURE.md](ARCHITECTURE.md)** — the design narrative, with system
   diagrams, the resolution pipeline, the data model, tradeoffs, and limitations.
   **Read this first.**
2. **[DECISIONS.md](DECISIONS.md)** — the seventeen locked calls with rationale,
   and an explicit list of what was rejected and why.
3. **[NOTES.md](NOTES.md)** — implementation-level detail: segmentation,
   candidate selection, transactions, the AI-authoring boundary.
4. **[db/schema.sql](db/schema.sql)** — 299 lines, commented. The exclusion
   constraints are where the temporal invariants actually live.

If you only read one section: *"What we noticed"* in ARCHITECTURE.md, which
covers the four things the problem turned out to demand that the brief didn't
mention.

---

## How this maps to the evaluation criteria

| Criterion | Where to look |
| --- | --- |
| **Correct resolution & reconciliation** | `src/resolver.ts`, `src/reconcile.ts`. Determinism is a property test, not a claim: `test/compilers.test.ts` asserts the two predicate compilers agree over generated inputs. `test/reconcile.test.ts` asserts an identical recompute writes zero rows. |
| **Deterministic, explainable conflicts** | `compareRules` — a total order with no term the write path can regenerate. Explain traces are produced *during* resolution and stored on the row, never reconstructed by re-running rules afterward. |
| **User experience** | `/employees/[id]` answers both "why does X have Y" and "why *doesn't* X have Y". `/rules` previews who actually gains or loses before you save, and carries a **rule health** panel surfacing dead rules, always-shadowed rules, and equal-priority collisions. `/` simulates a hypothetical new hire without writing rows. |
| **Architecture** | ARCHITECTURE.md — topology diagram and the storage argument. Postgres `tstzrange` + GiST exclusion constraints do the temporal work the application would otherwise do badly. |
| **Auditability** | `audit_events`, written in the same transaction as the write it describes. `GET /api/employees/[id]/explain?at=` answers "why does X have Y as of Z" from the API alone. |
| **Developer experience** | The engine in `src/` has no Next.js imports — it is a library the app calls. One predicate language, one resolution mechanism, one temporal write primitive (`supersede`). |
| **Communication of tradeoffs** | DECISIONS.md, including *Explicitly rejected*. ARCHITECTURE.md states limitations plainly rather than leaving them to be discovered. |

---

## Setup

Requires **Node >= 22.12** (pg-boss).

```bash
npm install
```

Then pick a database:

**Embedded PGlite (no Docker).** Leave `DATABASE_URL` unset. `npm run seed`
applies schema, seeds, and runs the initial reconcile; `npm run dev` serves the
app. Queued jobs reconcile inline, so no worker is needed.

> `.pglite` is single-process: seed first, then start `dev`, and don't run a
> second dev server or an ad-hoc script against it while it's running.

> **Refreshing the demo data.** `npm run seed` creates the demo company; it does
> not upgrade one. If you seeded before a change to `db/seed.sql` it prints
> `seed skipped` and leaves the existing data alone. To recreate it:
>
> 1. **Stop the dev server and the worker first.** Deleting the data directory
>    underneath a live process is what produces `RuntimeError: Aborted()` on the
>    next start.
> 2. Embedded PGlite: `rm -rf .pglite && npm run seed`
>    Real Postgres: `docker compose down -v && docker compose up -d postgres && npm run seed`
>
> Either command **destroys the database**, including any rules, groups or manual
> overrides you created through the UI. That is the intended cost — the demo
> database is disposable fixture data, not a store of record.

**Real Postgres (production topology).**

```bash
docker compose up -d postgres
export DATABASE_URL=postgres://warp:warp@localhost:5432/warp
npm run seed
npm run worker   # second terminal — processes reconciliation jobs
npm run dev      # third terminal
```

## Commands

| Command | What it does |
| --- | --- |
| `npm run demo` | End-to-end scenario on a fresh in-memory database. **The fastest way to see the system work.** |
| `npm test` | 133 tests across 15 files, including `fast-check` property tests |
| `npm run dev` | Admin UI — employees, rules, groups, audit |
| `npm run worker` | pg-boss worker (real Postgres only) |
| `npm run build` | Production build |

## API

Every write path takes `company_id` and `effective_at`, and enqueues
reconciliation in the same transaction as the write.

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/companies` | create a company |
| PATCH | `/api/employees/[id]/records` | corrected employment record |
| POST | `/api/employees/[id]/overrides` | manual rule override |
| GET | `/api/employees/[id]/explain?company_id=&at=` | stored explain traces at an instant |
| POST | `/api/groups` · `/api/groups/[id]/members` | create group · add member |
| DELETE | `/api/groups/[id]/members` | remove member |
| POST | `/api/slots/[id]/rules` | create a rule |
| PATCH | `/api/rules/[id]` | edit a rule (versioned via `supersede`) |
| POST | `/api/slot-deps` | create a slot dependency (cycle-checked at write time) |
| POST | `/api/simulate` | dry run for a real or hypothetical employee → `{added, removed, unchanged}`, writes nothing |
| POST | `/api/rules/preview` | who actually gains or loses if this rule is saved |
| GET | `/api/health?company_id=` | dead rules, always-shadowed rules, priority collisions, unfilled required slots |
| POST | `/api/ai/author-rule` | natural language → proposed predicate, for human review |

## Scope

Built to be judged on the engine, so some surfaces are deliberately thin.
[ARCHITECTURE.md](ARCHITECTURE.md) lists the limitations in full; the short
version is that tenant onboarding is developer-steps only, rule *editing* is
API-only (the builder creates but does not load for edit), and performance at
population scale is reasoned about but not benchmarked.

No model runs at resolution time. AI proposes a predicate at authoring time; it
is schema-validated, shown back as editable criteria with a live match count,
and confirmed by a human before it is saved.
