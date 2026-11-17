CREATE TABLE IF NOT EXISTS financial_periods (
  id BIGSERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED', 'REOPENED')),
  closed_at TIMESTAMPTZ,
  closed_by INTEGER REFERENCES users(id),
  close_reason TEXT,
  reopened_at TIMESTAMPTZ,
  reopened_by INTEGER REFERENCES users(id),
  reopen_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT financial_periods_valid_range CHECK (period_start <= period_end),
  CONSTRAINT financial_periods_company_range_unique UNIQUE (company_id, period_start, period_end)
);

CREATE INDEX IF NOT EXISTS financial_periods_company_status_idx
  ON financial_periods(company_id, status, period_start, period_end);

CREATE TABLE IF NOT EXISTS immutable_financial_audit_events (
  id BIGSERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  actor_user_id INTEGER REFERENCES users(id),
  event_type TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  event_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reason TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  previous_hash TEXT,
  event_hash TEXT NOT NULL,
  CONSTRAINT immutable_financial_audit_event_hash_unique UNIQUE (company_id, event_hash)
);

CREATE INDEX IF NOT EXISTS immutable_financial_audit_entity_idx
  ON immutable_financial_audit_events(company_id, entity_type, entity_id, event_at DESC);

CREATE OR REPLACE FUNCTION prevent_immutable_financial_audit_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'immutable_financial_audit_events rows cannot be updated or deleted';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS immutable_financial_audit_no_update ON immutable_financial_audit_events;
CREATE TRIGGER immutable_financial_audit_no_update
BEFORE UPDATE OR DELETE ON immutable_financial_audit_events
FOR EACH ROW EXECUTE FUNCTION prevent_immutable_financial_audit_mutation();
