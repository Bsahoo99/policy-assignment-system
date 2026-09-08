-- Policy Assignment System: schema
--
-- Two time axes on every fact table:
--   valid  = when the fact is/was true in the world
--   system = when we believed it (closed, never deleted, on correction)
--
-- Every table is tenant-scoped by company_id, and every uniqueness or
-- exclusion constraint is scoped by it too.

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ---------------------------------------------------------------------------
-- Tenancy and identity
-- ---------------------------------------------------------------------------

CREATE TABLE companies (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE employees (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    first_name  TEXT NOT NULL,
    last_name   TEXT NOT NULL,
    email       TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (company_id, email)
);

-- ---------------------------------------------------------------------------
-- Employment facts (bi-temporal, typed snapshot)
--
-- Deliberately a typed record rather than key/value rows. Adding an attribute
-- is a migration. Tradeoff: less flexible for admins, but the predicate DSL
-- can be typed end to end and compiled to indexed SQL.
-- ---------------------------------------------------------------------------

CREATE TABLE employment_records (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id         UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    employee_id        UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,

    department         TEXT,
    location_state     TEXT,
    location_country   TEXT NOT NULL DEFAULT 'US',
    employment_type    TEXT NOT NULL CHECK (employment_type IN ('w2_employee', 'contractor', 'intern')),
    pay_type           TEXT NOT NULL CHECK (pay_type IN ('salary', 'hourly')),
    tenure_start_date  DATE NOT NULL,
    -- No manager_id. Reporting lines are resolved through the `manager` slot like
    -- every other assignment, so they get priority resolution, explain traces, and
    -- bi-temporal history for free. See DECISIONS.md D7.

    valid              TSTZRANGE NOT NULL,
    system             TSTZRANGE NOT NULL DEFAULT tstzrange(now(), NULL),

    recorded_by        UUID,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- No two records for the same employee may be simultaneously applicable
    -- on BOTH axes. A retroactive correction closes `system` on the old row,
    -- which is what makes the new row non-conflicting.
    EXCLUDE USING gist (
        company_id  WITH =,
        employee_id WITH =,
        valid       WITH &&,
        system      WITH &&
    )
);

CREATE INDEX idx_employment_current
    ON employment_records USING gist (company_id, employee_id, valid, system);

-- Reverse matching (which employees match this rule) hits these directly.
CREATE INDEX idx_employment_reverse
    ON employment_records (company_id, department, location_state, employment_type)
    WHERE upper_inf(system);

-- ---------------------------------------------------------------------------
-- Slots: the category a target is assigned into. Cardinality lives here,
-- not on the target, so two targets in one category cannot disagree.
-- ---------------------------------------------------------------------------

CREATE TABLE assignment_slots (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id    UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    key           TEXT NOT NULL,               -- vacation | manager | app_access | ...
    display_name  TEXT NOT NULL,
    cardinality   TEXT NOT NULL CHECK (cardinality IN ('exactly_one', 'at_most_one', 'many')),
    target_type   TEXT NOT NULL CHECK (target_type IN ('policy', 'app', 'pay_schedule', 'employee')),
    UNIQUE (company_id, key)
);

-- Slot dependency DAG. `compliance_training` depends on `manager`, because
-- is_manager is derived from manager assignments. Validated as acyclic at
-- write time (see validateSlotGraph); the resolver walks it topologically.
CREATE TABLE slot_dependencies (
    company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    slot_id         UUID NOT NULL REFERENCES assignment_slots(id) ON DELETE CASCADE,
    depends_on_slot UUID NOT NULL REFERENCES assignment_slots(id) ON DELETE CASCADE,
    PRIMARY KEY (company_id, slot_id, depends_on_slot),
    CHECK (slot_id <> depends_on_slot)
);

-- ---------------------------------------------------------------------------
-- Targets: one canonical registry so a slot can point at a policy, an app,
-- a pay schedule, or another employee (manager) without special-casing.
-- Subtype tables carry the type-specific payload and FK back to the registry.
-- ---------------------------------------------------------------------------

CREATE TABLE assignment_targets (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id   UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    target_type  TEXT NOT NULL CHECK (target_type IN ('policy', 'app', 'pay_schedule', 'employee')),
    display_name TEXT NOT NULL,
    UNIQUE (id, target_type),                  -- lets subtypes pin their type
    UNIQUE (company_id, target_type, display_name)
);

CREATE TABLE policy_targets (
    target_id    UUID PRIMARY KEY,
    target_type  TEXT NOT NULL DEFAULT 'policy' CHECK (target_type = 'policy'),
    details      JSONB NOT NULL DEFAULT '{}',
    FOREIGN KEY (target_id, target_type) REFERENCES assignment_targets(id, target_type) ON DELETE CASCADE
);

CREATE TABLE app_targets (
    target_id     UUID PRIMARY KEY,
    target_type   TEXT NOT NULL DEFAULT 'app' CHECK (target_type = 'app'),
    provider      TEXT NOT NULL,               -- github | slack | linear
    provider_ref  TEXT,
    FOREIGN KEY (target_id, target_type) REFERENCES assignment_targets(id, target_type) ON DELETE CASCADE
);

CREATE TABLE employee_targets (
    target_id    UUID PRIMARY KEY,
    target_type  TEXT NOT NULL DEFAULT 'employee' CHECK (target_type = 'employee'),
    employee_id  UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    FOREIGN KEY (target_id, target_type) REFERENCES assignment_targets(id, target_type) ON DELETE CASCADE,
    UNIQUE (employee_id)
);

-- ---------------------------------------------------------------------------
-- Groups. Static = explicit membership. Dynamic = predicate over employees.
-- in_group is forbidden inside a dynamic group's predicate, which removes
-- group-to-group recursion by construction.
-- ---------------------------------------------------------------------------

CREATE TABLE groups (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    key         TEXT NOT NULL,
    kind        TEXT NOT NULL CHECK (kind IN ('static', 'dynamic')),
    criteria    JSONB,                         -- required iff kind = 'dynamic'
    UNIQUE (company_id, key),
    CHECK ((kind = 'dynamic') = (criteria IS NOT NULL))
);

CREATE TABLE group_memberships (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    group_id    UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    valid       TSTZRANGE NOT NULL,
    system      TSTZRANGE NOT NULL DEFAULT tstzrange(now(), NULL),
    EXCLUDE USING gist (
        company_id  WITH =,
        group_id    WITH =,
        employee_id WITH =,
        valid       WITH &&,
        system      WITH &&
    )
);

-- ---------------------------------------------------------------------------
-- Rules. Manual overrides are rules with source = 'manual' and a pinned
-- subject_employee_id, so there is exactly one resolution mechanism and one
-- trace format. Their precedence comes from the resolver's comparator ordering
-- (source before priority), NOT from a ceiling priority value -- an ordering
-- position is an invariant, a priority ceiling is a convention every write path
-- would have to remember. See DECISIONS.md D9.
-- ---------------------------------------------------------------------------

CREATE TABLE assignment_rules (
    id          UUID NOT NULL DEFAULT gen_random_uuid(),
    company_id  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    slot_id     UUID NOT NULL REFERENCES assignment_slots(id) ON DELETE CASCADE,
    target_id   UUID NOT NULL REFERENCES assignment_targets(id) ON DELETE CASCADE,

    name        TEXT NOT NULL,
    source      TEXT NOT NULL DEFAULT 'rule' CHECK (source IN ('rule', 'manual')),
    priority    INT NOT NULL DEFAULT 0,
    criteria    JSONB NOT NULL,                -- predicate AST
    -- For manual overrides: pins the rule to one employee.
    subject_employee_id UUID REFERENCES employees(id) ON DELETE CASCADE,

    valid       TSTZRANGE NOT NULL,
    system      TSTZRANGE NOT NULL DEFAULT tstzrange(now(), NULL),

    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by  UUID,

    CHECK ((source = 'manual') = (subject_employee_id IS NOT NULL)),
    EXCLUDE USING gist (
        company_id WITH =,
        id         WITH =,
        valid      WITH &&,
        system     WITH &&
    )
);

CREATE INDEX idx_rules_active
    ON assignment_rules (company_id, slot_id)
    WHERE upper_inf(system);

-- ---------------------------------------------------------------------------
-- Resolved assignments.
--
-- Append-only and bi-temporal. Rows are never updated in place; a change
-- closes `system` on the old row and inserts a new one. That makes this table
-- authoritative for "what we told the world on date D", while remaining
-- independently rebuildable from employment_records + assignment_rules.
-- Rebuildability is asserted by test, not assumed.
-- ---------------------------------------------------------------------------

CREATE TABLE resolved_assignments (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id        UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    employee_id       UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    slot_id           UUID NOT NULL REFERENCES assignment_slots(id) ON DELETE CASCADE,
    target_id         UUID NOT NULL REFERENCES assignment_targets(id) ON DELETE CASCADE,

    winning_rule_id   UUID NOT NULL,
    -- Denormalized from assignment_slots so the exclusive-slot invariant can
    -- be enforced by the database rather than only by the resolver.
    is_exclusive      BOOLEAN NOT NULL,
    -- Full evaluation trace, written at resolution time, not reconstructed.
    explain_trace     JSONB NOT NULL,

    valid             TSTZRANGE NOT NULL,
    system            TSTZRANGE NOT NULL DEFAULT tstzrange(now(), NULL),

    EXCLUDE USING gist (
        company_id  WITH =,
        employee_id WITH =,
        slot_id     WITH =,
        target_id   WITH =,
        valid       WITH &&,
        system      WITH &&
    ),
    -- At most one target per exclusive slot, on both axes.
    EXCLUDE USING gist (
        company_id  WITH =,
        employee_id WITH =,
        slot_id     WITH =,
        valid       WITH &&,
        system      WITH &&
    ) WHERE (is_exclusive)
);

CREATE INDEX idx_resolved_lookup
    ON resolved_assignments USING gist (company_id, employee_id, valid, system);

-- ---------------------------------------------------------------------------
-- Scheduling. The earliest future instant at which some predicate could flip
-- for this employee (a tenure threshold, a future-dated transfer). One timed
-- job per employee instead of a nightly full-population sweep.
-- ---------------------------------------------------------------------------

CREATE TABLE employee_next_material_date (
    company_id   UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    employee_id  UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    next_at      TIMESTAMPTZ,
    reason       TEXT,
    computed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (company_id, employee_id)
);

CREATE INDEX idx_next_material_due ON employee_next_material_date (next_at)
    WHERE next_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Audit. Temporal history answers "what was true". This answers "who did it,
-- when, and why" -- which the brief asks for separately.
-- ---------------------------------------------------------------------------

CREATE TABLE audit_events (
    id           BIGSERIAL PRIMARY KEY,
    company_id   UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    actor_id     UUID,
    actor_kind   TEXT NOT NULL CHECK (actor_kind IN ('admin', 'system', 'integration')),
    action       TEXT NOT NULL,
    entity_type  TEXT NOT NULL,
    entity_id    UUID,
    before       JSONB,
    after        JSONB,
    reason       TEXT,
    request_id   TEXT,
    occurred_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_entity ON audit_events (company_id, entity_type, entity_id, occurred_at DESC);
