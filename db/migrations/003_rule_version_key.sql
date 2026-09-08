-- 003: give assignment_rules a per-version surrogate key.
--
-- The original table used `id` as BOTH the surrogate row identity and the timeline
-- key that versions share. Every other bi-temporal table separates the two
-- (employment_records: id + employee_id). The mismatch meant the shared write
-- primitive's "close these rows" UPDATE reached every version ever recorded for a
-- rule, not the one open version it had selected. First edit succeeded, second edit
-- collided on the exclusion constraint.
--
-- Fixing the schema is better than special-casing the primitive: it makes every
-- bi-temporal table the same shape, so the primitive's assumption becomes structural
-- rather than something each table happens to satisfy.

ALTER TABLE assignment_rules RENAME COLUMN id TO rule_id;

ALTER TABLE assignment_rules
    ADD COLUMN id UUID NOT NULL DEFAULT gen_random_uuid();

ALTER TABLE assignment_rules
    ADD CONSTRAINT assignment_rules_pkey PRIMARY KEY (id);

-- The exclusion constraint tracks the timeline key, not the version key.
ALTER TABLE assignment_rules
    DROP CONSTRAINT IF EXISTS assignment_rules_company_id_id_valid_system_excl;

ALTER TABLE assignment_rules
    ADD CONSTRAINT assignment_rules_timeline_excl
    EXCLUDE USING gist (
        company_id WITH =,
        rule_id    WITH =,
        valid      WITH &&,
        system     WITH &&
    );

-- Keep both identities on resolved rows. `winning_rule_id` is the logical rule an
-- admin recognises and edits; `winning_rule_version_id` is the exact version that
-- produced this assignment, which is what makes an old explain trace reproducible
-- after the rule has been edited.
ALTER TABLE resolved_assignments
    ADD COLUMN winning_rule_version_id UUID;

-- Guard rail for every bi-temporal table: `id` must be a single-column primary key
-- and must not appear in the timeline key. Run this as a test, not just a migration.
--
--   SELECT c.relname
--     FROM pg_constraint x
--     JOIN pg_class c ON c.oid = x.conrelid
--    WHERE x.contype = 'x'
--      AND NOT EXISTS (
--          SELECT 1 FROM pg_constraint p
--           WHERE p.conrelid = c.oid AND p.contype = 'p'
--             AND p.conkey = ARRAY[(SELECT attnum FROM pg_attribute
--                                    WHERE attrelid = c.oid AND attname = 'id')]
--      );
--
-- Any row returned is a table the write primitive will corrupt.
