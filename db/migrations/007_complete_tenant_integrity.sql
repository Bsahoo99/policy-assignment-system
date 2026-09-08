-- 007: finish what 006 started.
--
-- 006 claimed the invariant held "wherever two tenant-scoped rows are joined",
-- and it did not. A follow-up review showed four writes that the fully migrated
-- schema still accepted:
--
--   * a resolved assignment pointing at another company's target
--   * an app target published into a pay_schedule slot
--   * an employee_target mapping to another company's employee
--   * an employment_record referencing another company's employee
--
-- None is reachable through the fixed createRule path today. They matter because
-- resolved_assignments is written by the engine rather than by a validated HTTP
-- boundary, and because a constraint is the only form of this guarantee that a
-- future write path cannot forget. Completing it is cheaper than qualifying it.

-- --------------------------------------------------------------------------
-- employment_records: the record's employee must belong to the record's company
-- --------------------------------------------------------------------------

ALTER TABLE employment_records
    ADD CONSTRAINT employment_records_employee_fk
    FOREIGN KEY (company_id, employee_id)
    REFERENCES employees (company_id, id) ON DELETE CASCADE;

-- --------------------------------------------------------------------------
-- employee_targets: had no company column at all, so nothing tied the target
-- and the employee it names to the same tenant.
-- --------------------------------------------------------------------------

ALTER TABLE employee_targets ADD COLUMN company_id UUID;

UPDATE employee_targets et
   SET company_id = e.company_id
  FROM employees e
 WHERE e.id = et.employee_id;

ALTER TABLE employee_targets ALTER COLUMN company_id SET NOT NULL;

ALTER TABLE employee_targets
    ADD CONSTRAINT employee_targets_target_fk
    FOREIGN KEY (company_id, target_id, target_type)
    REFERENCES assignment_targets (company_id, id, target_type) ON DELETE CASCADE;

ALTER TABLE employee_targets
    ADD CONSTRAINT employee_targets_employee_fk
    FOREIGN KEY (company_id, employee_id)
    REFERENCES employees (company_id, id) ON DELETE CASCADE;

CREATE OR REPLACE FUNCTION employee_targets_fill_company() RETURNS trigger AS $fn$
BEGIN
    IF NEW.company_id IS NULL THEN
        SELECT e.company_id INTO NEW.company_id
          FROM employees e
         WHERE e.id = NEW.employee_id;
    END IF;
    RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

CREATE TRIGGER employee_targets_company_bi
    BEFORE INSERT OR UPDATE ON employee_targets
    FOR EACH ROW EXECUTE FUNCTION employee_targets_fill_company();

-- --------------------------------------------------------------------------
-- resolved_assignments: the engine writes these, so they need the same
-- slot/target agreement that 006 gave rules.
-- --------------------------------------------------------------------------

ALTER TABLE resolved_assignments ADD COLUMN target_type TEXT;

UPDATE resolved_assignments ra
   SET target_type = s.target_type
  FROM assignment_slots s
 WHERE s.id = ra.slot_id;

CREATE OR REPLACE FUNCTION resolved_assignments_fill_target_type() RETURNS trigger AS $fn$
BEGIN
    IF NEW.target_type IS NULL THEN
        SELECT s.target_type INTO NEW.target_type
          FROM assignment_slots s
         WHERE s.company_id = NEW.company_id AND s.id = NEW.slot_id;
    END IF;
    RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

CREATE TRIGGER resolved_assignments_target_type_bi
    BEFORE INSERT OR UPDATE ON resolved_assignments
    FOR EACH ROW EXECUTE FUNCTION resolved_assignments_fill_target_type();

ALTER TABLE resolved_assignments ALTER COLUMN target_type SET NOT NULL;

ALTER TABLE resolved_assignments
    ADD CONSTRAINT resolved_assignments_slot_type_fk
    FOREIGN KEY (company_id, slot_id, target_type)
    REFERENCES assignment_slots (company_id, id, target_type) ON DELETE CASCADE;

ALTER TABLE resolved_assignments
    ADD CONSTRAINT resolved_assignments_target_fk
    FOREIGN KEY (company_id, target_id, target_type)
    REFERENCES assignment_targets (company_id, id, target_type) ON DELETE CASCADE;
