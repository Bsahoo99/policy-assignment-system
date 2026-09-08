ALTER TABLE assignment_rules
ADD COLUMN effect TEXT NOT NULL DEFAULT 'grant' CHECK (effect IN ('grant', 'deny'));
