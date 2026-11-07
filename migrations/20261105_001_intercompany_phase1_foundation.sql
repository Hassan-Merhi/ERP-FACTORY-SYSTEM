-- Phase 1: additive, inert intercompany foundation.
-- No existing containers, POs, vouchers, accounts, stock quantities, or balances are rewritten.
-- Trading and historical repairs remain disabled until explicitly enabled by later phases.

CREATE TABLE IF NOT EXISTS intercompany_relationship_policies (
  id SERIAL PRIMARY KEY,
  source_company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  destination_company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  relationship_type VARCHAR(40) NOT NULL,
  source_receivable_account_id INTEGER REFERENCES ledger_accounts(id) ON DELETE RESTRICT,
  destination_payable_account_id INTEGER REFERENCES ledger_accounts(id) ON DELETE RESTRICT,
  base_currency VARCHAR(3) NOT NULL DEFAULT 'USD',
  trade_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  immediate_reconciliation_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  nightly_reconciliation_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  historical_audit_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  historical_repair_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  historical_baseline_verified_at TIMESTAMPTZ,
  historical_repair_activated_at TIMESTAMPTZ,
  historical_repair_activated_by VARCHAR REFERENCES users(id) ON DELETE RESTRICT,
  auto_repair_per_item_limit NUMERIC(20,2),
  auto_repair_daily_limit NUMERIC(20,2),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT intercompany_policy_distinct_companies CHECK (source_company_id <> destination_company_id),
  CONSTRAINT intercompany_policy_version_positive CHECK (version > 0),
  CONSTRAINT intercompany_policy_currency CHECK (base_currency ~ '^[A-Z]{3}$'),
  CONSTRAINT intercompany_policy_limits_positive CHECK (
    (auto_repair_per_item_limit IS NULL OR auto_repair_per_item_limit > 0)
    AND (auto_repair_daily_limit IS NULL OR auto_repair_daily_limit > 0)
  ),
  CONSTRAINT intercompany_policy_active_trade_accounts CHECK (
    NOT trade_enabled OR (source_receivable_account_id IS NOT NULL AND destination_payable_account_id IS NOT NULL)
  ),
  CONSTRAINT intercompany_policy_historical_repair_gate CHECK (
    NOT historical_repair_enabled OR (
      historical_audit_enabled = TRUE
      AND historical_baseline_verified_at IS NOT NULL
      AND historical_repair_activated_by IS NOT NULL
      AND historical_repair_activated_at IS NOT NULL
      AND auto_repair_per_item_limit IS NOT NULL
      AND auto_repair_daily_limit IS NOT NULL
    )
  ),
  CONSTRAINT intercompany_policy_pair_type_unique UNIQUE (source_company_id, destination_company_id, relationship_type)
);
CREATE INDEX IF NOT EXISTS intercompany_policy_destination_idx ON intercompany_relationship_policies(destination_company_id);

-- Validate configured ledger IDs against their owning companies; no inference by account name.
CREATE OR REPLACE FUNCTION intercompany_check_policy_accounts()
RETURNS TRIGGER LANGUAGE plpgsql AS $check$
BEGIN
  IF NEW.source_receivable_account_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM ledger_accounts
                      WHERE id = NEW.source_receivable_account_id
                        AND company_id = NEW.source_company_id
                        AND deleted_at IS NULL) THEN
    RAISE EXCEPTION 'Intercompany receivable account must belong to source company';
  END IF;
  IF NEW.destination_payable_account_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM ledger_accounts
                      WHERE id = NEW.destination_payable_account_id
                        AND company_id = NEW.destination_company_id
                        AND deleted_at IS NULL) THEN
    RAISE EXCEPTION 'Intercompany payable account must belong to destination company';
  END IF;
  RETURN NEW;
END
$check$;
DROP TRIGGER IF EXISTS intercompany_policy_account_scope ON intercompany_relationship_policies;
CREATE TRIGGER intercompany_policy_account_scope
BEFORE INSERT OR UPDATE OF source_company_id, destination_company_id, source_receivable_account_id,
  destination_payable_account_id ON intercompany_relationship_policies
FOR EACH ROW EXECUTE FUNCTION intercompany_check_policy_accounts();

