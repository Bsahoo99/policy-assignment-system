-- 004: make the tie-break depend only on values write-path mechanics cannot touch.
--
-- Two defects, both introduced by earlier changes in this project:
--
-- 1. `created_at` on assignment_rules conflated two different things: when the
--    LOGICAL rule was first authored, and when THIS VERSION ROW was written. The
--    tie-break (D9) reads the first meaning. The write path sets the second. So
--    slicing a rule's valid range for a future-effective edit re-inserted the
--    earlier segment with a fresh created_at, and a rule authored in January started
--    losing to one authored in February -- retroactively, for dates in the past, with
--    nothing about those dates having changed.
--
-- 2. Migration 003 made `id` a per-version surrogate that changes on every edit, so
--    the final `id ASC` tie-break stopped being stable across edits. That one is on
--    me: 003 fixed the write primitive and silently broke the ordering.
--
-- The rule underneath both: a tie-break may only read columns that are stable by
-- construction across versions. Row metadata is not stable. Surrogate keys are not
-- stable. The logical key and the authoring time are.

ALTER TABLE assignment_rules
    ADD COLUMN rule_created_at TIMESTAMPTZ;

-- Backfill: the earliest recorded version of each logical rule is when it was authored.
UPDATE assignment_rules r
   SET rule_created_at = sub.first_seen
  FROM (
      SELECT company_id, rule_id, MIN(lower(system)) AS first_seen
        FROM assignment_rules
       GROUP BY company_id, rule_id
  ) sub
 WHERE r.company_id = sub.company_id AND r.rule_id = sub.rule_id;

ALTER TABLE assignment_rules
    ALTER COLUMN rule_created_at SET NOT NULL;

COMMENT ON COLUMN assignment_rules.rule_created_at IS
    'When the LOGICAL rule was first authored. Set once per rule_id, carried unchanged '
    'onto every later version and every sliced remnant. Read by the tie-break.';

COMMENT ON COLUMN assignment_rules.created_at IS
    'When THIS VERSION ROW was written. Row metadata. Never read by resolution.';
