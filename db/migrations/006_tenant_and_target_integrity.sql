-- 006: make tenancy and slot/target compatibility structural.
--
-- A rule carried three independent foreign keys -- company, slot, target -- and
-- nothing tied them to each other. Two invalid states were reachable through the
-- ordinary write path with no error:
--
--   1. Company A publishing company B's target as one of A's assignments.
--   2. A pay_schedule slot filled with an app target.
--
-- D4 says there is no "add tenancy later" path in a payroll system, so a check
-- living only in the application is not good enough: any future write path could
-- forget it. This reuses the idiom already in the schema for target subtypes --
-- give the parent a uniqueness that includes the discriminator, denormalise the
-- discriminator onto the child, and let a composite foreign key carry the
-- invariant. No trigger, and nothing for a caller to remember.

-- Parents gain the composite keys the children will point at.
ALTER TABLE employees
    ADD CONSTRAINT employees_company_id_id_key UNIQUE (company_id, id);

ALTER TABLE groups
    ADD CONSTRAINT groups_company_id_id_key UNIQUE (company_id, id);

ALTER TABLE assignment_slots
    ADD CONSTRAINT assignment_slots_company_id_id_key UNIQUE (company_id, id);

ALTER TABLE assignment_slots
    ADD CONSTRAINT assignment_slots_company_id_id_target_type_key
    UNIQUE (company_id, id, target_type);

ALTER TABLE assignment_targets
    ADD CONSTRAINT assignment_targets_company_id_id_target_type_key
    UNIQUE (company_id, id, target_type);

-- Denormalised discriminator: a rule's target_type is the slot's target_type,
-- and the two foreign keys below make the target agree with it.
ALTER TABLE assignment_rules ADD COLUMN target_type TEXT;

UPDATE assignment_rules r
   SET target_type = s.target_type
  FROM assignment_slots s
 WHERE s.id = r.slot_id;

ALTER TABLE assignment_rules ALTER COLUMN target_type SET NOT NULL;

ALTER TABLE assignment_rules
    ADD CONSTRAINT assignment_rules_slot_fk
    FOREIGN KEY (company_id, slot_id, target_type)
    REFERENCES assignment_slots (company_id, id, target_type) ON DELETE CASCADE;

ALTER TABLE assignment_rules
    ADD CONSTRAINT assignment_rules_target_fk
    FOREIGN KEY (company_id, target_id, target_type)
    REFERENCES assignment_targets (company_id, id, target_type) ON DELETE CASCADE;

-- A manual override's subject must be an employee of the same company. The
-- default MATCH SIMPLE means this is not checked when subject_employee_id is
-- NULL, which is exactly right: automatic rules have no subject.
ALTER TABLE assignment_rules
    ADD CONSTRAINT assignment_rules_subject_fk
    FOREIGN KEY (company_id, subject_employee_id)
    REFERENCES employees (company_id, id) ON DELETE CASCADE;

-- The same cross-tenant risk exists wherever two tenant-scoped rows are joined.
ALTER TABLE group_memberships
    ADD CONSTRAINT group_memberships_group_fk
    FOREIGN KEY (company_id, group_id) REFERENCES groups (company_id, id) ON DELETE CASCADE;

ALTER TABLE group_memberships
    ADD CONSTRAINT group_memberships_employee_fk
    FOREIGN KEY (company_id, employee_id) REFERENCES employees (company_id, id) ON DELETE CASCADE;

ALTER TABLE slot_dependencies
    ADD CONSTRAINT slot_dependencies_slot_fk
    FOREIGN KEY (company_id, slot_id)
    REFERENCES assignment_slots (company_id, id) ON DELETE CASCADE;

ALTER TABLE slot_dependencies
    ADD CONSTRAINT slot_dependencies_depends_fk
    FOREIGN KEY (company_id, depends_on_slot)
    REFERENCES assignment_slots (company_id, id) ON DELETE CASCADE;

ALTER TABLE resolved_assignments
    ADD CONSTRAINT resolved_assignments_employee_fk
    FOREIGN KEY (company_id, employee_id)
    REFERENCES employees (company_id, id) ON DELETE CASCADE;

ALTER TABLE resolved_assignments
    ADD CONSTRAINT resolved_assignments_slot_fk
    FOREIGN KEY (company_id, slot_id)
    REFERENCES assignment_slots (company_id, id) ON DELETE CASCADE;

-- Derive the discriminator instead of requiring every INSERT to restate it.
--
-- This is a denormalisation maintained by the database, not business logic: the
-- value is a copy of the slot's target_type and has no other source.
--
-- The trigger and the foreign keys do different halves of the job: the trigger
-- fills the discriminator when a caller omits it, so no write path has to know
-- the column exists; the composite foreign keys above reject a caller that
-- supplies one disagreeing with the slot. Neither alone is the guarantee.
-- If the slot does not exist in this company the column stays NULL and the NOT
-- NULL constraint rejects the row, which is the correct outcome.
CREATE OR REPLACE FUNCTION assignment_rules_fill_target_type() RETURNS trigger AS $fn$
BEGIN
    IF NEW.target_type IS NULL THEN
        SELECT s.target_type INTO NEW.target_type
          FROM assignment_slots s
         WHERE s.company_id = NEW.company_id AND s.id = NEW.slot_id;
    END IF;
    RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

CREATE TRIGGER assignment_rules_target_type_bi
    BEFORE INSERT OR UPDATE ON assignment_rules
    FOR EACH ROW EXECUTE FUNCTION assignment_rules_fill_target_type();