CREATE TABLE IF NOT EXISTS intercompany_trades (
  id SERIAL PRIMARY KEY,
  relationship_id INTEGER NOT NULL REFERENCES intercompany_relationship_policies(id) ON DELETE RESTRICT,
  physical_container_id INTEGER NOT NULL REFERENCES containers(id) ON DELETE RESTRICT,
  source_company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  destination_company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  original_supplier_po_id INTEGER REFERENCES purchase_orders(id) ON DELETE RESTRICT,
  destination_po_id INTEGER REFERENCES purchase_orders(id) ON DELETE RESTRICT,
  state VARCHAR(20) NOT NULL DEFAULT 'pending',
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  canceled_at TIMESTAMPTZ,
  CONSTRAINT intercompany_trade_state CHECK (state IN ('pending', 'active', 'canceled')),
  CONSTRAINT intercompany_trade_version_positive CHECK (version > 0),
  CONSTRAINT intercompany_trade_active_has_both_pos CHECK (
    state <> 'active' OR (original_supplier_po_id IS NOT NULL AND destination_po_id IS NOT NULL)
  ),
  CONSTRAINT intercompany_trade_distinct_companies CHECK (source_company_id <> destination_company_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS intercompany_trade_one_active_container
  ON intercompany_trades(physical_container_id) WHERE state = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS intercompany_trade_active_dest_po_unique
  ON intercompany_trades(destination_po_id) WHERE state = 'active' AND destination_po_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS intercompany_trade_relationship_idx ON intercompany_trades(relationship_id);
CREATE INDEX IF NOT EXISTS intercompany_trade_source_po_idx ON intercompany_trades(original_supplier_po_id);

-- A trade always refers to ONE existing physical container, with correct company ownership on the linked POs.
CREATE OR REPLACE FUNCTION intercompany_check_trade_links()
RETURNS TRIGGER LANGUAGE plpgsql AS $check$
DECLARE pair_record RECORD;
BEGIN
  SELECT source_company_id, destination_company_id, trade_enabled
    INTO pair_record FROM intercompany_relationship_policies
   WHERE id = NEW.relationship_id FOR SHARE;
  IF NOT FOUND OR pair_record.source_company_id <> NEW.source_company_id
     OR pair_record.destination_company_id <> NEW.destination_company_id THEN
    RAISE EXCEPTION 'Intercompany trade does not match its configured company relationship';
  END IF;
  IF NEW.state = 'active' AND NOT pair_record.trade_enabled THEN
    RAISE EXCEPTION 'Intercompany trading is disabled for this relationship';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM containers
                  WHERE id = NEW.physical_container_id AND company_id = NEW.source_company_id) THEN
    RAISE EXCEPTION 'Physical container must belong to the source company';
  END IF;
  IF NEW.original_supplier_po_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM purchase_orders WHERE id = NEW.original_supplier_po_id
                     AND company_id = NEW.source_company_id AND container_id = NEW.physical_container_id) THEN
    RAISE EXCEPTION 'Original PO must belong to source company and physical container';
  END IF;
  IF NEW.destination_po_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM purchase_orders WHERE id = NEW.destination_po_id
                     AND company_id = NEW.destination_company_id AND container_id = NEW.physical_container_id) THEN
    RAISE EXCEPTION 'Destination PO must belong to destination company and physical container';
  END IF;
  RETURN NEW;
END
$check$;
DROP TRIGGER IF EXISTS intercompany_trade_link_integrity ON intercompany_trades;
CREATE TRIGGER intercompany_trade_link_integrity
BEFORE INSERT OR UPDATE OF relationship_id, physical_container_id, source_company_id,
  destination_company_id, original_supplier_po_id, destination_po_id, state ON intercompany_trades
FOR EACH ROW EXECUTE FUNCTION intercompany_check_trade_links();

