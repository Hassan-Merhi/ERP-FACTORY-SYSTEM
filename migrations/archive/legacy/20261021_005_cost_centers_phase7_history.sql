-- Cost Centers Phase 7: auditable, opt-in historical analytical assignment.
-- Creating a preview records metadata ONLY: it does not change source vouchers,
-- Factory Daybook transactions, stock, foreign-exchange snapshots, or balances.
CREATE TABLE IF NOT EXISTS cost_center_historical_batches (
  id UUID PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  created_by TEXT NOT NULL,
  source_kind VARCHAR(24) NOT NULL,
  request_snapshot JSONB NOT NULL,
  source_snapshot JSONB NOT NULL,
  source_hash VARCHAR(64) NOT NULL,
  candidate_count INTEGER NOT NULL,
  candidate_native_total NUMERIC(20,6) NOT NULL,
  candidate_usd_total NUMERIC(20,6) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'PREVIEW',
  applied_by TEXT,
  applied_at TIMESTAMP,
  expires_at TIMESTAMP NOT NULL DEFAULT (now() + interval '20 minutes'),
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  CONSTRAINT cost_center_historical_batches_source_kind_ck
    CHECK (source_kind IN ('VOUCHER_ENTRY','FACTORY_DAYBOOK')),
  CONSTRAINT cost_center_historical_batches_status_ck
    CHECK (status IN ('PREVIEW','APPLIED')),
  CONSTRAINT cost_center_historical_batches_count_ck
    CHECK (candidate_count BETWEEN 1 AND 100),
  CONSTRAINT cost_center_historical_batches_amounts_ck
    CHECK (candidate_native_total > 0 AND candidate_usd_total >= 0),
  CONSTRAINT cost_center_historical_batches_applied_ck
    CHECK ((status='APPLIED' AND applied_at IS NOT NULL AND applied_by IS NOT NULL)
        OR (status='PREVIEW' AND applied_at IS NULL AND applied_by IS NULL))
);
CREATE INDEX IF NOT EXISTS cost_center_historical_batches_company_date_idx
  ON cost_center_historical_batches(company_id,created_at DESC);
CREATE INDEX IF NOT EXISTS cost_center_historical_batches_company_status_idx
  ON cost_center_historical_batches(company_id,status,expires_at);

-- Per-entry evidence is analytical only, never a new accounting voucher.
CREATE TABLE IF NOT EXISTS cost_center_historical_batch_items (
  id BIGSERIAL PRIMARY KEY,
  batch_id UUID NOT NULL REFERENCES cost_center_historical_batches(id) ON DELETE RESTRICT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  source_kind VARCHAR(24) NOT NULL,
  source_id INTEGER NOT NULL,
  source_native NUMERIC(20,6) NOT NULL,
  source_usd NUMERIC(20,6) NOT NULL,
  allocated_native NUMERIC(20,6) NOT NULL,
  allocated_usd NUMERIC(20,6) NOT NULL,
  applied_by TEXT NOT NULL,
  applied_at TIMESTAMP NOT NULL DEFAULT now(),
  CONSTRAINT cost_center_historical_batch_items_kind_ck
    CHECK (source_kind IN ('VOUCHER_ENTRY','FACTORY_DAYBOOK')),
  CONSTRAINT cost_center_historical_batch_items_amounts_ck
    CHECK (source_native > 0 AND source_usd >= 0
           AND allocated_native > 0 AND allocated_native <= source_native
           AND allocated_usd >= 0 AND allocated_usd <= source_usd),
  CONSTRAINT cost_center_historical_batch_items_source_unique
    UNIQUE(batch_id,source_kind,source_id)
);
CREATE INDEX IF NOT EXISTS cost_center_historical_batch_items_company_batch_idx
  ON cost_center_historical_batch_items(company_id,batch_id);

-- A record from another company cannot be attached to this batch.
CREATE UNIQUE INDEX IF NOT EXISTS cost_center_historical_batches_company_id_uidx
  ON cost_center_historical_batches(company_id,id);
DO $cc_history_company_fk$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname='cost_center_historical_batch_items_company_batch_fk'
  ) THEN
    ALTER TABLE cost_center_historical_batch_items
      ADD CONSTRAINT cost_center_historical_batch_items_company_batch_fk
      FOREIGN KEY (company_id,batch_id)
      REFERENCES cost_center_historical_batches(company_id,id) ON DELETE RESTRICT;
  END IF;
END
$cc_history_company_fk$;

ALTER TABLE cost_center_historical_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE cost_center_historical_batches FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cost_center_historical_batches_company_policy ON cost_center_historical_batches;
CREATE POLICY cost_center_historical_batches_company_policy ON cost_center_historical_batches
  USING (erp_company_scope_matches(company_id))
  WITH CHECK (erp_company_scope_matches(company_id));

ALTER TABLE cost_center_historical_batch_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE cost_center_historical_batch_items FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cost_center_historical_batch_items_company_policy ON cost_center_historical_batch_items;
CREATE POLICY cost_center_historical_batch_items_company_policy ON cost_center_historical_batch_items
  USING (erp_company_scope_matches(company_id))
  WITH CHECK (erp_company_scope_matches(company_id));

-- Preview plans are immutable snapshots. Apply can only update status,
-- actor, and timestamp; a new preview is required to change a plan.
CREATE OR REPLACE FUNCTION cost_center_historical_batch_guard()
RETURNS trigger LANGUAGE plpgsql AS $cc_history_guard$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.company_id IS DISTINCT FROM OLD.company_id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.source_kind IS DISTINCT FROM OLD.source_kind
     OR NEW.request_snapshot IS DISTINCT FROM OLD.request_snapshot
     OR NEW.source_snapshot IS DISTINCT FROM OLD.source_snapshot
     OR NEW.source_hash IS DISTINCT FROM OLD.source_hash
     OR NEW.candidate_count IS DISTINCT FROM OLD.candidate_count
     OR NEW.candidate_native_total IS DISTINCT FROM OLD.candidate_native_total
     OR NEW.candidate_usd_total IS DISTINCT FROM OLD.candidate_usd_total
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR OLD.status <> 'PREVIEW' OR NEW.status <> 'APPLIED'
  THEN RAISE EXCEPTION 'Historical allocation preview is immutable and may be applied only once'; END IF;
  RETURN NEW;
END
$cc_history_guard$;
DROP TRIGGER IF EXISTS cost_center_historical_batch_guard_trg
  ON cost_center_historical_batches;
CREATE TRIGGER cost_center_historical_batch_guard_trg
  BEFORE UPDATE ON cost_center_historical_batches
  FOR EACH ROW EXECUTE FUNCTION cost_center_historical_batch_guard();
