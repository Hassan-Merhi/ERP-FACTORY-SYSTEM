-- 0007_intercompany_container_trading.sql
--
-- Intercompany container trading (merged to main in #2870). Main shipped this
-- schema the old way: six date-named Drizzle-journal migrations, two statements
-- appended to startup-schema/010, and a runtime catch-up for the physical-delete
-- guard. Under migrations-only schema truth those are folded here, verbatim and
-- in their original order; the originals are kept under migrations/archive/legacy.
--
--   1. supplier_proformas.destination_company_id and its lookup index
--      (were in server/startup-schema/010-security-notifications-and-precision.ts)
--   2. 20261105_001_intercompany_phase1_foundation.sql
--   3. 20261105_002_intercompany_phase2_import.sql
--   4. 20261105_003_intercompany_phase3_sync.sql
--   5. 20261105_004_intercompany_phase4_payments.sql
--   6. 20261105_005_intercompany_phase5_lifecycle.sql
--   7. 20261113_001_intercompany_pristine_physical_delete.sql
--      (replaces server/services/intercompany/ensureLinkedPhysicalDeleteGuard.ts;
--       the startup gate now proves the guarded function body is installed)
--
-- Additive only: new tables, functions, triggers, indexes and one nullable
-- column. Every CREATE is IF NOT EXISTS / OR REPLACE, so a database that already
-- ran the feature-branch migrations (the Factory copy) converges on the same
-- definitions. No existing container, PO, voucher, account, stock or balance row
-- is changed. Trading stays disabled until a relationship policy enables it.

-- ── 1. supplier proforma destination company ─────────────────────────────────
ALTER TABLE supplier_proformas ADD COLUMN IF NOT EXISTS destination_company_id integer REFERENCES companies(id);
CREATE INDEX IF NOT EXISTS supplier_proformas_destination_idx ON supplier_proformas (company_id, supplier_id, destination_company_id);

-- ══ 20261105_001_intercompany_phase1_foundation.sql ══════════════════════════════════════════════
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


-- ══ 20261105_002_intercompany_phase2_import.sql ══════════════════════════════════════════════
-- Phase 2: configuration references and original supplier PO provenance.
-- Inert until an Owner/Developer explicitly enables a configured company pair.
-- Never rewrites existing purchase orders, containers, journals or stock.
ALTER TABLE intercompany_relationship_policies
  ADD COLUMN IF NOT EXISTS destination_supplier_id INTEGER REFERENCES suppliers(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS source_purchase_account_id INTEGER REFERENCES ledger_accounts(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS source_sales_account_id INTEGER REFERENCES ledger_accounts(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS source_cost_account_id INTEGER REFERENCES ledger_accounts(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS source_charge_accrual_account_id INTEGER REFERENCES ledger_accounts(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS destination_git_account_id INTEGER REFERENCES ledger_accounts(id) ON DELETE RESTRICT;

ALTER TABLE intercompany_relationship_policies
  DROP CONSTRAINT IF EXISTS intercompany_policy_phase2_configuration;
ALTER TABLE intercompany_relationship_policies
  ADD CONSTRAINT intercompany_policy_phase2_configuration CHECK (
    NOT trade_enabled OR (
      destination_supplier_id IS NOT NULL AND
      source_purchase_account_id IS NOT NULL AND
      source_sales_account_id IS NOT NULL AND
      source_cost_account_id IS NOT NULL AND
      source_charge_accrual_account_id IS NOT NULL AND
      destination_git_account_id IS NOT NULL
    )
  );

CREATE TABLE IF NOT EXISTS intercompany_trade_source_pos (
  id BIGSERIAL PRIMARY KEY,
  trade_id INTEGER NOT NULL REFERENCES intercompany_trades(id) ON DELETE RESTRICT,
  source_po_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE RESTRICT,
  original_po_number TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT intercompany_trade_source_po_unique UNIQUE(source_po_id),
  CONSTRAINT intercompany_trade_source_po_pair_unique UNIQUE(trade_id, source_po_id)
);
CREATE INDEX IF NOT EXISTS intercompany_trade_source_pos_trade_idx
  ON intercompany_trade_source_pos(trade_id);

ALTER TABLE intercompany_import_batch_containers
  ADD COLUMN IF NOT EXISTS charges_confirmed BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS charge_evidence_reference TEXT,
  ADD COLUMN IF NOT EXISTS confirmed_landed_cost NUMERIC(20,2);

ALTER TABLE intercompany_import_batch_containers
  DROP CONSTRAINT IF EXISTS intercompany_import_confirmed_charge_evidence;
ALTER TABLE intercompany_import_batch_containers
  ADD CONSTRAINT intercompany_import_confirmed_charge_evidence CHECK (
    NOT charges_confirmed OR
    (charge_evidence_reference IS NOT NULL AND length(btrim(charge_evidence_reference)) >= 3)
  );

-- Verify that configuration references their actual company owners.
CREATE OR REPLACE FUNCTION intercompany_check_policy_accounts()
RETURNS TRIGGER LANGUAGE plpgsql AS $check$
DECLARE checks RECORD;
BEGIN
  FOR checks IN
    SELECT 'source receivable' AS label, NEW.source_receivable_account_id AS account_id,
           NEW.source_company_id AS company_id
    UNION ALL SELECT 'destination payable', NEW.destination_payable_account_id, NEW.destination_company_id
    UNION ALL SELECT 'source purchases', NEW.source_purchase_account_id, NEW.source_company_id
    UNION ALL SELECT 'source sales', NEW.source_sales_account_id, NEW.source_company_id
    UNION ALL SELECT 'source cost', NEW.source_cost_account_id, NEW.source_company_id
    UNION ALL SELECT 'source charge accrual', NEW.source_charge_accrual_account_id, NEW.source_company_id
    UNION ALL SELECT 'destination goods in transit', NEW.destination_git_account_id, NEW.destination_company_id
  LOOP
    IF checks.account_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM ledger_accounts a
       WHERE a.id = checks.account_id AND a.company_id = checks.company_id AND a.deleted_at IS NULL
    ) THEN
      RAISE EXCEPTION 'Intercompany % account must belong to its configured company', checks.label;
    END IF;
  END LOOP;
  IF NEW.destination_supplier_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM suppliers s
     WHERE s.id = NEW.destination_supplier_id
       AND s.company_id = NEW.destination_company_id
       AND s.deleted_at IS NULL AND s.active = TRUE
  ) THEN
    RAISE EXCEPTION 'Intercompany destination supplier must belong to destination company';
  END IF;
  RETURN NEW;
END $check$;

DROP TRIGGER IF EXISTS intercompany_policy_account_scope ON intercompany_relationship_policies;
CREATE TRIGGER intercompany_policy_account_scope
BEFORE INSERT OR UPDATE OF
  source_company_id, destination_company_id,
  source_receivable_account_id, destination_payable_account_id,
  source_purchase_account_id, source_sales_account_id, source_cost_account_id, source_charge_accrual_account_id,
  destination_git_account_id, destination_supplier_id
ON intercompany_relationship_policies
FOR EACH ROW EXECUTE FUNCTION intercompany_check_policy_accounts();

-- A linked trade has one immutable physical source and cannot be marked active
-- until the complete source/destination purchase order linkage exists.
CREATE OR REPLACE FUNCTION intercompany_check_source_po_link()
RETURNS TRIGGER LANGUAGE plpgsql AS $check$
DECLARE trade_record RECORD;
BEGIN
  SELECT source_company_id, physical_container_id INTO trade_record
    FROM intercompany_trades WHERE id = NEW.trade_id;
  IF NOT FOUND OR NOT EXISTS (
    SELECT 1 FROM purchase_orders po
     WHERE po.id = NEW.source_po_id
       AND po.company_id = trade_record.source_company_id
       AND po.container_id = trade_record.physical_container_id
  ) THEN
    RAISE EXCEPTION 'Linked external supplier PO must belong to source company and physical container';
  END IF;
  RETURN NEW;
END $check$;

DROP TRIGGER IF EXISTS intercompany_source_po_integrity ON intercompany_trade_source_pos;
CREATE TRIGGER intercompany_source_po_integrity
BEFORE INSERT OR UPDATE ON intercompany_trade_source_pos
FOR EACH ROW EXECUTE FUNCTION intercompany_check_source_po_link();

-- A future offload or physical container state change must be handled by the
-- Phase 5 stock-ownership service. Until then fail closed, not with duplicate stock.
CREATE OR REPLACE FUNCTION intercompany_block_legacy_offload()
RETURNS TRIGGER LANGUAGE plpgsql AS $block$
DECLARE physical_id INTEGER;
BEGIN
  IF TG_TABLE_NAME = 'container_offloads' THEN
    physical_id := NEW.container_id;
  ELSE
    physical_id := NEW.id;
  END IF;
  IF EXISTS (
    SELECT 1 FROM intercompany_trades
    WHERE physical_container_id = physical_id AND state = 'active'
  ) THEN
    RAISE EXCEPTION 'Linked intercompany container offloading requires the Phase 5 ownership workflow';
  END IF;
  RETURN NEW;
END $block$;

DROP TRIGGER IF EXISTS intercompany_legacy_offload_guard ON container_offloads;
CREATE TRIGGER intercompany_legacy_offload_guard
BEFORE INSERT ON container_offloads
FOR EACH ROW EXECUTE FUNCTION intercompany_block_legacy_offload();

DROP TRIGGER IF EXISTS intercompany_legacy_container_state_guard ON containers;
CREATE TRIGGER intercompany_legacy_container_state_guard
BEFORE UPDATE OF status ON containers
FOR EACH ROW WHEN (NEW.status IN ('OFFLOADED', 'SOLD') AND OLD.status IS DISTINCT FROM NEW.status)
EXECUTE FUNCTION intercompany_block_legacy_offload();


-- Existing PO edit routes do not know how to mirror an intercompany transaction.
-- Fail closed until Phase 3 replaces these protections with linked sync logic.
CREATE OR REPLACE FUNCTION intercompany_block_legacy_po_change()
RETURNS TRIGGER LANGUAGE plpgsql AS $blocked$
DECLARE po_id INTEGER;
BEGIN
  IF TG_TABLE_NAME = 'po_line_items' THEN
    po_id := CASE WHEN TG_OP = 'INSERT' THEN NEW.po_id ELSE OLD.po_id END;
  ELSE
    po_id := OLD.id;
  END IF;
  IF TG_TABLE_NAME = 'po_line_items' THEN
    IF TG_OP = 'UPDATE' THEN
      IF NEW.po_id IS DISTINCT FROM OLD.po_id THEN
        IF EXISTS (
          SELECT 1 FROM intercompany_trades t WHERE t.state='active'
          AND (t.destination_po_id=NEW.po_id OR t.original_supplier_po_id=NEW.po_id)
        ) OR EXISTS (
          SELECT 1 FROM intercompany_trade_source_pos sp
          JOIN intercompany_trades t ON t.id=sp.trade_id
          WHERE t.state='active' AND sp.source_po_id=NEW.po_id
        ) THEN
          RAISE EXCEPTION 'Cannot move PO line into an active intercompany purchase order';
        END IF;
      END IF;
    END IF;
  END IF;
  IF EXISTS (
    SELECT 1 FROM intercompany_trades t
    WHERE t.state = 'active' AND
      (t.destination_po_id = po_id OR t.original_supplier_po_id = po_id)
  ) OR EXISTS (
    SELECT 1 FROM intercompany_trade_source_pos link
    INNER JOIN intercompany_trades t ON t.id = link.trade_id
    WHERE t.state = 'active' AND link.source_po_id = po_id
  ) THEN
    RAISE EXCEPTION 'Linked intercompany purchase orders require the Phase 3 synchronized editing workflow';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $blocked$;

DROP TRIGGER IF EXISTS intercompany_legacy_po_guard ON purchase_orders;
CREATE TRIGGER intercompany_legacy_po_guard
BEFORE UPDATE OR DELETE ON purchase_orders
FOR EACH ROW EXECUTE FUNCTION intercompany_block_legacy_po_change();

DROP TRIGGER IF EXISTS intercompany_legacy_po_line_guard ON po_line_items;
CREATE TRIGGER intercompany_legacy_po_line_guard
BEFORE INSERT OR UPDATE OR DELETE ON po_line_items
FOR EACH ROW EXECUTE FUNCTION intercompany_block_legacy_po_change();

CREATE OR REPLACE FUNCTION intercompany_block_legacy_charge_change()
RETURNS TRIGGER LANGUAGE plpgsql AS $blocked$
DECLARE physical_id INTEGER;
BEGIN
  IF TG_OP = 'INSERT' THEN
    physical_id := NEW.container_id;
  ELSE
    physical_id := OLD.container_id;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.container_id IS DISTINCT FROM OLD.container_id AND EXISTS (
    SELECT 1 FROM intercompany_trades
    WHERE physical_container_id = NEW.container_id AND state='active'
  ) THEN
    RAISE EXCEPTION 'Cannot move charge into a linked intercompany container';
  END IF;
  IF EXISTS (
    SELECT 1 FROM intercompany_trades
    WHERE physical_container_id = physical_id AND state = 'active'
  ) THEN
    RAISE EXCEPTION 'Linked intercompany charges require the Phase 3 synchronized allocation workflow';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $blocked$;

DROP TRIGGER IF EXISTS intercompany_legacy_charge_guard ON container_charges;
CREATE TRIGGER intercompany_legacy_charge_guard
BEFORE INSERT OR UPDATE OR DELETE ON container_charges
FOR EACH ROW EXECUTE FUNCTION intercompany_block_legacy_charge_change();

-- Financial vouchers linked to these POs or their original at-cost resale must
-- not be retired or changed by standalone voucher tools.
CREATE OR REPLACE FUNCTION intercompany_block_legacy_voucher_change()
RETURNS TRIGGER LANGUAGE plpgsql AS $blocked$
BEGIN
  IF EXISTS (
    SELECT 1 FROM intercompany_trades t
    LEFT JOIN purchase_orders src ON src.id = t.original_supplier_po_id
    LEFT JOIN purchase_orders dst ON dst.id = t.destination_po_id
    WHERE t.state = 'active'
      AND (src.voucher_id = OLD.id OR dst.voucher_id = OLD.id)
  ) OR EXISTS (
    SELECT 1 FROM intercompany_trade_source_pos link
    JOIN intercompany_trades t ON t.id = link.trade_id
    JOIN purchase_orders po ON po.id = link.source_po_id
    WHERE t.state = 'active' AND po.voucher_id = OLD.id
  ) OR EXISTS (
    SELECT 1 FROM intercompany_audit_events audit
    JOIN intercompany_trades t ON t.id::text = split_part(audit.event_key, ':', 3)
    WHERE t.state = 'active' AND audit.event_type = 'container-import-confirmed'
      AND ((audit.payload->>'sourceSaleVoucherId')::integer = OLD.id OR
           (audit.payload->>'sourceCostVoucherId')::integer = OLD.id)
  ) THEN
    RAISE EXCEPTION 'Linked intercompany vouchers require a coordinated reversal or update';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $blocked$;

DROP TRIGGER IF EXISTS intercompany_legacy_voucher_guard ON vouchers;
CREATE TRIGGER intercompany_legacy_voucher_guard
BEFORE UPDATE OR DELETE ON vouchers
FOR EACH ROW EXECUTE FUNCTION intercompany_block_legacy_voucher_change();


-- Voucher-entry edits can bypass a voucher-header trigger. Protect BOTH levels.
-- Pre-trade entries can be written because no active linkage exists yet.
CREATE OR REPLACE FUNCTION intercompany_block_legacy_voucher_entry_change()
RETURNS TRIGGER LANGUAGE plpgsql AS $blocked$
DECLARE posted_voucher_id INTEGER;
BEGIN
  IF TG_OP = 'INSERT' THEN
    posted_voucher_id := NEW.voucher_id;
  ELSE
    posted_voucher_id := OLD.voucher_id;
  END IF;
  IF EXISTS (
    SELECT 1 FROM intercompany_trades t
    LEFT JOIN purchase_orders src ON src.id = t.original_supplier_po_id
    LEFT JOIN purchase_orders dst ON dst.id = t.destination_po_id
    WHERE t.state = 'active'
      AND (src.voucher_id = posted_voucher_id OR dst.voucher_id = posted_voucher_id)
  ) OR EXISTS (
    SELECT 1 FROM intercompany_trade_source_pos link
    JOIN intercompany_trades t ON t.id = link.trade_id
    JOIN purchase_orders po ON po.id = link.source_po_id
    WHERE t.state = 'active' AND po.voucher_id = posted_voucher_id
  ) OR EXISTS (
    SELECT 1 FROM intercompany_audit_events audit
    JOIN intercompany_trades t ON t.id::text = split_part(audit.event_key, ':', 3)
    WHERE t.state = 'active'
      AND audit.event_type = 'container-import-confirmed'
      AND (
        (audit.payload->>'sourceSaleVoucherId')::integer = posted_voucher_id OR
        (audit.payload->>'sourceCostVoucherId')::integer = posted_voucher_id
      )
  ) THEN
    RAISE EXCEPTION 'Linked intercompany voucher entries require coordinated changes';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.voucher_id <> OLD.voucher_id THEN
    -- Relinking an unrelated entry INTO a protected voucher must not bypass guard.
    IF EXISTS (
      SELECT 1 FROM intercompany_trades t
      LEFT JOIN purchase_orders src ON src.id = t.original_supplier_po_id
      LEFT JOIN purchase_orders dst ON dst.id = t.destination_po_id
      WHERE t.state = 'active'
        AND (src.voucher_id = NEW.voucher_id OR dst.voucher_id = NEW.voucher_id)
    ) OR EXISTS (
      SELECT 1 FROM intercompany_trade_source_pos link
      JOIN intercompany_trades t ON t.id = link.trade_id
      JOIN purchase_orders po ON po.id = link.source_po_id
      WHERE t.state = 'active' AND po.voucher_id = NEW.voucher_id
    ) OR EXISTS (
      SELECT 1 FROM intercompany_audit_events audit
      JOIN intercompany_trades t ON t.id::text = split_part(audit.event_key, ':', 3)
      WHERE t.state = 'active' AND audit.event_type = 'container-import-confirmed'
        AND (
          (audit.payload->>'sourceSaleVoucherId')::integer = NEW.voucher_id OR
          (audit.payload->>'sourceCostVoucherId')::integer = NEW.voucher_id
        )
    ) THEN
      RAISE EXCEPTION 'Cannot move voucher lines into a protected intercompany voucher';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $blocked$;
DROP TRIGGER IF EXISTS intercompany_legacy_voucher_entry_guard ON voucher_entries;
CREATE TRIGGER intercompany_legacy_voucher_entry_guard
BEFORE INSERT OR UPDATE OR DELETE ON voucher_entries
FOR EACH ROW EXECUTE FUNCTION intercompany_block_legacy_voucher_entry_change();


-- Container tracking may continue, but no legacy form may change canonical
-- ownership, original supplier, number or offload date after a trade is active.
CREATE OR REPLACE FUNCTION intercompany_block_container_identity_change()
RETURNS TRIGGER LANGUAGE plpgsql AS $blocked$
BEGIN
  IF EXISTS (
    SELECT 1 FROM intercompany_trades t
    WHERE t.physical_container_id = OLD.id AND t.state = 'active'
  ) THEN
    RAISE EXCEPTION 'Active intercompany container ownership and offload identity are protected';
  END IF;
  RETURN NEW;
END $blocked$;
DROP TRIGGER IF EXISTS intercompany_container_identity_guard ON containers;
CREATE TRIGGER intercompany_container_identity_guard
BEFORE UPDATE OF company_id, container_number, supplier_id, offload_date
ON containers
FOR EACH ROW
WHEN (
  NEW.company_id IS DISTINCT FROM OLD.company_id OR
  NEW.container_number IS DISTINCT FROM OLD.container_number OR
  NEW.supplier_id IS DISTINCT FROM OLD.supplier_id OR
  NEW.offload_date IS DISTINCT FROM OLD.offload_date
)
EXECUTE FUNCTION intercompany_block_container_identity_change();


-- ══ 20261105_003_intercompany_phase3_sync.sql ══════════════════════════════════════════════
-- Phase 3: linked PO editing, immutable edit revisions, and shared-charge invoice allocations.
-- Adds no new cash entries, does not edit historical vouchers, and preserves the original invoice face amount.
CREATE TABLE IF NOT EXISTS intercompany_trade_line_links (
  id BIGSERIAL PRIMARY KEY,
  trade_id INTEGER NOT NULL REFERENCES intercompany_trades(id) ON DELETE RESTRICT,
  source_line_id INTEGER NOT NULL UNIQUE REFERENCES po_line_items(id) ON DELETE RESTRICT,
  destination_line_id INTEGER NOT NULL UNIQUE REFERENCES po_line_items(id) ON DELETE RESTRICT,
  original_excel_row INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ic_trade_line_excel_row_unique UNIQUE(trade_id, original_excel_row),
  CONSTRAINT ic_trade_line_not_same CHECK(source_line_id <> destination_line_id)
);
CREATE INDEX IF NOT EXISTS ic_trade_line_trade_idx ON intercompany_trade_line_links(trade_id);

CREATE TABLE IF NOT EXISTS intercompany_trade_revisions (
  id BIGSERIAL PRIMARY KEY,
  trade_id INTEGER NOT NULL REFERENCES intercompany_trades(id) ON DELETE RESTRICT,
  revision_number INTEGER NOT NULL,
  kind VARCHAR(40) NOT NULL,
  request_key VARCHAR(160) NOT NULL UNIQUE,
  actor_user_id VARCHAR NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  initiating_company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  state VARCHAR(20) NOT NULL DEFAULT 'posting',
  amount_before NUMERIC(20,2) NOT NULL,
  amount_after NUMERIC(20,2) NOT NULL,
  posting_date DATE NOT NULL,
  reason TEXT NOT NULL,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  posted_voucher_ids INTEGER[] NOT NULL DEFAULT '{}'::integer[],
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  CONSTRAINT ic_trade_revision_version_positive CHECK(revision_number > 1),
  CONSTRAINT ic_trade_revision_kind CHECK(kind IN ('line_edit','shared_invoice_confirm','shared_invoice_reallocate')),
  CONSTRAINT ic_trade_revision_state CHECK(state IN ('posting','completed')),
  CONSTRAINT ic_trade_revision_amounts CHECK(amount_before > 0 AND amount_after > 0),
  CONSTRAINT ic_trade_revision_completion CHECK(state <> 'completed' OR completed_at IS NOT NULL),
  CONSTRAINT ic_trade_revision_number_unique UNIQUE(trade_id, revision_number)
);
CREATE INDEX IF NOT EXISTS ic_trade_revision_trade_idx ON intercompany_trade_revisions(trade_id, created_at);

CREATE TABLE IF NOT EXISTS intercompany_shared_charge_invoices (
  id BIGSERIAL PRIMARY KEY,
  source_company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  external_invoice_key VARCHAR(120) NOT NULL,
  charge_type VARCHAR(32) NOT NULL,
  face_amount NUMERIC(20,2) NOT NULL,
  currency VARCHAR(3) NOT NULL DEFAULT 'USD',
  evidence_reference TEXT NOT NULL,
  state VARCHAR(16) NOT NULL DEFAULT 'draft',
  version INTEGER NOT NULL DEFAULT 1,
  created_by VARCHAR NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at TIMESTAMPTZ,
  CONSTRAINT ic_invoice_unique_source_key UNIQUE(source_company_id, external_invoice_key),
  CONSTRAINT ic_invoice_amount_positive CHECK(face_amount > 0),
  CONSTRAINT ic_invoice_only_usd CHECK(currency = 'USD'),
  CONSTRAINT ic_invoice_type CHECK(charge_type IN ('freight','surcharge','fumigation','documentCharges','otherCharges')),
  CONSTRAINT ic_invoice_state CHECK(state IN ('draft','confirmed')),
  CONSTRAINT ic_invoice_version CHECK(version > 0),
  CONSTRAINT ic_invoice_evidence CHECK(length(btrim(evidence_reference)) >= 3),
  CONSTRAINT ic_invoice_confirm_date CHECK(state <> 'confirmed' OR confirmed_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS ic_shared_invoice_source_idx ON intercompany_shared_charge_invoices(source_company_id, created_at);

CREATE TABLE IF NOT EXISTS intercompany_shared_charge_allocations (
  id BIGSERIAL PRIMARY KEY,
  invoice_id BIGINT NOT NULL REFERENCES intercompany_shared_charge_invoices(id) ON DELETE RESTRICT,
  trade_id INTEGER NOT NULL REFERENCES intercompany_trades(id) ON DELETE RESTRICT,
  amount NUMERIC(20,2) NOT NULL,
  container_charge_id INTEGER REFERENCES container_charges(id) ON DELETE RESTRICT,
  CONSTRAINT ic_charge_trade_unique UNIQUE(invoice_id, trade_id),
  CONSTRAINT ic_charge_trade_nonnegative CHECK(amount >= 0),
  CONSTRAINT ic_charge_container_row_unique UNIQUE(container_charge_id)
);
CREATE INDEX IF NOT EXISTS ic_shared_charge_trade_idx ON intercompany_shared_charge_allocations(trade_id);

CREATE TABLE IF NOT EXISTS intercompany_shared_charge_po_allocations (
  id BIGSERIAL PRIMARY KEY,
  invoice_id BIGINT NOT NULL REFERENCES intercompany_shared_charge_invoices(id) ON DELETE RESTRICT,
  trade_id INTEGER NOT NULL REFERENCES intercompany_trades(id) ON DELETE RESTRICT,
  source_po_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE RESTRICT,
  amount NUMERIC(20,2) NOT NULL,
  CONSTRAINT ic_charge_po_unique UNIQUE(invoice_id, source_po_id),
  CONSTRAINT ic_charge_po_nonnegative CHECK(amount >= 0)
);
CREATE INDEX IF NOT EXISTS ic_shared_charge_po_trade_idx ON intercompany_shared_charge_po_allocations(trade_id);

ALTER TABLE intercompany_permission_grants
  DROP CONSTRAINT IF EXISTS intercompany_grant_scope,
  DROP CONSTRAINT IF EXISTS intercompany_grant_scope_target;
ALTER TABLE intercompany_permission_grants
  ADD CONSTRAINT intercompany_grant_scope CHECK(scope IN ('invoice','relationship')),
  ADD CONSTRAINT intercompany_grant_scope_target CHECK(
    (scope='invoice' AND invoice_key IS NOT NULL AND length(btrim(invoice_key))>0)
    OR (scope='relationship' AND invoice_key IS NULL)
  );

-- A live revision is a transaction-local capability, scoped to precisely one trade.
-- Existing direct editing routes have no such revision and remain blocked.
CREATE OR REPLACE FUNCTION ic_edit_scope_matches(target_trade_id INTEGER)
RETURNS BOOLEAN LANGUAGE SQL STABLE AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM intercompany_trade_revisions r
    JOIN intercompany_trades t ON t.id = r.trade_id
    WHERE r.id = NULLIF(current_setting('erp.ic_edit_revision',true),'')::bigint
      AND r.trade_id = target_trade_id AND r.state = 'posting'
      AND r.revision_number = t.version + 1
  );
$fn$;

CREATE OR REPLACE FUNCTION intercompany_block_legacy_po_change()
RETURNS TRIGGER LANGUAGE plpgsql AS $blocked$
DECLARE old_po_id INTEGER; protected_trade_id INTEGER;
BEGIN
  IF TG_TABLE_NAME = 'po_line_items' THEN
    old_po_id := CASE WHEN TG_OP='INSERT' THEN NEW.po_id ELSE OLD.po_id END;
  ELSE
    old_po_id := CASE WHEN TG_OP='INSERT' THEN NEW.id ELSE OLD.id END;
  END IF;
  SELECT t.id INTO protected_trade_id FROM intercompany_trades t
   WHERE t.state='active' AND (t.destination_po_id=old_po_id OR t.original_supplier_po_id=old_po_id)
   UNION
   SELECT t.id FROM intercompany_trade_source_pos l
   JOIN intercompany_trades t ON t.id=l.trade_id
   WHERE t.state='active' AND l.source_po_id=old_po_id LIMIT 1;
  IF protected_trade_id IS NOT NULL THEN
    IF TG_OP <> 'UPDATE' OR NOT ic_edit_scope_matches(protected_trade_id) THEN
      RAISE EXCEPTION 'Linked intercompany purchase orders require the Phase 3 synchronized editing workflow';
    END IF;
    IF TG_TABLE_NAME = 'po_line_items' THEN
      IF NEW.po_id IS DISTINCT FROM OLD.po_id OR
        (to_jsonb(NEW) - ARRAY['quantity','rate','line_total','item_name']::text[])
        IS DISTINCT FROM
        (to_jsonb(OLD) - ARRAY['quantity','rate','line_total','item_name']::text[])
      THEN
        RAISE EXCEPTION 'Only synchronized linked PO line pricing and descriptions can change';
      END IF;
    ELSE
      IF (to_jsonb(NEW) - ARRAY['items_total','freight','surcharge','fumigation','document_charges',
                                'discount','other_charges','charges_edited']::text[])
         IS DISTINCT FROM
         (to_jsonb(OLD) - ARRAY['items_total','freight','surcharge','fumigation','document_charges',
                                'discount','other_charges','charges_edited']::text[]) THEN
         RAISE EXCEPTION 'Only synchronized PO cost fields can change';
      END IF;
    END IF;
  END IF;
  -- Guard the new po_id too; moving unrelated lines INTO a linked PO is never legal.
  IF TG_TABLE_NAME='po_line_items' THEN
    IF TG_OP='UPDATE' THEN
      IF NEW.po_id IS DISTINCT FROM OLD.po_id THEN
        IF EXISTS (SELECT 1 FROM intercompany_trades t WHERE t.state='active'
           AND (t.destination_po_id=NEW.po_id OR t.original_supplier_po_id=NEW.po_id))
          OR EXISTS (SELECT 1 FROM intercompany_trade_source_pos l JOIN intercompany_trades t ON t.id=l.trade_id
                     WHERE t.state='active' AND l.source_po_id=NEW.po_id) THEN
          RAISE EXCEPTION 'Cannot move PO line into a linked intercompany purchase order';
        END IF;
      END IF;
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $blocked$;

CREATE OR REPLACE FUNCTION intercompany_block_legacy_charge_change()
RETURNS TRIGGER LANGUAGE plpgsql AS $blocked$
DECLARE physical_id INTEGER; protected_trade_id INTEGER;
BEGIN
  physical_id := CASE WHEN TG_OP='INSERT' THEN NEW.container_id ELSE OLD.container_id END;
  SELECT id INTO protected_trade_id FROM intercompany_trades
   WHERE physical_container_id = physical_id AND state='active' LIMIT 1;
  IF protected_trade_id IS NOT NULL THEN
    IF TG_OP='DELETE' OR NOT ic_edit_scope_matches(protected_trade_id) THEN
      RAISE EXCEPTION 'Linked intercompany charges require the Phase 3 synchronized allocation workflow';
    END IF;
    IF TG_OP='UPDATE' AND (NEW.container_id IS DISTINCT FROM OLD.container_id
          OR NEW.charge_type IS DISTINCT FROM OLD.charge_type
          OR NEW.ledger_account_id IS DISTINCT FROM OLD.ledger_account_id) THEN
      RAISE EXCEPTION 'Linked confirmed charge identity cannot change';
    END IF;
  END IF;
  IF TG_OP='UPDATE' AND NEW.container_id IS DISTINCT FROM OLD.container_id AND EXISTS (
    SELECT 1 FROM intercompany_trades WHERE physical_container_id=NEW.container_id AND state='active'
  ) THEN
    RAISE EXCEPTION 'Cannot move charge into a linked intercompany container';
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $blocked$;

CREATE OR REPLACE FUNCTION ic_guard_container_cost()
RETURNS TRIGGER LANGUAGE plpgsql AS $blocked$
DECLARE protected_trade_id INTEGER;
BEGIN
  SELECT id INTO protected_trade_id FROM intercompany_trades
   WHERE physical_container_id=OLD.id AND state='active' LIMIT 1;
  IF protected_trade_id IS NOT NULL AND NOT ic_edit_scope_matches(protected_trade_id) THEN
    RAISE EXCEPTION 'Active intercompany container cost requires a synchronized revision';
  END IF;
  RETURN NEW;
END $blocked$;
DROP TRIGGER IF EXISTS ic_container_financial_guard ON containers;
CREATE TRIGGER ic_container_financial_guard
BEFORE UPDATE OF items_total, charges_total, grand_total ON containers
FOR EACH ROW WHEN (
  NEW.items_total IS DISTINCT FROM OLD.items_total
  OR NEW.charges_total IS DISTINCT FROM OLD.charges_total
  OR NEW.grand_total IS DISTINCT FROM OLD.grand_total
)
EXECUTE FUNCTION ic_guard_container_cost();

CREATE OR REPLACE FUNCTION ic_guard_import_cost()
RETURNS TRIGGER LANGUAGE plpgsql AS $blocked$
BEGIN
  IF NEW.trade_id IS DISTINCT FROM OLD.trade_id
     OR NEW.physical_container_id IS DISTINCT FROM OLD.physical_container_id
     OR NEW.destination_company_id IS DISTINCT FROM OLD.destination_company_id THEN
     RAISE EXCEPTION 'Linked import ownership and source evidence cannot change';
  END IF;
  IF (NEW.confirmed_landed_cost IS DISTINCT FROM OLD.confirmed_landed_cost
       OR NEW.charges_confirmed IS DISTINCT FROM OLD.charges_confirmed
       OR NEW.charge_evidence_reference IS DISTINCT FROM OLD.charge_evidence_reference)
     AND OLD.trade_id IS NOT NULL
     AND NOT ic_edit_scope_matches(OLD.trade_id) THEN
    RAISE EXCEPTION 'Linked import cost requires a synchronized revision';
  END IF;
  RETURN NEW;
END $blocked$;
DROP TRIGGER IF EXISTS ic_import_cost_guard ON intercompany_import_batch_containers;
CREATE TRIGGER ic_import_cost_guard BEFORE UPDATE ON intercompany_import_batch_containers
FOR EACH ROW EXECUTE FUNCTION ic_guard_import_cost();

CREATE OR REPLACE FUNCTION ic_guard_trade_line_link()
RETURNS TRIGGER LANGUAGE plpgsql AS $block$
DECLARE trade_record RECORD;
BEGIN
  IF TG_OP IN ('UPDATE','DELETE') THEN
    RAISE EXCEPTION 'Linked source/destination line identities are immutable';
  END IF;
  SELECT source_company_id, destination_company_id, original_supplier_po_id, destination_po_id
    INTO trade_record FROM intercompany_trades WHERE id=NEW.trade_id;
  IF NOT EXISTS(
    SELECT 1 FROM po_line_items src
      JOIN purchase_orders spo ON spo.id=src.po_id
      JOIN po_line_items dst ON dst.id=NEW.destination_line_id
      JOIN purchase_orders dpo ON dpo.id=dst.po_id
     WHERE src.id=NEW.source_line_id AND spo.company_id=trade_record.source_company_id
       AND dpo.company_id=trade_record.destination_company_id
       AND dpo.id=trade_record.destination_po_id
       AND spo.container_id=dpo.container_id
       AND (spo.id=trade_record.original_supplier_po_id OR EXISTS(
           SELECT 1 FROM intercompany_trade_source_pos t
           WHERE t.trade_id=NEW.trade_id AND t.source_po_id=spo.id))
  ) THEN
     RAISE EXCEPTION 'Line links must connect the source and destination POs of one trade';
  END IF;
  RETURN NEW;
END $block$;
CREATE TRIGGER ic_trade_line_link_guard BEFORE INSERT OR UPDATE OR DELETE
  ON intercompany_trade_line_links FOR EACH ROW EXECUTE FUNCTION ic_guard_trade_line_link();

CREATE OR REPLACE FUNCTION ic_guard_charge_invoice()
RETURNS TRIGGER LANGUAGE plpgsql AS $blocked$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Confirmed shared-charge invoices cannot be deleted'; END IF;
  IF TG_OP='UPDATE' THEN
    IF NEW.face_amount IS DISTINCT FROM OLD.face_amount OR NEW.source_company_id IS DISTINCT FROM OLD.source_company_id
       OR NEW.external_invoice_key IS DISTINCT FROM OLD.external_invoice_key
       OR NEW.currency IS DISTINCT FROM OLD.currency OR NEW.charge_type IS DISTINCT FROM OLD.charge_type
       OR NEW.evidence_reference IS DISTINCT FROM OLD.evidence_reference
       OR NEW.created_by IS DISTINCT FROM OLD.created_by
    THEN RAISE EXCEPTION 'Original external invoice face and evidence cannot change'; END IF;
    IF OLD.state='confirmed' AND (NEW.state <> 'confirmed' OR NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at) THEN
       RAISE EXCEPTION 'Confirmed charge invoice cannot be reopened or unconfirmed'; END IF;
    IF NEW.version <> OLD.version + 1 AND NEW.version <> OLD.version THEN
       RAISE EXCEPTION 'Invalid confirmed invoice revision'; END IF;
  END IF;
  RETURN NEW;
END $blocked$;
CREATE TRIGGER ic_shared_charge_invoice_immutability BEFORE UPDATE OR DELETE
ON intercompany_shared_charge_invoices FOR EACH ROW EXECUTE FUNCTION ic_guard_charge_invoice();

-- Deferred verification permits one atomic multi-container allocation update, but no
-- committed invoice may have allocations summing to anything other than its face amount.
CREATE OR REPLACE FUNCTION ic_check_shared_charge_totals()
RETURNS TRIGGER LANGUAGE plpgsql AS $check$
DECLARE invoice_id_to_check BIGINT; face NUMERIC(20,2); total NUMERIC(20,2);
BEGIN
  invoice_id_to_check := CASE WHEN TG_OP='DELETE' THEN OLD.invoice_id ELSE NEW.invoice_id END;
  SELECT face_amount INTO face FROM intercompany_shared_charge_invoices
  WHERE id=invoice_id_to_check AND state='confirmed';
  IF face IS NULL THEN RETURN NULL; END IF;
  SELECT COALESCE(SUM(amount),0) INTO total FROM intercompany_shared_charge_allocations
   WHERE invoice_id=invoice_id_to_check;
  IF total <> face THEN
    RAISE EXCEPTION 'Shared invoice allocation % does not equal original face amount %', total, face;
  END IF;
  RETURN NULL;
END $check$;
CREATE CONSTRAINT TRIGGER ic_shared_charge_totals_after_allocation
AFTER INSERT OR UPDATE OR DELETE ON intercompany_shared_charge_allocations
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ic_check_shared_charge_totals();
CREATE OR REPLACE FUNCTION ic_check_shared_invoice_face()
RETURNS TRIGGER LANGUAGE plpgsql AS $check$
DECLARE total NUMERIC(20,2);
BEGIN
  IF NEW.state <> 'confirmed' THEN RETURN NULL; END IF;
  SELECT COALESCE(SUM(amount),0) INTO total FROM intercompany_shared_charge_allocations
    WHERE invoice_id=NEW.id;
  IF total <> NEW.face_amount THEN
    RAISE EXCEPTION 'Shared invoice face amount and confirmed allocations disagree';
  END IF;
  RETURN NULL;
END $check$;
CREATE CONSTRAINT TRIGGER ic_shared_invoice_face_after_confirm
AFTER INSERT OR UPDATE ON intercompany_shared_charge_invoices
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ic_check_shared_invoice_face();

CREATE OR REPLACE FUNCTION ic_check_shared_po_allocations()
RETURNS TRIGGER LANGUAGE plpgsql AS $check$
DECLARE invoice_to_check BIGINT; trade_to_check INTEGER; expected NUMERIC(20,2); total NUMERIC(20,2);
BEGIN
  invoice_to_check := CASE WHEN TG_OP='DELETE' THEN OLD.invoice_id ELSE NEW.invoice_id END;
  trade_to_check := CASE WHEN TG_OP='DELETE' THEN OLD.trade_id ELSE NEW.trade_id END;
  SELECT amount INTO expected FROM intercompany_shared_charge_allocations
   WHERE invoice_id=invoice_to_check AND trade_id=trade_to_check;
  IF expected IS NULL THEN RETURN NULL; END IF;
  SELECT COALESCE(SUM(amount),0) INTO total FROM intercompany_shared_charge_po_allocations
   WHERE invoice_id=invoice_to_check AND trade_id=trade_to_check;
  IF expected <> total THEN
    RAISE EXCEPTION 'Shared charge source PO allocations do not equal container allocation';
  END IF;
  RETURN NULL;
END $check$;
CREATE CONSTRAINT TRIGGER ic_shared_charge_po_sum_guard AFTER INSERT OR UPDATE OR DELETE
ON intercompany_shared_charge_po_allocations DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION ic_check_shared_po_allocations();

-- Recheck source-PO totals when the parent container allocation changes too.
CREATE CONSTRAINT TRIGGER ic_shared_charge_parent_po_sum_guard AFTER INSERT OR UPDATE OR DELETE
ON intercompany_shared_charge_allocations DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION ic_check_shared_po_allocations();

-- All trade/PO allocation references must be ownership-consistent.
CREATE OR REPLACE FUNCTION ic_guard_shared_charge_allocation()
RETURNS TRIGGER LANGUAGE plpgsql AS $check$
DECLARE inv RECORD; trade_record RECORD;
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Shared charge allocations must be revised, not deleted';
  END IF;
  SELECT source_company_id, state INTO inv FROM intercompany_shared_charge_invoices WHERE id=NEW.invoice_id;
  SELECT source_company_id, state INTO trade_record FROM intercompany_trades WHERE id=NEW.trade_id;
  IF inv.source_company_id IS DISTINCT FROM trade_record.source_company_id OR trade_record.state <> 'active' THEN
    RAISE EXCEPTION 'Shared invoice allocation must target an active container of its source company';
  END IF;
  IF TG_OP='UPDATE' THEN
    IF OLD.invoice_id <> NEW.invoice_id OR OLD.trade_id <> NEW.trade_id THEN
      RAISE EXCEPTION 'Shared charge allocation ownership cannot change';
    END IF;
  END IF;
  IF inv.state='confirmed' AND NOT ic_edit_scope_matches(NEW.trade_id) THEN
    RAISE EXCEPTION 'Confirmed shared charge allocation requires an authorized transaction revision';
  END IF;
  RETURN NEW;
END $check$;
CREATE TRIGGER ic_shared_charge_allocation_guard BEFORE INSERT OR UPDATE OR DELETE
  ON intercompany_shared_charge_allocations FOR EACH ROW EXECUTE FUNCTION ic_guard_shared_charge_allocation();

CREATE OR REPLACE FUNCTION ic_guard_shared_charge_po_allocation()
RETURNS TRIGGER LANGUAGE plpgsql AS $check$
DECLARE inv_state VARCHAR; trade_company INTEGER; po_company INTEGER; po_container INTEGER; trade_container INTEGER;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Confirmed source PO allocations cannot be deleted'; END IF;
  SELECT state INTO inv_state FROM intercompany_shared_charge_invoices WHERE id=NEW.invoice_id;
  SELECT source_company_id, physical_container_id INTO trade_company, trade_container
   FROM intercompany_trades WHERE id=NEW.trade_id;
  SELECT company_id, container_id INTO po_company, po_container FROM purchase_orders WHERE id=NEW.source_po_id;
  IF trade_company <> po_company OR trade_container <> po_container
    OR NOT EXISTS (SELECT 1 FROM intercompany_trade_source_pos l
      WHERE l.trade_id=NEW.trade_id AND l.source_po_id=NEW.source_po_id) THEN
    RAISE EXCEPTION 'Source PO allocation does not belong to this trade';
  END IF;
  IF TG_OP='UPDATE' AND (
    NEW.invoice_id <> OLD.invoice_id OR NEW.trade_id <> OLD.trade_id OR NEW.source_po_id <> OLD.source_po_id) THEN
    RAISE EXCEPTION 'Source PO allocation identities cannot change';
  END IF;
  IF inv_state='confirmed' AND NOT ic_edit_scope_matches(NEW.trade_id) THEN
    RAISE EXCEPTION 'Confirmed source PO allocation requires an authorized transaction revision';
  END IF;
  RETURN NEW;
END $check$;
CREATE TRIGGER ic_shared_charge_po_allocation_guard BEFORE INSERT OR UPDATE OR DELETE
ON intercompany_shared_charge_po_allocations FOR EACH ROW EXECUTE FUNCTION ic_guard_shared_charge_po_allocation();


-- ══ 20261105_004_intercompany_phase4_payments.sql ══════════════════════════════════════════════
-- Phase 4: confirmed mirrored cash/bank settlement, explicit PO allocation and
-- pair-owned unallocated credit. No historical money is moved between company pairs.
CREATE TABLE IF NOT EXISTS intercompany_container_payments (
  id BIGSERIAL PRIMARY KEY,
  relationship_id INTEGER NOT NULL REFERENCES intercompany_relationship_policies(id) ON DELETE RESTRICT,
  source_company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  destination_company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  request_key VARCHAR(160) NOT NULL UNIQUE,
  request_fingerprint VARCHAR(64) NOT NULL,
  transfer_reference VARCHAR(180) NOT NULL,
  confirmation_evidence TEXT NOT NULL,
  payment_date DATE NOT NULL,
  transaction_currency VARCHAR(3) NOT NULL DEFAULT 'USD',
  transaction_amount NUMERIC(20, 6) NOT NULL,
  historical_rate NUMERIC(20, 10) NOT NULL DEFAULT 1,
  base_amount NUMERIC(20, 2) NOT NULL,
  source_cash_type VARCHAR(8) NOT NULL,
  source_cash_id INTEGER NOT NULL,
  destination_cash_type VARCHAR(8) NOT NULL,
  destination_cash_id INTEGER NOT NULL,
  source_receivable_account_id INTEGER NOT NULL REFERENCES ledger_accounts(id) ON DELETE RESTRICT,
  destination_supplier_id INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  source_receipt_voucher_id INTEGER NOT NULL UNIQUE REFERENCES vouchers(id) ON DELETE RESTRICT,
  destination_payment_voucher_id INTEGER NOT NULL UNIQUE REFERENCES vouchers(id) ON DELETE RESTRICT,
  status VARCHAR(12) NOT NULL DEFAULT 'confirmed',
  created_by VARCHAR NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reversed_by VARCHAR REFERENCES users(id) ON DELETE RESTRICT,
  reversed_at TIMESTAMPTZ,
  reversal_date DATE,
  reversal_reason TEXT,
  reversal_key VARCHAR(160) UNIQUE,
  reversal_fingerprint VARCHAR(64),
  source_reversal_voucher_id INTEGER UNIQUE REFERENCES vouchers(id) ON DELETE RESTRICT,
  destination_reversal_voucher_id INTEGER UNIQUE REFERENCES vouchers(id) ON DELETE RESTRICT,
  CONSTRAINT ic_payments_companies_differ CHECK(source_company_id<>destination_company_id),
  CONSTRAINT ic_payments_currency_check CHECK(transaction_currency IN ('USD','CFA','ZMW')),
  CONSTRAINT ic_payments_cash_type_check CHECK(source_cash_type IN ('bank','cash') AND destination_cash_type IN ('bank','cash')),
  CONSTRAINT ic_payments_amounts_positive CHECK(transaction_amount>0 AND historical_rate>0 AND base_amount>0),
  -- Original-currency evidence must always reconcile to the exact USD-base
  -- amount used for BOTH real cash vouchers. An arbitrary base amount must
  -- not be attached to genuine-looking transfer references.
  CONSTRAINT ic_payments_fx_consistency CHECK(
    transaction_amount=round(transaction_amount,2)
    AND (transaction_currency<>'USD' OR historical_rate=1)
    AND base_amount=round(transaction_amount/historical_rate,2)
  ),
  CONSTRAINT ic_payments_evidence_check CHECK(length(btrim(transfer_reference))>=5 AND length(btrim(confirmation_evidence))>=8),
  CONSTRAINT ic_payments_distinct_vouchers CHECK(source_receipt_voucher_id<>destination_payment_voucher_id),
  CONSTRAINT ic_payments_status_check CHECK(status IN ('confirmed','reversed')),
  CONSTRAINT ic_payments_fingerprint CHECK(request_fingerprint ~ '^[0-9a-f]{64}$'
    AND (reversal_fingerprint IS NULL OR reversal_fingerprint ~ '^[0-9a-f]{64}$')),
  CONSTRAINT ic_payments_reversal_consistency CHECK(
    (status='confirmed' AND reversed_at IS NULL AND reversed_by IS NULL
      AND reversal_date IS NULL AND reversal_reason IS NULL AND reversal_key IS NULL AND reversal_fingerprint IS NULL
      AND source_reversal_voucher_id IS NULL AND destination_reversal_voucher_id IS NULL)
    OR
    (status='reversed' AND reversed_at IS NOT NULL AND reversed_by IS NOT NULL
      AND reversal_date IS NOT NULL AND length(btrim(reversal_reason))>=3 AND reversal_key IS NOT NULL AND reversal_fingerprint IS NOT NULL
      AND source_reversal_voucher_id IS NOT NULL AND destination_reversal_voucher_id IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS ic_payments_pair_date_idx ON intercompany_container_payments(relationship_id,payment_date,id);
CREATE UNIQUE INDEX IF NOT EXISTS ic_payments_pair_transfer_ref
  ON intercompany_container_payments(relationship_id,upper(btrim(transfer_reference)));

-- Allocation ledger is append-only: signed credit usage and releases never
-- mutate the cash/bank ledger. Negative lines return credit to its original pair.
CREATE TABLE IF NOT EXISTS intercompany_payment_allocations (
  id BIGSERIAL PRIMARY KEY,
  payment_id BIGINT NOT NULL REFERENCES intercompany_container_payments(id) ON DELETE RESTRICT,
  trade_id INTEGER NOT NULL REFERENCES intercompany_trades(id) ON DELETE RESTRICT,
  amount NUMERIC(20,2) NOT NULL,
  allocation_kind VARCHAR(32) NOT NULL,
  request_key VARCHAR(180) NOT NULL UNIQUE,
  created_by VARCHAR REFERENCES users(id) ON DELETE RESTRICT,
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ic_payment_allocation_nonzero CHECK(amount<>0),
  CONSTRAINT ic_payment_allocation_kind CHECK(allocation_kind IN
    ('manual','new_import_credit','cancel_credit_reallocate','edit_release','reversal_release')),
  CONSTRAINT ic_payment_allocation_signed_kind CHECK(
    (amount>0 AND allocation_kind IN ('manual','new_import_credit','cancel_credit_reallocate'))
    OR (amount<0 AND allocation_kind IN ('edit_release','reversal_release'))
  )
);
CREATE INDEX IF NOT EXISTS ic_payment_allocation_payment_idx ON intercompany_payment_allocations(payment_id,id);
CREATE INDEX IF NOT EXISTS ic_payment_allocation_trade_idx ON intercompany_payment_allocations(trade_id,id);

-- Permits a single payment to be spread across several POs but no payment
-- may be overallocated, no one PO may be overpaid, and a reversed payment
-- must have no net allocations at all. Checked at transaction commit so
-- multi-line allocations/reversals remain atomic.
CREATE OR REPLACE FUNCTION ic_verify_payment_allocation_totals()
RETURNS TRIGGER LANGUAGE plpgsql AS $guard$
DECLARE pid BIGINT; tid INTEGER; payment_row RECORD; used_payment NUMERIC(20,2);
        used_trade NUMERIC(20,2); used_pair NUMERIC(20,2); trade_cost NUMERIC(20,2);
BEGIN
  IF TG_TABLE_NAME='intercompany_container_payments' THEN
    pid := NEW.id;
  ELSE
    pid := NEW.payment_id;
  END IF;
  SELECT base_amount,status INTO payment_row FROM intercompany_container_payments WHERE id=pid;
  IF FOUND THEN
    SELECT COALESCE(SUM(amount),0) INTO used_payment FROM intercompany_payment_allocations
      WHERE payment_id=pid;
    IF used_payment<0 OR used_payment>payment_row.base_amount
      OR (payment_row.status='reversed' AND used_payment<>0) THEN
      RAISE EXCEPTION 'Intercompany payment allocation exceeds confirmed money or survived reversal';
    END IF;
  END IF;
  IF TG_TABLE_NAME='intercompany_payment_allocations' THEN
    tid:=NEW.trade_id;
    SELECT COALESCE(SUM(amount),0) INTO used_pair FROM intercompany_payment_allocations
      WHERE trade_id=tid AND payment_id=pid;
    IF used_pair<0 THEN
      RAISE EXCEPTION 'A payment cannot release more credit from one PO than it previously applied';
    END IF;
    SELECT COALESCE(SUM(amount),0) INTO used_trade FROM intercompany_payment_allocations WHERE trade_id=tid;
    SELECT confirmed_landed_cost INTO trade_cost FROM intercompany_import_batch_containers WHERE trade_id=tid;
    IF trade_cost IS NULL OR used_trade<0 OR used_trade>trade_cost THEN
      RAISE EXCEPTION 'Intercompany PO payment allocations exceed confirmed landed cost';
    END IF;
  END IF;
  RETURN NULL;
END $guard$;
CREATE CONSTRAINT TRIGGER ic_payment_allocation_totals
  AFTER INSERT ON intercompany_payment_allocations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ic_verify_payment_allocation_totals();
CREATE CONSTRAINT TRIGGER ic_payment_pair_totals
  AFTER INSERT OR UPDATE ON intercompany_container_payments
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ic_verify_payment_allocation_totals();

-- A synchronized PO edit may change its confirmed landed cost without directly
-- touching a payment. The deferred guard still requires any excess paid credit
-- to be released atomically in that same edit transaction.
CREATE OR REPLACE FUNCTION ic_check_trade_paid_after_cost()
RETURNS TRIGGER LANGUAGE plpgsql AS $check$
DECLARE total_paid NUMERIC(20,2);
BEGIN
  IF NEW.trade_id IS NULL THEN RETURN NULL; END IF;
  SELECT COALESCE(SUM(amount),0) INTO total_paid FROM intercompany_payment_allocations
  WHERE trade_id=NEW.trade_id;
  IF total_paid<0 OR (NEW.confirmed_landed_cost IS NOT NULL AND total_paid>NEW.confirmed_landed_cost) THEN
    RAISE EXCEPTION 'PO cost decrease must atomically release over-allocated original-pair credit';
  END IF;
  RETURN NULL;
END $check$;
CREATE CONSTRAINT TRIGGER ic_payment_po_cost_guard
AFTER UPDATE ON intercompany_import_batch_containers
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ic_check_trade_paid_after_cost();


CREATE OR REPLACE FUNCTION ic_validate_payment_allocation_row()
RETURNS TRIGGER LANGUAGE plpgsql AS $guard$
DECLARE payment_row RECORD; trade_row RECORD;
BEGIN
  IF TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'Intercompany payment allocations are append-only; post a release entry';
  END IF;
  SELECT * INTO payment_row FROM intercompany_container_payments WHERE id=NEW.payment_id;
  SELECT * INTO trade_row FROM intercompany_trades WHERE id=NEW.trade_id;
  IF NOT FOUND OR trade_row.state <> 'active'
    OR payment_row.status <> 'confirmed'
    OR payment_row.relationship_id <> trade_row.relationship_id
    OR payment_row.source_company_id <> trade_row.source_company_id
    OR payment_row.destination_company_id <> trade_row.destination_company_id THEN
    RAISE EXCEPTION 'Payment credit may be applied only to the same active company pair';
  END IF;
  IF NEW.amount < 0 AND NEW.allocation_kind NOT IN ('edit_release','reversal_release') THEN
    RAISE EXCEPTION 'Only audited payment releases may reduce allocation';
  END IF;
  RETURN NEW;
END $guard$;
CREATE TRIGGER ic_payment_allocation_append_only
BEFORE INSERT OR UPDATE OR DELETE ON intercompany_payment_allocations
FOR EACH ROW EXECUTE FUNCTION ic_validate_payment_allocation_row();

-- Validate the ACTUAL journal legs, not just voucher headings. A misleading
-- pre-existing voucher cannot be linked as proof of a new intercompany payment.
CREATE OR REPLACE FUNCTION ic_payment_voucher_has_legs(
  p_voucher INTEGER,p_cash_type TEXT,p_cash_id INTEGER,
  p_partner_type TEXT,p_partner_id INTEGER,p_usd NUMERIC,p_cash_side TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql STABLE AS $check$
DECLARE is_exact_count BOOLEAN; valid_cash BOOLEAN; valid_partner BOOLEAN;
BEGIN
  SELECT COUNT(*)=2 INTO is_exact_count FROM voucher_entries WHERE voucher_id=p_voucher;
  SELECT EXISTS(
    SELECT 1 FROM vouchers v WHERE v.id=p_voucher AND v.total_amount=p_usd
      AND v.deleted_at IS NULL
  ) INTO valid_cash;
  IF NOT is_exact_count OR NOT valid_cash THEN RETURN FALSE; END IF;
  SELECT EXISTS(
    SELECT 1 FROM voucher_entries e WHERE e.voucher_id=p_voucher
      AND ((p_cash_side='debit' AND COALESCE(e.debit_amount,0)=p_usd
             AND COALESCE(e.credit_amount,0)=0)
        OR (p_cash_side='credit' AND COALESCE(e.credit_amount,0)=p_usd
             AND COALESCE(e.debit_amount,0)=0))
      AND ((p_cash_type='bank' AND e.bank_account_id=p_cash_id AND e.ledger_account_id IS NULL
             AND e.supplier_id IS NULL)
        OR (p_cash_type='cash' AND e.ledger_account_id=p_cash_id AND e.bank_account_id IS NULL
             AND e.supplier_id IS NULL))
  ) INTO valid_cash;
  SELECT EXISTS(
    SELECT 1 FROM voucher_entries e WHERE e.voucher_id=p_voucher
      AND ((p_cash_side='debit' AND COALESCE(e.credit_amount,0)=p_usd
             AND COALESCE(e.debit_amount,0)=0)
        OR (p_cash_side='credit' AND COALESCE(e.debit_amount,0)=p_usd
             AND COALESCE(e.credit_amount,0)=0))
      AND ((p_partner_type='ledger' AND e.ledger_account_id=p_partner_id
             AND e.bank_account_id IS NULL AND e.supplier_id IS NULL)
        OR (p_partner_type='supplier' AND e.supplier_id=p_partner_id
             AND e.bank_account_id IS NULL AND e.ledger_account_id IS NULL))
  ) INTO valid_partner;
  RETURN valid_cash AND valid_partner;
END $check$;

CREATE OR REPLACE FUNCTION ic_validate_payment_pair()
RETURNS TRIGGER LANGUAGE plpgsql AS $guard$
DECLARE pair_record RECORD; source_voucher RECORD; dest_voucher RECORD;
        source_kind TEXT; dest_kind TEXT;
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Confirmed mirrored payment evidence cannot be deleted';
  END IF;
  IF TG_OP='UPDATE' THEN
    IF OLD.status<>'confirmed' OR NEW.status<>'reversed'
      OR current_setting('erp.ic_payment_reversal',true) IS DISTINCT FROM OLD.id::text
      OR (to_jsonb(OLD) - ARRAY[
         'status','reversed_by','reversed_at','reversal_date','reversal_reason',
         'reversal_key','reversal_fingerprint','source_reversal_voucher_id','destination_reversal_voucher_id']::text[])
       IS DISTINCT FROM
         (to_jsonb(NEW) - ARRAY[
         'status','reversed_by','reversed_at','reversal_date','reversal_reason',
         'reversal_key','reversal_fingerprint','source_reversal_voucher_id','destination_reversal_voucher_id']::text[])
    THEN RAISE EXCEPTION 'Intercompany payment records are immutable except a coordinated reversal'; END IF;
    IF NOT EXISTS(
      SELECT 1 FROM vouchers v WHERE v.id=NEW.source_reversal_voucher_id
        AND v.company_id=OLD.source_company_id AND v.voucher_type='Payment' AND v.deleted_at IS NULL
    ) OR NOT EXISTS(
      SELECT 1 FROM vouchers v WHERE v.id=NEW.destination_reversal_voucher_id
        AND v.company_id=OLD.destination_company_id AND v.voucher_type='Receipt' AND v.deleted_at IS NULL
    ) THEN
      RAISE EXCEPTION 'A coordinated payment reversal requires a valid original-company Payment/Receipt pair';
    END IF;
    IF NOT ic_payment_voucher_has_legs(NEW.source_reversal_voucher_id,
      OLD.source_cash_type,OLD.source_cash_id,'ledger',OLD.source_receivable_account_id,
      OLD.base_amount,'credit')
      OR NOT ic_payment_voucher_has_legs(NEW.destination_reversal_voucher_id,
      OLD.destination_cash_type,OLD.destination_cash_id,'supplier',OLD.destination_supplier_id,
      OLD.base_amount,'debit') THEN
      RAISE EXCEPTION 'Reversal voucher lines do not offset the original actual cash and partner accounts';
    END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO pair_record FROM intercompany_relationship_policies WHERE id=NEW.relationship_id;
  IF NOT FOUND OR pair_record.relationship_type<>'container_trade' OR pair_record.trade_enabled<>true
    OR pair_record.source_company_id<>NEW.source_company_id
    OR pair_record.destination_company_id<>NEW.destination_company_id THEN
    RAISE EXCEPTION 'Payment must belong to an enabled original company pair';
  END IF;
  -- Only the mapping reviewed for this source/destination relationship may
  -- underlie a new real payment. The original mapping is stored immutably on
  -- the payment so later account reconfiguration does not rewrite history.
  IF pair_record.source_receivable_account_id IS DISTINCT FROM NEW.source_receivable_account_id
     OR pair_record.destination_supplier_id IS DISTINCT FROM NEW.destination_supplier_id THEN
    RAISE EXCEPTION 'Actual payment must use the verified company-pair receivable and supplier mappings';
  END IF;
  SELECT id,company_id,voucher_type,deleted_at INTO source_voucher
    FROM vouchers WHERE id=NEW.source_receipt_voucher_id;
  SELECT id,company_id,voucher_type,deleted_at INTO dest_voucher
    FROM vouchers WHERE id=NEW.destination_payment_voucher_id;
  IF source_voucher.company_id IS DISTINCT FROM NEW.source_company_id OR source_voucher.voucher_type<>'Receipt'
    OR source_voucher.deleted_at IS NOT NULL OR
     dest_voucher.company_id IS DISTINCT FROM NEW.destination_company_id OR dest_voucher.voucher_type<>'Payment'
    OR dest_voucher.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Paired actual payment voucher companies/types are incorrect';
  END IF;
  IF NOT ic_payment_voucher_has_legs(NEW.source_receipt_voucher_id,
    NEW.source_cash_type,NEW.source_cash_id,'ledger',NEW.source_receivable_account_id,
    NEW.base_amount,'debit')
    OR NOT ic_payment_voucher_has_legs(NEW.destination_payment_voucher_id,
    NEW.destination_cash_type,NEW.destination_cash_id,'supplier',NEW.destination_supplier_id,
    NEW.base_amount,'credit') THEN
    RAISE EXCEPTION 'Actual payment voucher lines do not match confirmed bank, supplier and receivable amounts';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM ledger_accounts WHERE id=NEW.source_receivable_account_id
      AND company_id=NEW.source_company_id AND deleted_at IS NULL)
    OR NOT EXISTS(
      SELECT 1 FROM suppliers supplier
      JOIN companies property ON property.id=NEW.source_company_id
      WHERE supplier.id=NEW.destination_supplier_id
        AND supplier.company_id=NEW.destination_company_id
        AND supplier.active=true AND supplier.deleted_at IS NULL
        AND lower(regexp_replace(btrim(supplier.legal_name),'[[:space:]]+',' ','g'))
          = lower(regexp_replace(btrim(property.name),'[[:space:]]+',' ','g'))
    ) THEN
    RAISE EXCEPTION 'Original receivable/supplier identities do not belong to the paid company pair';
  END IF;
  IF NEW.source_cash_type='bank' THEN
    IF NOT EXISTS(SELECT 1 FROM bank_accounts WHERE id=NEW.source_cash_id
      AND company_id=NEW.source_company_id AND active=true AND deleted_at IS NULL)
    THEN RAISE EXCEPTION 'Source receipt bank account is not active in Properties'; END IF;
  ELSE
    IF NOT EXISTS(SELECT 1 FROM ledger_accounts WHERE id=NEW.source_cash_id
      AND company_id=NEW.source_company_id AND account_type='Cash'
      AND active=true AND deleted_at IS NULL)
    THEN RAISE EXCEPTION 'Source receipt cash ledger is not active in Properties'; END IF;
  END IF;
  IF NEW.destination_cash_type='bank' THEN
    IF NOT EXISTS(SELECT 1 FROM bank_accounts WHERE id=NEW.destination_cash_id
      AND company_id=NEW.destination_company_id AND active=true AND deleted_at IS NULL)
    THEN RAISE EXCEPTION 'Destination payment bank account is not active in receiving ERP company'; END IF;
  ELSE
    IF NOT EXISTS(SELECT 1 FROM ledger_accounts WHERE id=NEW.destination_cash_id
      AND company_id=NEW.destination_company_id AND account_type='Cash'
      AND active=true AND deleted_at IS NULL)
    THEN RAISE EXCEPTION 'Destination payment cash ledger is not active in ERP company'; END IF;
  END IF;
  RETURN NEW;
END $guard$;
CREATE TRIGGER ic_payment_pair_immutable
BEFORE INSERT OR UPDATE OR DELETE ON intercompany_container_payments
FOR EACH ROW EXECUTE FUNCTION ic_validate_payment_pair();

-- Canceling or changing destination company must never carry another pair's
-- paid credit. The Phase 5 service must release/reallocate credits first.
CREATE OR REPLACE FUNCTION ic_check_trade_payment_ownership()
RETURNS TRIGGER LANGUAGE plpgsql AS $guard$
DECLARE row RECORD;
BEGIN
  FOR row IN
    SELECT p.relationship_id,p.source_company_id,p.destination_company_id,
      SUM(a.amount) AS paid
      FROM intercompany_payment_allocations a
      JOIN intercompany_container_payments p ON p.id=a.payment_id
      WHERE a.trade_id=NEW.id
      GROUP BY p.relationship_id,p.source_company_id,p.destination_company_id
  LOOP
    IF row.paid < 0 THEN
      RAISE EXCEPTION 'Negative historical intercompany credit found on trade';
    END IF;
    IF row.paid > 0 AND (NEW.state <> 'active'
      OR NEW.relationship_id <> row.relationship_id
      OR NEW.source_company_id <> row.source_company_id
      OR NEW.destination_company_id <> row.destination_company_id) THEN
      RAISE EXCEPTION 'Changing container destination/canceling requires releasing original company-pair credit';
    END IF;
  END LOOP;
  RETURN NULL;
END $guard$;
CREATE CONSTRAINT TRIGGER ic_trade_payment_pair_guard
AFTER UPDATE ON intercompany_trades
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION ic_check_trade_payment_ownership();

-- Generic voucher edit or deletion must not mutate either side of a paired
-- payment, its reversals, or the underlying lines: use Phase 4 reverse workflow.
CREATE OR REPLACE FUNCTION ic_block_payment_voucher_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $guard$
DECLARE vid INTEGER;
BEGIN
  IF TG_TABLE_NAME='vouchers' AND TG_OP='INSERT' THEN
    IF NEW.reversal_of_voucher_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM intercompany_container_payments p
      WHERE NEW.reversal_of_voucher_id IN
        (p.source_receipt_voucher_id,p.destination_payment_voucher_id,
         p.source_reversal_voucher_id,p.destination_reversal_voucher_id)
    ) THEN
      RAISE EXCEPTION 'Use the coordinated Phase 4 payment reversal for mirrored actual cash';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_TABLE_NAME='voucher_entries' THEN
    IF TG_OP='INSERT' THEN
      vid := NEW.voucher_id;
    ELSE
      vid := OLD.voucher_id;
    END IF;
  ELSE
    vid := OLD.id;
  END IF;
  IF EXISTS(SELECT 1 FROM intercompany_container_payments p
    WHERE vid IN (p.source_receipt_voucher_id,p.destination_payment_voucher_id,
      p.source_reversal_voucher_id,p.destination_reversal_voucher_id))
  THEN RAISE EXCEPTION 'Mirrored intercompany cash vouchers require coordinated reversal'; END IF;
  IF TG_TABLE_NAME='voucher_entries' THEN
    IF TG_OP='UPDATE' THEN
      IF NEW.voucher_id IS DISTINCT FROM OLD.voucher_id THEN
        IF EXISTS(SELECT 1 FROM intercompany_container_payments p
          WHERE NEW.voucher_id IN (p.source_receipt_voucher_id,p.destination_payment_voucher_id,
            p.source_reversal_voucher_id,p.destination_reversal_voucher_id)) THEN
          RAISE EXCEPTION 'Cannot move a voucher entry into a mirrored cash payment';
        END IF;
      END IF;
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $guard$;
CREATE TRIGGER ic_payment_voucher_guard BEFORE INSERT OR UPDATE OR DELETE ON vouchers
FOR EACH ROW EXECUTE FUNCTION ic_block_payment_voucher_mutation();
CREATE TRIGGER ic_payment_voucher_entry_guard BEFORE INSERT OR UPDATE OR DELETE ON voucher_entries
FOR EACH ROW EXECUTE FUNCTION ic_block_payment_voucher_mutation();


-- ══ 20261105_005_intercompany_phase5_lifecycle.sql ══════════════════════════════════════════════
-- Phase 5: dedicated destination receipt and pre-receipt trade cancellation.
-- Keep the ONE physical container in Properties. This migration posts NO live
-- stock, cash, supplier, or GL changes and does not activate any workflow.

CREATE TABLE intercompany_destination_receipts (
  id BIGSERIAL PRIMARY KEY,
  trade_id INTEGER NOT NULL UNIQUE REFERENCES intercompany_trades(id) ON DELETE RESTRICT,
  relationship_id INTEGER NOT NULL REFERENCES intercompany_relationship_policies(id) ON DELETE RESTRICT,
  destination_company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  inventory_account_id INTEGER NOT NULL REFERENCES ledger_accounts(id) ON DELETE RESTRICT,
  git_account_id INTEGER NOT NULL REFERENCES ledger_accounts(id) ON DELETE RESTRICT,
  receipt_voucher_id INTEGER NOT NULL UNIQUE REFERENCES vouchers(id) ON DELETE RESTRICT,
  request_key VARCHAR(128) NOT NULL UNIQUE,
  request_fingerprint VARCHAR(64) NOT NULL,
  posting_date DATE NOT NULL,
  landed_cost NUMERIC(20,2) NOT NULL CHECK(landed_cost>0),
  arrival_evidence TEXT NOT NULL CHECK(length(btrim(arrival_evidence))>=8),
  reason TEXT NOT NULL CHECK(length(btrim(reason))>=3),
  actor_user_id VARCHAR NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ic_receipt_fingerprint CHECK(request_fingerprint ~ '^[0-9a-f]{64}$')
);
CREATE INDEX ic_destination_receipts_company_idx ON intercompany_destination_receipts(destination_company_id, posting_date);
CREATE TABLE intercompany_destination_receipt_items (
  id BIGSERIAL PRIMARY KEY,
  receipt_id BIGINT NOT NULL REFERENCES intercompany_destination_receipts(id) ON DELETE RESTRICT,
  stock_item_id INTEGER NOT NULL REFERENCES stock_items(id) ON DELETE RESTRICT,
  quantity NUMERIC(18,3) NOT NULL CHECK(quantity>0),
  landed_value NUMERIC(20,2) NOT NULL CHECK(landed_value>=0),
  value_moved NUMERIC(20,2) NOT NULL,
  -- The canonical movement table is created at runtime, not by Drizzle migrations.
  -- Ownership is enforced by the append-only guard below instead of a DDL FK.
  canonical_movement_id BIGINT NOT NULL UNIQUE,
  CONSTRAINT ic_receipt_one_item UNIQUE(receipt_id,stock_item_id),
  CONSTRAINT ic_receipt_no_cost_variance CHECK(landed_value=value_moved)
);

CREATE TABLE intercompany_trade_cancellations (
  id BIGSERIAL PRIMARY KEY,
  trade_id INTEGER NOT NULL UNIQUE REFERENCES intercompany_trades(id) ON DELETE RESTRICT,
  relationship_id INTEGER NOT NULL REFERENCES intercompany_relationship_policies(id) ON DELETE RESTRICT,
  source_company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  destination_company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  request_key VARCHAR(128) NOT NULL UNIQUE,
  request_fingerprint VARCHAR(64) NOT NULL,
  expected_version INTEGER NOT NULL CHECK(expected_version>0),
  posting_date DATE NOT NULL,
  landed_cost NUMERIC(20,2) NOT NULL CHECK(landed_cost>0),
  source_sale_reversal_voucher_id INTEGER NOT NULL UNIQUE REFERENCES vouchers(id) ON DELETE RESTRICT,
  source_cost_reversal_voucher_id INTEGER NOT NULL UNIQUE REFERENCES vouchers(id) ON DELETE RESTRICT,
  destination_git_reversal_voucher_id INTEGER NOT NULL UNIQUE REFERENCES vouchers(id) ON DELETE RESTRICT,
  reason TEXT NOT NULL CHECK(length(btrim(reason))>=3),
  cancellation_evidence TEXT NOT NULL CHECK(length(btrim(cancellation_evidence))>=8),
  released_credit NUMERIC(20,2) NOT NULL DEFAULT 0 CHECK(released_credit>=0),
  actor_user_id VARCHAR NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ic_cancellation_fingerprint CHECK(request_fingerprint ~ '^[0-9a-f]{64}$')
);

-- Credit released by canceling an unreceived trade stays available only to
-- its ORIGINAL payment / original company pair; NO cash vouchers are posted.
ALTER TABLE intercompany_payment_allocations DROP CONSTRAINT ic_payment_allocation_kind;
ALTER TABLE intercompany_payment_allocations ADD CONSTRAINT ic_payment_allocation_kind CHECK(
  allocation_kind IN ('manual','new_import_credit','cancel_credit_reallocate',
    'edit_release','reversal_release','cancel_release')
);
ALTER TABLE intercompany_payment_allocations DROP CONSTRAINT ic_payment_allocation_signed_kind;
ALTER TABLE intercompany_payment_allocations ADD CONSTRAINT ic_payment_allocation_signed_kind CHECK(
  (amount>0 AND allocation_kind IN ('manual','new_import_credit','cancel_credit_reallocate'))
  OR (amount<0 AND allocation_kind IN ('edit_release','reversal_release','cancel_release'))
);

CREATE OR REPLACE FUNCTION ic_phase5_receipt_immutable()
RETURNS TRIGGER LANGUAGE plpgsql AS $fn$
DECLARE t RECORD; p RECORD; v RECORD; l RECORD; a RECORD; actual NUMERIC(20,2); n INTEGER;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Confirmed intercompany receipt cannot be edited or deleted'; END IF;
  SELECT * INTO t FROM intercompany_trades WHERE id=NEW.trade_id;
  SELECT * INTO p FROM intercompany_relationship_policies WHERE id=NEW.relationship_id;
  SELECT * INTO v FROM vouchers WHERE id=NEW.receipt_voucher_id;
  SELECT * INTO l FROM locations WHERE id=NEW.location_id;
  SELECT * INTO a FROM ledger_accounts WHERE id=NEW.inventory_account_id;
  IF t.id IS NULL OR l.id IS NULL OR a.id IS NULL OR v.id IS NULL OR t.state<>'active' OR t.relationship_id<>NEW.relationship_id
     OR t.destination_company_id<>NEW.destination_company_id
     OR p.id IS NULL OR p.destination_git_account_id<>NEW.git_account_id
     OR l.company_id<>NEW.destination_company_id OR l.deleted_at IS NOT NULL
     OR a.company_id<>NEW.destination_company_id OR a.code<>'INVENTORY'
     OR a.account_type NOT IN ('Asset','Current Asset') OR a.deleted_at IS NOT NULL
     OR a.active IS DISTINCT FROM TRUE OR NEW.inventory_account_id=NEW.git_account_id
     OR v.company_id<>NEW.destination_company_id OR v.voucher_type<>'Journal'
     OR v.deleted_at IS NOT NULL OR v.total_amount<>NEW.landed_cost THEN
    RAISE EXCEPTION 'Intercompany destination receipt ownership, inventory account or journal mismatch';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM containers c WHERE c.id=t.physical_container_id
        AND c.company_id=t.source_company_id AND c.status='OTW' AND c.offload_date IS NULL)
     OR NOT EXISTS (SELECT 1 FROM intercompany_import_batch_containers b
        WHERE b.trade_id=NEW.trade_id AND b.confirmed_landed_cost=NEW.landed_cost) THEN
    RAISE EXCEPTION 'Receipt must use the canonical unreceived container and confirmed landed cost';
  END IF;
  SELECT COUNT(*) INTO n FROM voucher_entries WHERE voucher_id=v.id;
  SELECT COALESCE(SUM(debit_amount),0) INTO actual FROM voucher_entries
    WHERE voucher_id=v.id AND ledger_account_id=NEW.inventory_account_id
      AND bank_account_id IS NULL AND supplier_id IS NULL AND COALESCE(credit_amount,0)=0;
  IF n<>2 OR actual<>NEW.landed_cost OR NOT EXISTS (
       SELECT 1 FROM voucher_entries WHERE voucher_id=v.id
         AND ledger_account_id=NEW.git_account_id AND credit_amount=NEW.landed_cost
         AND COALESCE(debit_amount,0)=0 AND bank_account_id IS NULL AND supplier_id IS NULL
     ) THEN
    RAISE EXCEPTION 'Destination stock receipt must have the exact inventory/GIT voucher legs';
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER ic_destination_receipt_guard BEFORE INSERT OR UPDATE OR DELETE
ON intercompany_destination_receipts FOR EACH ROW EXECUTE FUNCTION ic_phase5_receipt_immutable();

CREATE OR REPLACE FUNCTION ic_phase5_receipt_item_guard()
RETURNS TRIGGER LANGUAGE plpgsql AS $fn$
DECLARE r RECORD; movement RECORD;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Destination stock receipt evidence is append-only'; END IF;
  SELECT * INTO r FROM intercompany_destination_receipts WHERE id=NEW.receipt_id;
  SELECT * INTO movement FROM canonical_stock_movements WHERE id=NEW.canonical_movement_id;
  IF r.id IS NULL OR movement.id IS NULL
    OR NEW.quantity IS DISTINCT FROM (
      SELECT COALESCE(SUM(li.quantity),0)::numeric
      FROM intercompany_trades t
      JOIN po_line_items li ON li.po_id=t.destination_po_id
      WHERE t.id=r.trade_id AND li.stock_item_id=NEW.stock_item_id
    )
    OR movement.company_id<>r.destination_company_id
    OR movement.stock_item_id<>NEW.stock_item_id
    OR movement.location_id<>r.location_id OR movement.movement_kind<>'receipt'
    OR movement.source_type<>'intercompany-destination-receipt'
    OR movement.source_id<>r.trade_id::text
    OR movement.quantity_delta<>NEW.quantity
    OR ROUND(movement.quantity_delta*movement.unit_cost,2)<>NEW.landed_value
    OR NOT EXISTS (SELECT 1 FROM stock_items s
        WHERE s.id=NEW.stock_item_id AND s.company_id=r.destination_company_id) THEN
    RAISE EXCEPTION 'Destination receipt movement must be in the ERP destination only';
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER ic_destination_receipt_item_guard BEFORE INSERT OR UPDATE OR DELETE
ON intercompany_destination_receipt_items FOR EACH ROW EXECUTE FUNCTION ic_phase5_receipt_item_guard();

CREATE OR REPLACE FUNCTION ic_phase5_receipt_totals()
RETURNS TRIGGER LANGUAGE plpgsql AS $fn$
DECLARE receipt_id_to_check BIGINT; r RECORD; total NUMERIC(20,2);
BEGIN
  IF TG_TABLE_NAME='intercompany_destination_receipts' THEN
    receipt_id_to_check := NEW.id;
  ELSE
    receipt_id_to_check := NEW.receipt_id;
  END IF;
  SELECT landed_cost, trade_id INTO r FROM intercompany_destination_receipts WHERE id=receipt_id_to_check;
  SELECT COALESCE(SUM(landed_value),0) INTO total
     FROM intercompany_destination_receipt_items WHERE receipt_id=receipt_id_to_check;
  IF r.landed_cost IS NULL OR r.landed_cost<>total THEN
    RAISE EXCEPTION 'All received destination item values must equal confirmed linked GIT cost';
  END IF;
  -- Matching the total is insufficient: a missing zero-cost/free PO item
  -- would otherwise never enter destination stock, even though the GL balances.
  IF EXISTS (
    SELECT DISTINCT li.stock_item_id
    FROM intercompany_trades t
    JOIN po_line_items li ON li.po_id=t.destination_po_id
    WHERE t.id=r.trade_id
    EXCEPT
    SELECT ri.stock_item_id FROM intercompany_destination_receipt_items ri
    WHERE ri.receipt_id=receipt_id_to_check
  ) THEN
    RAISE EXCEPTION 'Destination receipt items must cover all linked purchase stock items';
  END IF;
  RETURN NULL;
END $fn$;
CREATE CONSTRAINT TRIGGER ic_destination_receipt_sum
AFTER INSERT ON intercompany_destination_receipts DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION ic_phase5_receipt_totals();
CREATE CONSTRAINT TRIGGER ic_destination_receipt_item_sum
AFTER INSERT ON intercompany_destination_receipt_items DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION ic_phase5_receipt_totals();

CREATE OR REPLACE FUNCTION ic_phase5_trade_cancellation_guard()
RETURNS TRIGGER LANGUAGE plpgsql AS $fn$
BEGIN
  IF OLD.state='active' AND NEW.state='canceled' THEN
    IF current_setting('erp.ic_phase5_cancel',true) IS DISTINCT FROM OLD.id::text
       OR NEW.version<>OLD.version+1 OR NEW.canceled_at IS NULL
       OR (to_jsonb(NEW)-ARRAY['state','version','canceled_at']::text[])
          IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','version','canceled_at']::text[])
       OR NOT EXISTS (SELECT 1 FROM intercompany_trade_cancellations c
            WHERE c.trade_id=OLD.id AND c.expected_version=OLD.version) THEN
      RAISE EXCEPTION 'Cancel the intercompany trade only through synchronized Phase 5 accounting';
    END IF;
  ELSIF OLD.state='canceled' THEN
    RAISE EXCEPTION 'Canceled trade is immutable; never rewrite status, version or financial evidence';
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER ic_phase5_trade_cancel_guard BEFORE UPDATE ON intercompany_trades
FOR EACH ROW EXECUTE FUNCTION ic_phase5_trade_cancellation_guard();

CREATE OR REPLACE FUNCTION ic_validate_payment_allocation_row()
RETURNS TRIGGER LANGUAGE plpgsql AS $guard$
DECLARE payment_row RECORD; trade_row RECORD;
BEGIN
  IF TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'Intercompany payment allocations are append-only; post a release entry';
  END IF;
  SELECT * INTO payment_row FROM intercompany_container_payments WHERE id=NEW.payment_id;
  SELECT * INTO trade_row FROM intercompany_trades WHERE id=NEW.trade_id;
  IF NOT FOUND OR trade_row.state <> 'active'
    OR payment_row.status <> 'confirmed'
    OR payment_row.relationship_id <> trade_row.relationship_id
    OR payment_row.source_company_id <> trade_row.source_company_id
    OR payment_row.destination_company_id <> trade_row.destination_company_id THEN
    RAISE EXCEPTION 'Payment credit may be applied only to the same active company pair';
  END IF;
  IF NEW.amount < 0 AND NEW.allocation_kind NOT IN ('edit_release','reversal_release','cancel_release') THEN
    RAISE EXCEPTION 'Only audited payment releases may reduce allocation';
  END IF;
  IF NEW.allocation_kind = 'cancel_release'
    AND current_setting('erp.ic_phase5_cancel',true) IS DISTINCT FROM NEW.trade_id::text THEN
    RAISE EXCEPTION 'Phase 5 payment release requires the same atomic cancellation request';
  END IF;
  RETURN NEW;
END $guard$;

-- Verify ALL THREE real cancellation journals, not merely their headers.
-- Source sale: Dr Sales / Cr Receivable. Source cost: Dr Purchases /
-- Cr COGS. Destination: Dr Properties Supplier / Cr Goods In Transit.
CREATE OR REPLACE FUNCTION ic_phase5_exact_cancel_journal(
  vid INTEGER, debit_type TEXT, debit_id INTEGER, credit_type TEXT, credit_id INTEGER, usd NUMERIC)
RETURNS BOOLEAN LANGUAGE plpgsql STABLE AS $fn$
BEGIN
  RETURN (SELECT COUNT(*)=2 FROM voucher_entries WHERE voucher_id=vid)
    AND EXISTS (SELECT 1 FROM voucher_entries e
      WHERE e.voucher_id=vid AND e.debit_amount=usd AND COALESCE(e.credit_amount,0)=0
        AND e.bank_account_id IS NULL
        AND ((debit_type='ledger' AND e.ledger_account_id=debit_id AND e.supplier_id IS NULL)
          OR (debit_type='supplier' AND e.supplier_id=debit_id AND e.ledger_account_id IS NULL)))
    AND EXISTS (SELECT 1 FROM voucher_entries e
      WHERE e.voucher_id=vid AND e.credit_amount=usd AND COALESCE(e.debit_amount,0)=0
        AND e.bank_account_id IS NULL
        AND ((credit_type='ledger' AND e.ledger_account_id=credit_id AND e.supplier_id IS NULL)
          OR (credit_type='supplier' AND e.supplier_id=credit_id AND e.ledger_account_id IS NULL)));
END $fn$;
CREATE OR REPLACE FUNCTION ic_phase5_cancellation_immutable()
RETURNS TRIGGER LANGUAGE plpgsql AS $fn$
DECLARE t RECORD; p RECORD; v1 RECORD; v2 RECORD; v3 RECORD;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Intercompany cancellation evidence cannot be modified'; END IF;
  IF current_setting('erp.ic_phase5_cancel',true) IS DISTINCT FROM NEW.trade_id::text THEN
    RAISE EXCEPTION 'Cancellation evidence requires the same atomic cancellation transaction';
  END IF;
  SELECT * INTO t FROM intercompany_trades WHERE id=NEW.trade_id;
  SELECT * INTO p FROM intercompany_relationship_policies WHERE id=NEW.relationship_id;
  SELECT * INTO v1 FROM vouchers WHERE id=NEW.source_sale_reversal_voucher_id;
  SELECT * INTO v2 FROM vouchers WHERE id=NEW.source_cost_reversal_voucher_id;
  SELECT * INTO v3 FROM vouchers WHERE id=NEW.destination_git_reversal_voucher_id;
  IF t.id IS NULL OR p.id IS NULL OR t.state<>'active' OR t.version<>NEW.expected_version
    OR t.relationship_id<>NEW.relationship_id
    OR t.source_company_id<>NEW.source_company_id OR t.destination_company_id<>NEW.destination_company_id
    OR v1.id IS NULL OR v2.id IS NULL OR v3.id IS NULL
    OR v1.id=v2.id OR v1.id=v3.id OR v2.id=v3.id
    OR v1.company_id<>NEW.source_company_id OR v2.company_id<>NEW.source_company_id
    OR v3.company_id<>NEW.destination_company_id
    OR v1.voucher_type<>'Journal' OR v2.voucher_type<>'Journal' OR v3.voucher_type<>'Journal'
    OR v1.deleted_at IS NOT NULL OR v2.deleted_at IS NOT NULL OR v3.deleted_at IS NOT NULL
    OR v1.total_amount<>NEW.landed_cost OR v2.total_amount<>NEW.landed_cost
    OR v3.total_amount<>NEW.landed_cost
    OR p.source_receivable_account_id IS NULL OR p.source_sales_account_id IS NULL
    OR p.source_cost_account_id IS NULL OR p.source_purchase_account_id IS NULL
    OR p.destination_git_account_id IS NULL OR p.destination_supplier_id IS NULL THEN
    RAISE EXCEPTION 'Cancellation requires exact original-pair balanced voucher evidence';
  END IF;
  IF NOT ic_phase5_exact_cancel_journal(v1.id,'ledger',p.source_sales_account_id,
      'ledger',p.source_receivable_account_id,NEW.landed_cost)
    OR NOT ic_phase5_exact_cancel_journal(v2.id,'ledger',p.source_purchase_account_id,
      'ledger',p.source_cost_account_id,NEW.landed_cost)
    OR NOT ic_phase5_exact_cancel_journal(v3.id,'supplier',p.destination_supplier_id,
      'ledger',p.destination_git_account_id,NEW.landed_cost) THEN
    RAISE EXCEPTION 'Cancellation reversal journal lines must exactly offset the original pair';
  END IF;
  IF NEW.released_credit IS DISTINCT FROM (
      SELECT COALESCE(SUM(-allocation.amount),0)::numeric
      FROM intercompany_payment_allocations allocation
      WHERE allocation.trade_id=NEW.trade_id AND allocation.allocation_kind='cancel_release'
    ) THEN
    RAISE EXCEPTION 'Cancellation credit evidence must match original pair release rows';
  END IF;
  IF EXISTS(SELECT 1 FROM intercompany_destination_receipts WHERE trade_id=NEW.trade_id)
     OR EXISTS(SELECT 1 FROM intercompany_shared_charge_allocations
       WHERE trade_id=NEW.trade_id AND amount<>0) THEN
    RAISE EXCEPTION 'Received stock or unreassigned shared invoice charge prevents cancellation';
  END IF;
  RETURN NEW;
END $fn$;

CREATE TRIGGER ic_phase5_cancellation_insert_guard BEFORE INSERT OR UPDATE OR DELETE
ON intercompany_trade_cancellations FOR EACH ROW EXECUTE FUNCTION ic_phase5_cancellation_immutable();

-- Financial evidence must remain locked even AFTER a trade is canceled.
-- Phase 3's linked PO trigger deliberately checks active trades only; without
-- this additional guard a canceled PO could be edited by legacy routes.
CREATE OR REPLACE FUNCTION ic_phase5_preserve_closed_trade_history()
RETURNS TRIGGER LANGUAGE plpgsql AS $fn$
DECLARE pid INTEGER; cid INTEGER; vid INTEGER;
BEGIN
  IF TG_TABLE_NAME='purchase_orders' THEN
    pid:=CASE WHEN TG_OP='INSERT' THEN NEW.id ELSE OLD.id END;
  ELSIF TG_TABLE_NAME='po_line_items' THEN
    pid:=CASE WHEN TG_OP='INSERT' THEN NEW.po_id ELSE OLD.po_id END;
  ELSIF TG_TABLE_NAME='container_charges' THEN
    cid:=CASE WHEN TG_OP='INSERT' THEN NEW.container_id ELSE OLD.container_id END;
  ELSIF TG_TABLE_NAME='containers' THEN
    cid:=OLD.id;
  ELSIF TG_TABLE_NAME='voucher_entries' THEN
    vid:=CASE WHEN TG_OP='INSERT' THEN NEW.voucher_id ELSE OLD.voucher_id END;
  ELSE
    vid:=CASE WHEN TG_OP='INSERT' THEN NEW.id ELSE OLD.id END;
  END IF;
  IF pid IS NOT NULL AND EXISTS (
    SELECT 1 FROM intercompany_trades t
    WHERE (t.state='canceled' OR EXISTS(
      SELECT 1 FROM intercompany_destination_receipts r WHERE r.trade_id=t.id
    )) AND (
      t.destination_po_id=pid OR t.original_supplier_po_id=pid
      OR EXISTS(SELECT 1 FROM intercompany_trade_source_pos sp WHERE sp.trade_id=t.id AND sp.source_po_id=pid)
    )
  ) THEN RAISE EXCEPTION 'Received or canceled intercompany purchase orders and lines are immutable'; END IF;
  IF cid IS NOT NULL AND EXISTS (
    SELECT 1 FROM intercompany_trades t WHERE (t.state='canceled' OR EXISTS(
      SELECT 1 FROM intercompany_destination_receipts r WHERE r.trade_id=t.id
    )) AND t.physical_container_id=cid
  ) THEN RAISE EXCEPTION 'Received or canceled intercompany physical container and charge evidence cannot be altered'; END IF;
  IF vid IS NOT NULL AND EXISTS (
    SELECT 1 FROM intercompany_trade_cancellations c
    WHERE vid IN (c.source_sale_reversal_voucher_id,c.source_cost_reversal_voucher_id,c.destination_git_reversal_voucher_id)
    UNION ALL
    SELECT 1 FROM intercompany_destination_receipts r WHERE vid=r.receipt_voucher_id
  ) THEN RAISE EXCEPTION 'Phase 5 posted vouchers and their entries are immutable'; END IF;
  -- Updates may not move an unrelated journal entry INTO an existing
  -- protected Phase 5 voucher, even if the old voucher was unprotected.
  IF TG_TABLE_NAME='voucher_entries' THEN
    IF TG_OP='UPDATE' THEN
      IF NEW.voucher_id IS DISTINCT FROM OLD.voucher_id
        AND (
          EXISTS (SELECT 1 FROM intercompany_trade_cancellations c
            WHERE NEW.voucher_id IN (c.source_sale_reversal_voucher_id,
              c.source_cost_reversal_voucher_id,c.destination_git_reversal_voucher_id))
          OR EXISTS (SELECT 1 FROM intercompany_destination_receipts r
            WHERE r.receipt_voucher_id=NEW.voucher_id)
        ) THEN
        RAISE EXCEPTION 'Cannot move a journal entry into a protected Phase 5 voucher';
      END IF;
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $fn$;
CREATE TRIGGER ic_phase5_canceled_po_lock
BEFORE UPDATE OR DELETE ON purchase_orders FOR EACH ROW EXECUTE FUNCTION ic_phase5_preserve_closed_trade_history();
CREATE TRIGGER ic_phase5_canceled_line_lock
BEFORE INSERT OR UPDATE OR DELETE ON po_line_items FOR EACH ROW EXECUTE FUNCTION ic_phase5_preserve_closed_trade_history();
CREATE TRIGGER ic_phase5_canceled_charge_lock
BEFORE INSERT OR UPDATE OR DELETE ON container_charges FOR EACH ROW EXECUTE FUNCTION ic_phase5_preserve_closed_trade_history();
CREATE TRIGGER ic_phase5_canceled_container_lock
BEFORE UPDATE OF company_id,supplier_id,status,offload_date,items_total,charges_total,grand_total
 OR DELETE ON containers FOR EACH ROW EXECUTE FUNCTION ic_phase5_preserve_closed_trade_history();
CREATE TRIGGER ic_phase5_evidence_voucher_lock
BEFORE UPDATE OR DELETE ON vouchers FOR EACH ROW EXECUTE FUNCTION ic_phase5_preserve_closed_trade_history();
CREATE TRIGGER ic_phase5_evidence_entry_lock
BEFORE INSERT OR UPDATE OR DELETE ON voucher_entries FOR EACH ROW EXECUTE FUNCTION ic_phase5_preserve_closed_trade_history();

-- A completed ERP destination receipt locks the financial value and quantity
-- of both linked PO sides. Explicit verified inventory/COGS adjustments are a
-- later separate workflow, not a backdoor through Phase 3 revisions.
CREATE OR REPLACE FUNCTION ic_phase5_guard_received_revision()
RETURNS TRIGGER LANGUAGE plpgsql AS $fn$
BEGIN
  IF EXISTS (SELECT 1 FROM intercompany_destination_receipts WHERE trade_id=NEW.trade_id) THEN
    RAISE EXCEPTION 'ERP stock already received; PO and charge changes need a reviewed inventory/COGS correction';
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER ic_phase5_no_reprice_received_trade
BEFORE INSERT ON intercompany_trade_revisions FOR EACH ROW EXECUTE FUNCTION ic_phase5_guard_received_revision();

-- A received trade may NOT be canceled, and legacy receipt paths still cannot
-- offload its Properties-owned physical container.
CREATE OR REPLACE FUNCTION ic_phase5_block_cancel_after_receipt()
RETURNS TRIGGER LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.state='canceled' AND OLD.state<>'canceled' AND EXISTS (
      SELECT 1 FROM intercompany_destination_receipts WHERE trade_id=OLD.id) THEN
    RAISE EXCEPTION 'Offloaded ERP stock needs an approved inventory and COGS correction, not trade cancellation';
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER ic_phase5_stock_cancel_guard BEFORE UPDATE OF state ON intercompany_trades
FOR EACH ROW EXECUTE FUNCTION ic_phase5_block_cancel_after_receipt();

-- Existing voucher mutation and archival guards remain enabled.


-- ══ 20261113_001_intercompany_pristine_physical_delete.sql ══════════════════════════════════════════════
-- Allow an explicitly authorized, transaction-scoped hard deletion of the
-- complete, unreceived, financially untouched intercompany PO pair.
-- Ordinary UPDATE/DELETE remains immutable and cancellation retains history.
CREATE OR REPLACE FUNCTION ic_guard_trade_line_link()
RETURNS TRIGGER LANGUAGE plpgsql AS $block$
DECLARE trade_record RECORD;
DECLARE allowed_trade TEXT;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    allowed_trade := NULLIF(current_setting('erp.ic_physical_delete', true), '');
    IF TG_OP = 'DELETE' AND allowed_trade = OLD.trade_id::text
       AND EXISTS (
         SELECT 1 FROM intercompany_trades t
         JOIN containers c ON c.id=t.physical_container_id
         WHERE t.id=OLD.trade_id AND t.state='active' AND c.status='OTW'
           AND c.offload_date IS NULL
           AND NOT EXISTS (SELECT 1 FROM intercompany_destination_receipts r WHERE r.trade_id=t.id)
           AND NOT EXISTS (SELECT 1 FROM intercompany_payment_allocations a WHERE a.trade_id=t.id)
           AND NOT EXISTS (SELECT 1 FROM intercompany_trade_revisions r WHERE r.trade_id=t.id)
           AND NOT EXISTS (SELECT 1 FROM intercompany_shared_charge_allocations a WHERE a.trade_id=t.id)
           AND NOT EXISTS (SELECT 1 FROM intercompany_shared_charge_po_allocations a WHERE a.trade_id=t.id)
           AND NOT EXISTS (SELECT 1 FROM intercompany_trade_cancellations c WHERE c.trade_id=t.id)
       )
    THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'Linked source/destination line identities are immutable';
  END IF;
  SELECT source_company_id, destination_company_id, original_supplier_po_id, destination_po_id
    INTO trade_record FROM intercompany_trades WHERE id=NEW.trade_id;
  IF NOT EXISTS (
    SELECT 1 FROM po_line_items src
      JOIN purchase_orders spo ON spo.id=src.po_id
      JOIN po_line_items dst ON dst.id=NEW.destination_line_id
      JOIN purchase_orders dpo ON dpo.id=dst.po_id
     WHERE src.id=NEW.source_line_id AND spo.company_id=trade_record.source_company_id
       AND dpo.company_id=trade_record.destination_company_id
       AND dpo.id=trade_record.destination_po_id
       AND spo.container_id=dpo.container_id
       AND (spo.id=trade_record.original_supplier_po_id OR EXISTS (
         SELECT 1 FROM intercompany_trade_source_pos t
         WHERE t.trade_id=NEW.trade_id AND t.source_po_id=spo.id
       ))
  ) THEN
    RAISE EXCEPTION 'Line links must connect the source and destination POs of one trade';
  END IF;
  RETURN NEW;
END $block$;

