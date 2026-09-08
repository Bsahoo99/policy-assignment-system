-- K2: the employment-type union is enforced at the column, not just at the form.
-- The guard keeps this idempotent because db/schema.sql declares the same
-- constraints for fresh databases.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'employment_records_employment_type_check'
  ) THEN
    ALTER TABLE employment_records
      ADD CONSTRAINT employment_records_employment_type_check
      CHECK (employment_type IN ('w2_employee', 'contractor', 'intern'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'employment_records_pay_type_check'
  ) THEN
    ALTER TABLE employment_records
      ADD CONSTRAINT employment_records_pay_type_check
      CHECK (pay_type IN ('salary', 'hourly'));
  END IF;
END $$;
