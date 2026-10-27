-- Pressing Machines tracking Phase 1 (schema only).
-- Does not change factory_bales state, stock counts, material consumption, or accounting.
-- The same idempotent statements run in startup stage 037.
CREATE TABLE IF NOT EXISTS factory_pressing_machines (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  machine_code VARCHAR(60) NOT NULL,
  name VARCHAR(160) NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  target_bales_per_hour NUMERIC(12,3),
  created_by VARCHAR(255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT factory_pressing_machines_target_ck CHECK (target_bales_per_hour IS NULL OR target_bales_per_hour > 0),
  CONSTRAINT factory_pressing_machines_code_uk UNIQUE (company_id, machine_code)
);

CREATE UNIQUE INDEX IF NOT EXISTS factory_pressing_machines_tenant_id_uk ON factory_pressing_machines (company_id, id);

CREATE INDEX IF NOT EXISTS factory_pressing_machines_company_active_idx ON factory_pressing_machines (company_id, active);

CREATE TABLE IF NOT EXISTS factory_pressing_assignments (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  machine_id INTEGER NOT NULL,
  user_id VARCHAR(255) NOT NULL,
  assigned_by VARCHAR(255) NOT NULL,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  unassigned_at TIMESTAMPTZ,
  unassigned_by VARCHAR(255),
  CONSTRAINT factory_pressing_assignments_machine_fk FOREIGN KEY (company_id, machine_id) REFERENCES factory_pressing_machines (company_id, id) ON DELETE RESTRICT,
  CONSTRAINT factory_pressing_assignments_interval_ck CHECK (unassigned_at IS NULL OR unassigned_at >= assigned_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS factory_pressing_assignments_tenant_id_uk ON factory_pressing_assignments (company_id, id);

CREATE UNIQUE INDEX IF NOT EXISTS factory_pressing_assignments_active_user_uk ON factory_pressing_assignments (company_id, user_id) WHERE unassigned_at IS NULL;

CREATE INDEX IF NOT EXISTS factory_pressing_assignments_machine_date_idx ON factory_pressing_assignments (company_id, machine_id, assigned_at DESC);

CREATE TABLE IF NOT EXISTS factory_pressing_shifts (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  shift_code VARCHAR(50) NOT NULL,
  name VARCHAR(120) NOT NULL,
  start_local TIME NOT NULL,
  end_local TIME NOT NULL,
  timezone_name VARCHAR(100) NOT NULL DEFAULT 'UTC',
  active BOOLEAN NOT NULL DEFAULT true,
  created_by VARCHAR(255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT factory_pressing_shifts_code_uk UNIQUE (company_id, shift_code),
  CONSTRAINT factory_pressing_shifts_hours_ck CHECK (start_local <> end_local)
);

CREATE UNIQUE INDEX IF NOT EXISTS factory_pressing_shifts_tenant_id_uk ON factory_pressing_shifts (company_id, id);

CREATE TABLE IF NOT EXISTS factory_pressing_sessions (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  machine_id INTEGER NOT NULL,
  assignment_id INTEGER NOT NULL,
  user_id VARCHAR(255) NOT NULL,
  shift_id INTEGER,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ,
  CONSTRAINT factory_pressing_sessions_machine_fk FOREIGN KEY (company_id, machine_id) REFERENCES factory_pressing_machines (company_id, id) ON DELETE RESTRICT,
  CONSTRAINT factory_pressing_sessions_assignment_fk FOREIGN KEY (company_id, assignment_id) REFERENCES factory_pressing_assignments (company_id, id) ON DELETE RESTRICT,
  CONSTRAINT factory_pressing_sessions_shift_fk FOREIGN KEY (company_id, shift_id) REFERENCES factory_pressing_shifts (company_id, id) ON DELETE RESTRICT,
  CONSTRAINT factory_pressing_sessions_interval_ck CHECK (ended_at IS NULL OR ended_at >= started_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS factory_pressing_sessions_tenant_id_uk ON factory_pressing_sessions (company_id, id);

CREATE UNIQUE INDEX IF NOT EXISTS factory_pressing_sessions_active_user_uk ON factory_pressing_sessions (company_id, user_id) WHERE ended_at IS NULL;

CREATE INDEX IF NOT EXISTS factory_pressing_sessions_machine_date_idx ON factory_pressing_sessions (company_id, machine_id, started_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS factory_bales_pressing_tenant_id_uk ON factory_bales (company_id, id);

CREATE TABLE IF NOT EXISTS factory_pressing_confirmations (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  bale_id INTEGER NOT NULL,
  machine_id INTEGER NOT NULL,
  assignment_id INTEGER NOT NULL,
  session_id INTEGER NOT NULL,
  shift_id INTEGER,
  user_id VARCHAR(255) NOT NULL,
  user_name_snapshot TEXT,
  machine_name_snapshot TEXT NOT NULL,
  reference_number VARCHAR(100) NOT NULL,
  article_code VARCHAR(50),
  product_name TEXT,
  weight_kg NUMERIC(15,3) NOT NULL,
  request_id VARCHAR(120) NOT NULL,
  device_captured_at TIMESTAMPTZ,
  confirmed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  production_date DATE NOT NULL,
  timezone_name VARCHAR(100) NOT NULL,
  voided_at TIMESTAMPTZ,
  voided_by VARCHAR(255),
  CONSTRAINT factory_pressing_confirmations_bale_fk FOREIGN KEY (company_id, bale_id) REFERENCES factory_bales (company_id, id) ON DELETE RESTRICT,
  CONSTRAINT factory_pressing_confirmations_machine_fk FOREIGN KEY (company_id, machine_id) REFERENCES factory_pressing_machines (company_id, id) ON DELETE RESTRICT,
  CONSTRAINT factory_pressing_confirmations_assignment_fk FOREIGN KEY (company_id, assignment_id) REFERENCES factory_pressing_assignments (company_id, id) ON DELETE RESTRICT,
  CONSTRAINT factory_pressing_confirmations_session_fk FOREIGN KEY (company_id, session_id) REFERENCES factory_pressing_sessions (company_id, id) ON DELETE RESTRICT,
  CONSTRAINT factory_pressing_confirmations_shift_fk FOREIGN KEY (company_id, shift_id) REFERENCES factory_pressing_shifts (company_id, id) ON DELETE RESTRICT,
  CONSTRAINT factory_pressing_confirmations_weight_ck CHECK (weight_kg >= 0),
  CONSTRAINT factory_pressing_confirmations_void_ck CHECK ((voided_at IS NULL AND voided_by IS NULL) OR (voided_at IS NOT NULL AND voided_by IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS factory_pressing_confirmations_tenant_id_uk ON factory_pressing_confirmations (company_id, id);

CREATE UNIQUE INDEX IF NOT EXISTS factory_pressing_confirmations_request_uk ON factory_pressing_confirmations (company_id, request_id);

CREATE UNIQUE INDEX IF NOT EXISTS factory_pressing_confirmations_one_active_bale_uk ON factory_pressing_confirmations (company_id, bale_id) WHERE voided_at IS NULL;

CREATE INDEX IF NOT EXISTS factory_pressing_confirmations_date_idx ON factory_pressing_confirmations (company_id, production_date, confirmed_at DESC);

CREATE INDEX IF NOT EXISTS factory_pressing_confirmations_machine_date_idx ON factory_pressing_confirmations (company_id, machine_id, production_date, confirmed_at DESC);

CREATE INDEX IF NOT EXISTS factory_pressing_confirmations_operator_date_idx ON factory_pressing_confirmations (company_id, user_id, production_date);

CREATE TABLE IF NOT EXISTS factory_pressing_downtime (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  machine_id INTEGER NOT NULL,
  session_id INTEGER,
  reported_by VARCHAR(255) NOT NULL,
  reason_code VARCHAR(60) NOT NULL,
  reason_notes TEXT,
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT factory_pressing_downtime_machine_fk FOREIGN KEY (company_id, machine_id) REFERENCES factory_pressing_machines (company_id, id) ON DELETE RESTRICT,
  CONSTRAINT factory_pressing_downtime_session_fk FOREIGN KEY (company_id, session_id) REFERENCES factory_pressing_sessions (company_id, id) ON DELETE RESTRICT,
  CONSTRAINT factory_pressing_downtime_interval_ck CHECK (ended_at IS NULL OR ended_at >= started_at),
  CONSTRAINT factory_pressing_downtime_reason_ck CHECK (length(btrim(reason_code)) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS factory_pressing_downtime_open_machine_uk ON factory_pressing_downtime (company_id, machine_id) WHERE ended_at IS NULL;

CREATE INDEX IF NOT EXISTS factory_pressing_downtime_machine_date_idx ON factory_pressing_downtime (company_id, machine_id, started_at DESC);

CREATE TABLE IF NOT EXISTS factory_pressing_corrections (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  confirmation_id INTEGER NOT NULL,
  replacement_confirmation_id INTEGER,
  action VARCHAR(30) NOT NULL,
  reason TEXT NOT NULL,
  supervisor_user_id VARCHAR(255) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT factory_pressing_corrections_original_fk FOREIGN KEY (company_id, confirmation_id) REFERENCES factory_pressing_confirmations (company_id, id) ON DELETE RESTRICT,
  CONSTRAINT factory_pressing_corrections_replacement_fk FOREIGN KEY (company_id, replacement_confirmation_id) REFERENCES factory_pressing_confirmations (company_id, id) ON DELETE RESTRICT,
  CONSTRAINT factory_pressing_corrections_action_ck CHECK (action IN ('VOID','RECONFIRM')),
  CONSTRAINT factory_pressing_corrections_reason_ck CHECK (length(btrim(reason)) > 0),
  CONSTRAINT factory_pressing_corrections_distinct_ck CHECK (replacement_confirmation_id IS NULL OR replacement_confirmation_id <> confirmation_id)
);

CREATE INDEX IF NOT EXISTS factory_pressing_corrections_date_idx ON factory_pressing_corrections (company_id, created_at DESC);

CREATE INDEX IF NOT EXISTS factory_pressing_corrections_confirmation_idx ON factory_pressing_corrections (company_id, confirmation_id);

CREATE TABLE IF NOT EXISTS factory_pressing_saved_views (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  user_id VARCHAR(255) NOT NULL,
  name VARCHAR(120) NOT NULL,
  report_mode VARCHAR(20) NOT NULL DEFAULT 'detailed',
  filters JSONB NOT NULL DEFAULT '{}'::jsonb,
  visible_columns JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_default BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT factory_pressing_saved_views_name_uk UNIQUE (company_id, user_id, name),
  CONSTRAINT factory_pressing_saved_views_mode_ck CHECK (report_mode IN ('detailed', 'condensed')),
  CONSTRAINT factory_pressing_saved_views_filters_ck CHECK (jsonb_typeof(filters) = 'object'),
  CONSTRAINT factory_pressing_saved_views_columns_ck CHECK (jsonb_typeof(visible_columns) = 'array')
);

CREATE UNIQUE INDEX IF NOT EXISTS factory_pressing_saved_views_default_user_uk ON factory_pressing_saved_views (company_id, user_id) WHERE is_default = true;

CREATE OR REPLACE FUNCTION factory_pressing_corrections_append_only() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Pressing correction history is append-only'; END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'factory_pressing_corrections_immutable_trg' AND tgrelid = 'factory_pressing_corrections'::regclass) THEN
    CREATE TRIGGER factory_pressing_corrections_immutable_trg
    BEFORE UPDATE OR DELETE ON factory_pressing_corrections
    FOR EACH ROW EXECUTE FUNCTION factory_pressing_corrections_append_only();
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS factory_pressing_assignments_identity_uk ON factory_pressing_assignments (company_id, id, machine_id, user_id);

CREATE UNIQUE INDEX IF NOT EXISTS factory_pressing_sessions_identity_uk ON factory_pressing_sessions (company_id, id, machine_id, assignment_id, user_id);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'factory_pressing_sessions_assignment_identity_fk' AND conrelid = 'factory_pressing_sessions'::regclass) THEN
    ALTER TABLE factory_pressing_sessions ADD CONSTRAINT factory_pressing_sessions_assignment_identity_fk
    FOREIGN KEY (company_id, assignment_id, machine_id, user_id)
    REFERENCES factory_pressing_assignments (company_id, id, machine_id, user_id) ON DELETE RESTRICT;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'factory_pressing_confirmations_session_identity_fk' AND conrelid = 'factory_pressing_confirmations'::regclass) THEN
    ALTER TABLE factory_pressing_confirmations ADD CONSTRAINT factory_pressing_confirmations_session_identity_fk
    FOREIGN KEY (company_id, session_id, machine_id, assignment_id, user_id)
    REFERENCES factory_pressing_sessions (company_id, id, machine_id, assignment_id, user_id) ON DELETE RESTRICT;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION factory_pressing_confirmations_protect() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Pressing confirmations cannot be deleted';
  END IF;
  IF OLD.voided_at IS NOT NULL
     OR NEW.voided_at IS NULL
     OR NEW.voided_by IS NULL
     OR (to_jsonb(NEW) - 'voided_at' - 'voided_by') IS DISTINCT FROM (to_jsonb(OLD) - 'voided_at' - 'voided_by')
  THEN
    RAISE EXCEPTION 'Only a single audited void may update a pressing confirmation';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM factory_pressing_corrections c
    WHERE c.company_id = OLD.company_id
      AND c.confirmation_id = OLD.id
      AND c.action = 'VOID'
      AND c.supervisor_user_id = NEW.voided_by
  ) THEN
    RAISE EXCEPTION 'A supervisor correction event must be recorded before voiding a pressing confirmation';
  END IF;
  RETURN NEW;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'factory_pressing_confirmations_protect_trg' AND tgrelid = 'factory_pressing_confirmations'::regclass) THEN
    CREATE TRIGGER factory_pressing_confirmations_protect_trg
    BEFORE UPDATE OR DELETE ON factory_pressing_confirmations
    FOR EACH ROW EXECUTE FUNCTION factory_pressing_confirmations_protect();
  END IF;
END $$;