CREATE TABLE IF NOT EXISTS intercompany_import_batches (
  id SERIAL PRIMARY KEY,
  source_company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  file_name TEXT NOT NULL,
  file_sha256 VARCHAR(64) NOT NULL,
  request_fingerprint VARCHAR(64) NOT NULL,
  state VARCHAR(20) NOT NULL DEFAULT 'pending',
  created_by VARCHAR REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  confirmed_at TIMESTAMPTZ,
  CONSTRAINT intercompany_import_state CHECK (state IN ('pending', 'confirmed', 'failed')),
  CONSTRAINT intercompany_import_file_sha CHECK (file_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT intercompany_import_request_sha CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT intercompany_import_source_file_unique UNIQUE (source_company_id, file_sha256)
);
CREATE TABLE IF NOT EXISTS intercompany_import_batch_containers (
  id SERIAL PRIMARY KEY,
  batch_id INTEGER NOT NULL REFERENCES intercompany_import_batches(id) ON DELETE RESTRICT,
  container_number VARCHAR(100) NOT NULL,
  destination_company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  physical_container_id INTEGER REFERENCES containers(id) ON DELETE RESTRICT,
  trade_id INTEGER REFERENCES intercompany_trades(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT intercompany_import_batch_container_unique UNIQUE (batch_id, container_number)
);

CREATE TABLE IF NOT EXISTS intercompany_permission_grants (
  id SERIAL PRIMARY KEY,
  user_id VARCHAR NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  granting_company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  relationship_id INTEGER NOT NULL REFERENCES intercompany_relationship_policies(id) ON DELETE RESTRICT,
  permission VARCHAR(50) NOT NULL DEFAULT 'shared_charge_editor',
  scope VARCHAR(20) NOT NULL DEFAULT 'invoice',
  invoice_key VARCHAR(120),
  granted_by VARCHAR NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ,
  revoked_by VARCHAR REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT intercompany_grant_revoke_actor CHECK ((revoked_at IS NULL) = (revoked_by IS NULL)),
  CONSTRAINT intercompany_grant_permission CHECK (permission = 'shared_charge_editor'),
  CONSTRAINT intercompany_grant_scope CHECK (scope = 'invoice'),
  CONSTRAINT intercompany_grant_scope_target CHECK (invoice_key IS NOT NULL AND btrim(invoice_key) <> '')
);
-- Only Owners/Developers with access to an affected company can grant or revoke scoped access.
CREATE OR REPLACE FUNCTION intercompany_assert_permission_actor()
RETURNS TRIGGER LANGUAGE plpgsql AS $actor$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Intercompany permissions must be revoked, not deleted';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM intercompany_relationship_policies p
                 WHERE p.id = NEW.relationship_id
                   AND NEW.granting_company_id IN (p.source_company_id, p.destination_company_id)) THEN
    RAISE EXCEPTION 'Permission issuer company must participate in this relationship';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.user_id, NEW.granting_company_id, NEW.relationship_id, NEW.permission,
        NEW.scope, NEW.invoice_key, NEW.granted_by, NEW.created_at)
       IS DISTINCT FROM
       (OLD.user_id, OLD.granting_company_id, OLD.relationship_id, OLD.permission,
        OLD.scope, OLD.invoice_key, OLD.granted_by, OLD.created_at) THEN
      RAISE EXCEPTION 'Intercompany grants are immutable except for revocation';
    END IF;
    IF OLD.revoked_at IS NOT NULL AND
       (NEW.revoked_at IS DISTINCT FROM OLD.revoked_at OR NEW.revoked_by IS DISTINCT FROM OLD.revoked_by) THEN
      RAISE EXCEPTION 'A revoked intercompany grant cannot be altered or reinstated';
    END IF;
    IF NEW.revoked_at IS DISTINCT FROM OLD.revoked_at AND
       NOT EXISTS (SELECT 1 FROM user_company_roles
                   WHERE user_id = NEW.revoked_by
                     AND company_id = NEW.granting_company_id
                     AND role IN ('Owner', 'Developer')) THEN
      RAISE EXCEPTION 'Only an Owner or Developer can revoke shared-charge permissions';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM user_company_roles
                 WHERE user_id = NEW.granted_by
                   AND company_id = NEW.granting_company_id
                   AND role IN ('Owner', 'Developer')) THEN
    RAISE EXCEPTION 'Only an Owner or Developer can grant shared-charge permissions';
  END IF;
  RETURN NEW;
END
$actor$;
DROP TRIGGER IF EXISTS intercompany_permission_actor_guard ON intercompany_permission_grants;
CREATE TRIGGER intercompany_permission_actor_guard
BEFORE INSERT OR UPDATE OR DELETE ON intercompany_permission_grants
FOR EACH ROW EXECUTE FUNCTION intercompany_assert_permission_actor();

CREATE INDEX IF NOT EXISTS intercompany_grant_user_company_idx
  ON intercompany_permission_grants(user_id, granting_company_id);
