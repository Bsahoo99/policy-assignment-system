-- Seed data for the demo. Uses subqueries so it can run after schema.sql and migrations.

INSERT INTO companies (id, name) VALUES
  ('11111111-1111-1111-1111-111111111111', 'Acme Corp')
ON CONFLICT (id) DO NOTHING;

INSERT INTO employees (id, company_id, first_name, last_name, email) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'Alice', 'Martinez', 'alice@example.com'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '11111111-1111-1111-1111-111111111111', 'Bob', 'Chen', 'bob@example.com'),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', '11111111-1111-1111-1111-111111111111', 'Jane', 'Doe', 'jane@example.com')
ON CONFLICT (company_id, email) DO NOTHING;

-- Assignment slots
INSERT INTO assignment_slots (id, company_id, key, display_name, cardinality, target_type) VALUES
  ('d1111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', 'vacation', 'Vacation', 'exactly_one', 'policy'),
  ('d2222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'apps', 'Apps', 'many', 'app'),
  ('d3333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111', 'training', 'Training', 'many', 'policy'),
  ('d4444444-4444-4444-4444-444444444444', '11111111-1111-1111-1111-111111111111', 'manager', 'Manager', 'exactly_one', 'employee'),
  ('d5555555-5555-5555-5555-555555555555', '11111111-1111-1111-1111-111111111111', 'payroll_schedule', 'Payroll Schedule', 'exactly_one', 'pay_schedule')
ON CONFLICT (company_id, key) DO NOTHING;

-- Assignment targets
INSERT INTO assignment_targets (id, company_id, target_type, display_name) VALUES
  ('e1111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', 'policy', 'Standard Vacation'),
  ('e2222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'policy', 'Senior Vacation'),
  ('e3333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111', 'policy', 'Compliance Training'),
  ('e4444444-4444-4444-4444-444444444444', '11111111-1111-1111-1111-111111111111', 'app', 'Slack'),
  ('e5555555-5555-5555-5555-555555555555', '11111111-1111-1111-1111-111111111111', 'app', 'GitHub'),
  ('e6666666-6666-6666-6666-666666666666', '11111111-1111-1111-1111-111111111111', 'employee', 'Alice Martinez'),
  ('e7777777-7777-7777-7777-777777777777', '11111111-1111-1111-1111-111111111111', 'employee', 'Bob Chen'),
  ('e8888888-8888-8888-8888-888888888888', '11111111-1111-1111-1111-111111111111', 'employee', 'Jane Doe'),
  ('e9999999-9999-9999-9999-999999999999', '11111111-1111-1111-1111-111111111111', 'pay_schedule', 'US Semi-Monthly')
ON CONFLICT (company_id, target_type, display_name) DO NOTHING;

INSERT INTO employee_targets (target_id, target_type, employee_id) VALUES
  ('e6666666-6666-6666-6666-666666666666', 'employee', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  ('e7777777-7777-7777-7777-777777777777', 'employee', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'),
  ('e8888888-8888-8888-8888-888888888888', 'employee', 'cccccccc-cccc-cccc-cccc-cccccccccccc');

-- Groups
INSERT INTO groups (id, company_id, key, kind, criteria) VALUES
  ('f1111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', 'hq', 'static', NULL),
  ('f2222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'engineering', 'dynamic', '{"op":"eq","field":"department","value":"Engineering"}'::jsonb)
ON CONFLICT (company_id, key) DO NOTHING;

-- Static group memberships (Alice and Jane are in HQ)
INSERT INTO group_memberships (company_id, group_id, employee_id, valid, system) VALUES
  ('11111111-1111-1111-1111-111111111111', 'f1111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', tstzrange('2022-01-01T00:00:00Z', NULL), tstzrange('2024-01-01T00:00:00Z', NULL)),
  ('11111111-1111-1111-1111-111111111111', 'f1111111-1111-1111-1111-111111111111', 'cccccccc-cccc-cccc-cccc-cccccccccccc', tstzrange('2023-03-15T00:00:00Z', NULL), tstzrange('2024-01-01T00:00:00Z', NULL));

-- Employment records
INSERT INTO employment_records (company_id, employee_id, department, location_state, location_country, employment_type, pay_type, tenure_start_date, valid, system) VALUES
  ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Engineering', 'CA', 'US', 'w2_employee', 'salary', '2022-01-01', tstzrange('2022-01-01T00:00:00Z', NULL), tstzrange('2024-01-01T00:00:00Z', NULL)),
  ('11111111-1111-1111-1111-111111111111', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Sales', 'NY', 'US', 'w2_employee', 'hourly', '2024-01-01', tstzrange('2024-01-01T00:00:00Z', NULL), tstzrange('2024-01-01T00:00:00Z', NULL)),
  ('11111111-1111-1111-1111-111111111111', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'Engineering', 'CA', 'US', 'w2_employee', 'salary', '2023-03-15', tstzrange('2023-03-15T00:00:00Z', NULL), tstzrange('2024-01-01T00:00:00Z', NULL));

-- Assignment rules
INSERT INTO assignment_rules (company_id, rule_id, rule_created_at, slot_id, target_id, name, source, effect, priority, criteria, valid, system) VALUES
  ('11111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111111', '2024-01-01T00:00:00Z', 'd1111111-1111-1111-1111-111111111111', 'e1111111-1111-1111-1111-111111111111', 'Standard Vacation', 'rule', 'grant', 0, '{"op":"always"}'::jsonb, tstzrange('2024-01-01T00:00:00Z', NULL), tstzrange('2024-01-01T00:00:00Z', NULL)),
  ('11111111-1111-1111-1111-111111111111', 'a2222222-2222-2222-2222-222222222222', '2024-01-01T00:00:00Z', 'd1111111-1111-1111-1111-111111111111', 'e2222222-2222-2222-2222-222222222222', 'Senior Vacation', 'rule', 'grant', 10, '{"op":"gte_tenure","years":2}'::jsonb, tstzrange('2024-01-01T00:00:00Z', NULL), tstzrange('2024-01-01T00:00:00Z', NULL)),
  ('11111111-1111-1111-1111-111111111111', 'a4444444-4444-4444-4444-444444444444', '2024-01-01T00:00:00Z', 'd2222222-2222-2222-2222-222222222222', 'e4444444-4444-4444-4444-444444444444', 'Slack', 'rule', 'grant', 0, '{"op":"always"}'::jsonb, tstzrange('2024-01-01T00:00:00Z', NULL), tstzrange('2024-01-01T00:00:00Z', NULL)),
  ('11111111-1111-1111-1111-111111111111', 'a5555555-5555-5555-5555-555555555555', '2024-01-01T00:00:00Z', 'd2222222-2222-2222-2222-222222222222', 'e5555555-5555-5555-5555-555555555555', 'GitHub', 'rule', 'grant', 0, '{"op":"always"}'::jsonb, tstzrange('2024-01-01T00:00:00Z', NULL), tstzrange('2024-01-01T00:00:00Z', NULL)),
  ('11111111-1111-1111-1111-111111111111', 'a3333333-3333-3333-3333-333333333333', '2024-01-01T00:00:00Z', 'd3333333-3333-3333-3333-333333333333', 'e3333333-3333-3333-3333-333333333333', 'Manager Compliance Training', 'rule', 'grant', 0, '{"op":"is_manager"}'::jsonb, tstzrange('2024-01-01T00:00:00Z', NULL), tstzrange('2024-01-01T00:00:00Z', NULL)),
  ('11111111-1111-1111-1111-111111111111', 'a9999999-9999-9999-9999-999999999999', '2024-01-01T00:00:00Z', 'd5555555-5555-5555-5555-555555555555', 'e9999999-9999-9999-9999-999999999999', 'US Semi-Monthly', 'rule', 'grant', 0, '{"op":"eq","field":"location_country","value":"US"}'::jsonb, tstzrange('2024-01-01T00:00:00Z', NULL), tstzrange('2024-01-01T00:00:00Z', NULL));

INSERT INTO assignment_rules (company_id, rule_id, rule_created_at, slot_id, target_id, name, source, effect, priority, criteria, subject_employee_id, valid, system) VALUES
  ('11111111-1111-1111-1111-111111111111', 'a6666666-6666-6666-6666-666666666666', '2024-01-01T00:00:00Z', 'd4444444-4444-4444-4444-444444444444', 'e6666666-6666-6666-6666-666666666666', 'Jane reports to Alice', 'manual', 'grant', 100, '{"op":"always"}'::jsonb, 'cccccccc-cccc-cccc-cccc-cccccccccccc', tstzrange('2024-01-01T00:00:00Z', NULL), tstzrange('2024-01-01T00:00:00Z', NULL));

-- ---------------------------------------------------------------------------
-- The remaining policy categories named in the brief.
--
-- These add no code: a category is a row in assignment_slots plus targets and
-- rules. The rules below are the brief's own example sentences, so the seeded
-- company exercises all nine categories and all six rule types it lists.
-- ---------------------------------------------------------------------------

INSERT INTO assignment_slots (id, company_id, key, display_name, cardinality, target_type) VALUES
  ('d6666666-6666-6666-6666-666666666666', '11111111-1111-1111-1111-111111111111', 'work_schedule',    'Work Schedule',    'exactly_one', 'policy'),
  -- at_most_one, not exactly_one: only hourly staff are subject to a shift policy,
  -- and an employee with none is correct rather than unassigned.
  ('d7777777-7777-7777-7777-777777777777', '11111111-1111-1111-1111-111111111111', 'shift_policy',     'Shift Policy',     'at_most_one', 'policy'),
  ('d8888888-8888-8888-8888-888888888888', '11111111-1111-1111-1111-111111111111', 'holiday_calendar', 'Holiday Calendar', 'exactly_one', 'policy'),
  ('d9999999-9999-9999-9999-999999999999', '11111111-1111-1111-1111-111111111111', 'benefit_plan',     'Benefit Plans',    'many',        'policy')
ON CONFLICT (company_id, key) DO NOTHING;

INSERT INTO assignment_targets (id, company_id, target_type, display_name) VALUES
  ('ec111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', 'policy', 'Standard Work Schedule'),
  ('ec222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'policy', 'Hourly Shift Tracking'),
  ('ec333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111', 'policy', 'US Holiday Calendar'),
  ('ec444444-4444-4444-4444-444444444444', '11111111-1111-1111-1111-111111111111', 'policy', 'Canada Holiday Calendar'),
  ('ec555555-5555-5555-5555-555555555555', '11111111-1111-1111-1111-111111111111', 'policy', 'Healthcare Plan'),
  ('ec666666-6666-6666-6666-666666666666', '11111111-1111-1111-1111-111111111111', 'policy', 'Commuter Benefit'),
  ('ec777777-7777-7777-7777-777777777777', '11111111-1111-1111-1111-111111111111', 'policy', 'Engineering Equipment Stipend'),
  ('ec888888-8888-8888-8888-888888888888', '11111111-1111-1111-1111-111111111111', 'policy', 'CA Meal Break Policy')
ON CONFLICT (company_id, target_type, display_name) DO NOTHING;

INSERT INTO assignment_rules (company_id, rule_id, rule_created_at, slot_id, target_id, name, source, effect, priority, criteria, valid, system) VALUES
  -- Work schedule: the default everyone falls back to.
  ('11111111-1111-1111-1111-111111111111', 'ab111111-1111-1111-1111-111111111111', '2024-01-01T00:00:00Z', 'd6666666-6666-6666-6666-666666666666', 'ec111111-1111-1111-1111-111111111111', 'Standard Work Schedule', 'rule', 'grant', 0,
   '{"op":"always"}'::jsonb, tstzrange('2024-01-01T00:00:00Z', NULL), tstzrange('2024-01-01T00:00:00Z', NULL)),

  -- Employment-type rule, verbatim from the brief:
  -- "Hourly US W-2 employees are subject to a specific shift tracking policy"
  ('11111111-1111-1111-1111-111111111111', 'ab222222-2222-2222-2222-222222222222', '2024-01-01T00:00:00Z', 'd7777777-7777-7777-7777-777777777777', 'ec222222-2222-2222-2222-222222222222', 'Hourly US W-2 Shift Tracking', 'rule', 'grant', 0,
   '{"op":"and","children":[{"op":"eq","field":"pay_type","value":"hourly"},{"op":"eq","field":"employment_type","value":"w2_employee"},{"op":"eq","field":"location_country","value":"US"}]}'::jsonb,
   tstzrange('2024-01-01T00:00:00Z', NULL), tstzrange('2024-01-01T00:00:00Z', NULL)),

  -- Location-based holiday calendars. The Canada rule outranks the US default,
  -- so relocating an employee moves them between calendars automatically.
  --
  -- The Canada rule matches nobody in this seed, and the rule-health panel
  -- reports it as dead. That is the panel working, not a seeding mistake: a
  -- rule written ahead of the population is exactly the case an admin needs
  -- flagged, and the demo activates it the moment Jane relocates.
  ('11111111-1111-1111-1111-111111111111', 'ab333333-3333-3333-3333-333333333333', '2024-01-01T00:00:00Z', 'd8888888-8888-8888-8888-888888888888', 'ec333333-3333-3333-3333-333333333333', 'US Holiday Calendar', 'rule', 'grant', 0,
   '{"op":"eq","field":"location_country","value":"US"}'::jsonb, tstzrange('2024-01-01T00:00:00Z', NULL), tstzrange('2024-01-01T00:00:00Z', NULL)),
  ('11111111-1111-1111-1111-111111111111', 'ab444444-4444-4444-4444-444444444444', '2024-01-01T00:00:00Z', 'd8888888-8888-8888-8888-888888888888', 'ec444444-4444-4444-4444-444444444444', 'Canada Holiday Calendar', 'rule', 'grant', 10,
   '{"op":"eq","field":"location_country","value":"CA"}'::jsonb, tstzrange('2024-01-01T00:00:00Z', NULL), tstzrange('2024-01-01T00:00:00Z', NULL)),

  -- Benefit plans are many-to-many, which is why the brief lists them as
  -- "healthcare, retirement, commuter, gym stipend" rather than one choice.
  ('11111111-1111-1111-1111-111111111111', 'ab555555-5555-5555-5555-555555555555', '2024-01-01T00:00:00Z', 'd9999999-9999-9999-9999-999999999999', 'ec555555-5555-5555-5555-555555555555', 'Healthcare Plan', 'rule', 'grant', 0,
   '{"op":"always"}'::jsonb, tstzrange('2024-01-01T00:00:00Z', NULL), tstzrange('2024-01-01T00:00:00Z', NULL)),
  -- Static group membership drives this one.
  ('11111111-1111-1111-1111-111111111111', 'ab666666-6666-6666-6666-666666666666', '2024-01-01T00:00:00Z', 'd9999999-9999-9999-9999-999999999999', 'ec666666-6666-6666-6666-666666666666', 'HQ Commuter Benefit', 'rule', 'grant', 0,
   '{"op":"in_group","group":"hq"}'::jsonb, tstzrange('2024-01-01T00:00:00Z', NULL), tstzrange('2024-01-01T00:00:00Z', NULL)),
  -- Department rule, from the brief: "Engineering team gets a monitor and
  -- keyboard stipend". Routed through the dynamic `engineering` group, so the
  -- membership is recomputed from the predicate rather than maintained by hand.
  ('11111111-1111-1111-1111-111111111111', 'ab777777-7777-7777-7777-777777777777', '2024-01-01T00:00:00Z', 'd9999999-9999-9999-9999-999999999999', 'ec777777-7777-7777-7777-777777777777', 'Engineering Equipment Stipend', 'rule', 'grant', 0,
   '{"op":"in_group","group":"engineering"}'::jsonb, tstzrange('2024-01-01T00:00:00Z', NULL), tstzrange('2024-01-01T00:00:00Z', NULL)),

  -- Location rule, verbatim from the brief:
  -- "California-based employees must sign the CA Meal Break policy"
  --
  -- Scoped to the US deliberately. 'CA' is California in location_state and
  -- Canada in location_country, so a state-only predicate keeps the policy
  -- attached to someone who relocates to Canada. A California labour rule
  -- that follows an employee to Toronto is a compliance defect, not a quirk.
  ('11111111-1111-1111-1111-111111111111', 'ab888888-8888-8888-8888-888888888888', '2024-01-01T00:00:00Z', 'd3333333-3333-3333-3333-333333333333', 'ec888888-8888-8888-8888-888888888888', 'CA Meal Break Policy', 'rule', 'grant', 0,
   '{"op":"and","children":[{"op":"eq","field":"location_state","value":"CA"},{"op":"eq","field":"location_country","value":"US"}]}'::jsonb,
   tstzrange('2024-01-01T00:00:00Z', NULL), tstzrange('2024-01-01T00:00:00Z', NULL));