-- NULLS do not create duplicate grants; expression index prevents repeated active grants with NULL targets.
CREATE UNIQUE INDEX IF NOT EXISTS intercompany_grant_active_unique
  ON intercompany_permission_grants(user_id, granting_company_id, permission, scope,
    coalesce(invoice_key, ''), coalesce(relationship_id, 0))
  WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS intercompany_audit_events (
  id SERIAL PRIMARY KEY,
  event_key VARCHAR(160) NOT NULL UNIQUE,
  relationship_id INTEGER REFERENCES intercompany_relationship_policies(id) ON DELETE RESTRICT,
  source_company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  actor_user_id VARCHAR REFERENCES users(id) ON DELETE RESTRICT,
  event_type VARCHAR(100) NOT NULL,
  source_reference TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS intercompany_audit_relationship_idx
  ON intercompany_audit_events(relationship_id, created_at);
CREATE OR REPLACE FUNCTION intercompany_forbid_audit_changes()
RETURNS TRIGGER LANGUAGE plpgsql AS $no_mutation$
BEGIN
  RAISE EXCEPTION 'Intercompany audit events are immutable';
END
$no_mutation$;
DROP TRIGGER IF EXISTS intercompany_audit_no_mutation ON intercompany_audit_events;
CREATE TRIGGER intercompany_audit_no_mutation
BEFORE UPDATE OR DELETE ON intercompany_audit_events
FOR EACH ROW EXECUTE FUNCTION intercompany_forbid_audit_changes();

CREATE TABLE IF NOT EXISTS intercompany_reconciliation_runs (
  id SERIAL PRIMARY KEY,
  relationship_id INTEGER REFERENCES intercompany_relationship_policies(id) ON DELETE RESTRICT,
  run_kind VARCHAR(32) NOT NULL,
  state VARCHAR(20) NOT NULL DEFAULT 'pending',
  audit_only BOOLEAN NOT NULL DEFAULT TRUE,
  cutoff_date DATE NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  error TEXT,
  CONSTRAINT intercompany_run_kind CHECK (run_kind IN ('baseline', 'immediate', 'nightly', 'repair_preview')),
  CONSTRAINT intercompany_run_state CHECK (state IN ('pending', 'running', 'completed', 'failed'))
);
CREATE INDEX IF NOT EXISTS intercompany_run_relationship_idx
  ON intercompany_reconciliation_runs(relationship_id, started_at);

CREATE TABLE IF NOT EXISTS intercompany_reconciliation_findings (
  id SERIAL PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES intercompany_reconciliation_runs(id) ON DELETE RESTRICT,
  relationship_id INTEGER NOT NULL REFERENCES intercompany_relationship_policies(id) ON DELETE RESTRICT,
  finding_fingerprint VARCHAR(64) NOT NULL,
  evidence_fingerprint VARCHAR(64),
  status VARCHAR(24) NOT NULL DEFAULT 'investigate',
  verified BOOLEAN NOT NULL DEFAULT FALSE,
  difference_base_amount NUMERIC(20,2) NOT NULL DEFAULT 0,
  original_transaction_date DATE,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT intercompany_finding_status CHECK (status IN ('matched', 'investigate', 'verified', 'repaired', 'held')),
  CONSTRAINT intercompany_run_finding_unique UNIQUE (run_id, finding_fingerprint)
);
CREATE INDEX IF NOT EXISTS intercompany_finding_relationship_status_idx
  ON intercompany_reconciliation_findings(relationship_id, status);

CREATE TABLE IF NOT EXISTS intercompany_repair_requests (
  id SERIAL PRIMARY KEY,
  finding_id INTEGER NOT NULL REFERENCES intercompany_reconciliation_findings(id) ON DELETE RESTRICT,
  relationship_id INTEGER NOT NULL REFERENCES intercompany_relationship_policies(id) ON DELETE RESTRICT,
  request_key VARCHAR(160) NOT NULL UNIQUE,
  evidence_fingerprint VARCHAR(64) NOT NULL,
  absolute_base_amount NUMERIC(20,2) NOT NULL,
  state VARCHAR(24) NOT NULL DEFAULT 'held',
  original_transaction_date DATE NOT NULL,
  proposed_posting_date DATE,
  approved_by VARCHAR REFERENCES users(id) ON DELETE RESTRICT,
  approved_at TIMESTAMPTZ,
  posted_voucher_id INTEGER REFERENCES vouchers(id) ON DELETE RESTRICT,
  posted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT intercompany_repair_amount CHECK (absolute_base_amount > 0),
  CONSTRAINT intercompany_repair_state CHECK (state IN ('held', 'approved', 'rejected', 'posted', 'failed')),
  CONSTRAINT intercompany_repair_approval_check CHECK (
    state NOT IN ('approved', 'posted') OR (approved_by IS NOT NULL AND approved_at IS NOT NULL)
  ),
  CONSTRAINT intercompany_repair_posted_check CHECK (
    state <> 'posted' OR (posted_at IS NOT NULL AND posted_voucher_id IS NOT NULL AND proposed_posting_date IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS intercompany_repair_relationship_state_idx
  ON intercompany_repair_requests(relationship_id, state);
