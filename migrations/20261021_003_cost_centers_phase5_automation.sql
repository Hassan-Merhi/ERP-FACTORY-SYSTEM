-- Phase 5: configurable, opt-in analytical allocation of new eligible source entries.
-- No default rules are seeded; no historical voucher, inventory, or daybook rows
-- are altered. Financial posting must never depend on analytical categorization.

CREATE TABLE IF NOT EXISTS cost_center_auto_rules (
  id BIGSERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  source_kind VARCHAR(24) NOT NULL,
  ledger_account_id INTEGER,
  source_module VARCHAR(40),
  factory_tx_type VARCHAR(40),
  cost_center_id INTEGER NOT NULL,
  allocation_percent NUMERIC(7,4) NOT NULL DEFAULT 100,
  active BOOLEAN NOT NULL DEFAULT true,
  created_by TEXT,
  updated_by TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now(),
  CONSTRAINT cost_center_auto_rules_kind_ck CHECK (
    (source_kind='VOUCHER_ENTRY' AND ledger_account_id IS NOT NULL AND factory_tx_type IS NULL)
    OR (source_kind='FACTORY_DAYBOOK' AND ledger_account_id IS NULL
        AND source_module IS NULL AND factory_tx_type IN ('EXPENSE','OPERATING_EXPENSE','FACTORY_EXPENSE'))
  ),
  CONSTRAINT cost_center_auto_rules_percent_ck CHECK (allocation_percent > 0 AND allocation_percent <= 100),
  CONSTRAINT cost_center_auto_rules_center_company_fk
    FOREIGN KEY (company_id,cost_center_id) REFERENCES cost_centers(company_id,id) ON DELETE RESTRICT,
  CONSTRAINT cost_center_auto_rules_ledger_fk FOREIGN KEY (ledger_account_id)
    REFERENCES ledger_accounts(id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX IF NOT EXISTS cost_center_auto_rules_scope_center_uidx ON
  cost_center_auto_rules(company_id, source_kind, coalesce(ledger_account_id,0),
     coalesce(source_module,''), coalesce(factory_tx_type,''), cost_center_id);
CREATE INDEX IF NOT EXISTS cost_center_auto_rules_lookup_idx ON
  cost_center_auto_rules(company_id,source_kind,ledger_account_id,active);

-- Manual overrides survive even when users CLEAR every split. Automatic rules
-- must never reinstate splits explicitly removed by a user.
CREATE TABLE IF NOT EXISTS cost_center_source_overrides (
  id BIGSERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  voucher_entry_id INTEGER REFERENCES voucher_entries(id) ON DELETE CASCADE,
  factory_daybook_entry_id INTEGER REFERENCES factory_daybook_entries(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  overridden_by TEXT,
  overridden_at TIMESTAMP NOT NULL DEFAULT now(),
  CONSTRAINT cost_center_source_overrides_one_source_ck CHECK (
    (voucher_entry_id IS NOT NULL AND factory_daybook_entry_id IS NULL)
    OR (voucher_entry_id IS NULL AND factory_daybook_entry_id IS NOT NULL)
  ),
  CONSTRAINT cost_center_source_overrides_reason_ck CHECK(length(btrim(reason))>=3)
);
CREATE UNIQUE INDEX IF NOT EXISTS cost_center_source_overrides_voucher_uidx
  ON cost_center_source_overrides(company_id,voucher_entry_id) WHERE voucher_entry_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS cost_center_source_overrides_daybook_uidx
  ON cost_center_source_overrides(company_id,factory_daybook_entry_id) WHERE factory_daybook_entry_id IS NOT NULL;

ALTER TABLE cost_center_allocations
  ADD COLUMN IF NOT EXISTS allocation_origin VARCHAR(12) NOT NULL DEFAULT 'MANUAL';
ALTER TABLE cost_center_allocations
  ADD COLUMN IF NOT EXISTS auto_rule_id BIGINT REFERENCES cost_center_auto_rules(id) ON DELETE SET NULL;
DO $cc_origin_constraint$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='cost_center_allocations_origin_ck') THEN
    ALTER TABLE cost_center_allocations ADD CONSTRAINT cost_center_allocations_origin_ck
      CHECK (allocation_origin IN ('AUTO','MANUAL'));
  END IF;
END
$cc_origin_constraint$;

ALTER TABLE cost_center_auto_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE cost_center_auto_rules FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cost_center_auto_rules_company_scope_policy ON cost_center_auto_rules;
CREATE POLICY cost_center_auto_rules_company_scope_policy ON cost_center_auto_rules
  USING (erp_company_scope_matches(company_id))
  WITH CHECK (erp_company_scope_matches(company_id));

ALTER TABLE cost_center_source_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE cost_center_source_overrides FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cost_center_source_overrides_company_scope_policy ON cost_center_source_overrides;
CREATE POLICY cost_center_source_overrides_company_scope_policy ON cost_center_source_overrides
  USING (erp_company_scope_matches(company_id))
  WITH CHECK (erp_company_scope_matches(company_id));

-- Serialize rule edits per company; reject cross-company/ineligible GL accounts
-- and prevent percentages exceeding 100 for a single exact match scope.
CREATE OR REPLACE FUNCTION cost_center_auto_rules_guard()
RETURNS trigger LANGUAGE plpgsql AS $cc_rules$
DECLARE
  account_kind TEXT;
  account_company INTEGER;
  percent_sum NUMERIC;
BEGIN
  PERFORM pg_advisory_xact_lock(721032, NEW.company_id);
  IF TG_OP='UPDATE' AND NEW.company_id IS DISTINCT FROM OLD.company_id THEN
    RAISE EXCEPTION 'Cannot move auto allocation rules across companies';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM cost_centers c
        WHERE c.company_id=NEW.company_id AND c.id=NEW.cost_center_id AND c.active=true)
      AND NEW.active THEN
    RAISE EXCEPTION 'Auto rule requires an active cost center';
  END IF;
  IF NEW.source_kind='VOUCHER_ENTRY' THEN
    SELECT company_id,upper(btrim(account_type)) INTO account_company,account_kind
      FROM ledger_accounts WHERE id=NEW.ledger_account_id;
    IF account_company IS DISTINCT FROM NEW.company_id
      OR account_kind NOT IN ('EXPENSE','DIRECT EXPENSE','INDIRECT EXPENSE') THEN
      RAISE EXCEPTION 'Automatic voucher rules require an eligible expense account in the same company';
    END IF;
    IF NEW.source_module IS NOT NULL AND length(btrim(NEW.source_module))=0 THEN
      RAISE EXCEPTION 'Source module must not be blank';
    END IF;
  END IF;
  IF NEW.active THEN
    SELECT coalesce(sum(allocation_percent),0) INTO percent_sum
      FROM cost_center_auto_rules r
      WHERE r.company_id=NEW.company_id AND r.source_kind=NEW.source_kind
        AND r.active AND r.id IS DISTINCT FROM NEW.id
        AND r.ledger_account_id IS NOT DISTINCT FROM NEW.ledger_account_id
        AND r.source_module IS NOT DISTINCT FROM NEW.source_module
        AND r.factory_tx_type IS NOT DISTINCT FROM NEW.factory_tx_type;
    IF percent_sum + NEW.allocation_percent > 100 THEN
      RAISE EXCEPTION 'Automatic cost center split exceeds 100 percent for this source';
    END IF;
  END IF;
  RETURN NEW;
END
$cc_rules$;
DROP TRIGGER IF EXISTS cost_center_auto_rules_guard_trg ON cost_center_auto_rules;
CREATE TRIGGER cost_center_auto_rules_guard_trg BEFORE INSERT OR UPDATE
ON cost_center_auto_rules FOR EACH ROW EXECUTE FUNCTION cost_center_auto_rules_guard();

-- Company isolation for deliberate manual overrides, including clear-all.
CREATE OR REPLACE FUNCTION cost_center_source_override_guard()
RETURNS trigger LANGUAGE plpgsql AS $cc_override$
DECLARE
  source_company INTEGER;
BEGIN
  IF TG_OP='UPDATE' AND (
    NEW.company_id IS DISTINCT FROM OLD.company_id
    OR NEW.voucher_entry_id IS DISTINCT FROM OLD.voucher_entry_id
    OR NEW.factory_daybook_entry_id IS DISTINCT FROM OLD.factory_daybook_entry_id
  ) THEN RAISE EXCEPTION 'Cannot change the company or source of a manual override'; END IF;
  IF NEW.voucher_entry_id IS NOT NULL AND NEW.factory_daybook_entry_id IS NULL THEN
    SELECT company_id INTO source_company FROM voucher_entries WHERE id=NEW.voucher_entry_id;
  ELSIF NEW.factory_daybook_entry_id IS NOT NULL AND NEW.voucher_entry_id IS NULL THEN
    SELECT company_id INTO source_company FROM factory_daybook_entries
    WHERE id=NEW.factory_daybook_entry_id;
  ELSE
    RAISE EXCEPTION 'Manual override must reference exactly one financial source';
  END IF;
  IF source_company IS DISTINCT FROM NEW.company_id THEN
    RAISE EXCEPTION 'Manual override must refer to a source in the same company';
  END IF;
  RETURN NEW;
END
$cc_override$;
DROP TRIGGER IF EXISTS cost_center_source_override_guard_trg ON cost_center_source_overrides;
CREATE TRIGGER cost_center_source_override_guard_trg BEFORE INSERT OR UPDATE
  ON cost_center_source_overrides FOR EACH ROW EXECUTE FUNCTION cost_center_source_override_guard();

-- Auto-tag failures are non-blocking and visible to accounting administrators.
CREATE TABLE IF NOT EXISTS cost_center_auto_failures (
  id BIGSERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  source_kind VARCHAR(24) NOT NULL,
  source_id INTEGER NOT NULL,
  last_error TEXT NOT NULL,
  failure_count INTEGER NOT NULL DEFAULT 1,
  last_seen TIMESTAMP NOT NULL DEFAULT now(),
  CONSTRAINT cost_center_auto_failures_kind_ck CHECK (
    source_kind IN ('VOUCHER_ENTRY','FACTORY_DAYBOOK')
  ),
  CONSTRAINT cost_center_auto_failures_company_source_unique
    UNIQUE (company_id,source_kind,source_id)
);
ALTER TABLE cost_center_auto_failures ENABLE ROW LEVEL SECURITY;
ALTER TABLE cost_center_auto_failures FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cost_center_auto_failures_company_scope_policy ON cost_center_auto_failures;
CREATE POLICY cost_center_auto_failures_company_scope_policy ON cost_center_auto_failures
  USING (erp_company_scope_matches(company_id))
  WITH CHECK (erp_company_scope_matches(company_id));

-- Failure logging must also fail open; financial documents always win.
CREATE OR REPLACE FUNCTION cost_center_auto_record_failure(
  p_company_id INTEGER,p_source_kind VARCHAR,p_source_id INTEGER,p_error TEXT
) RETURNS VOID LANGUAGE plpgsql AS $cc_failure$
BEGIN
  BEGIN
    INSERT INTO cost_center_auto_failures(company_id,source_kind,source_id,last_error)
      VALUES(p_company_id,p_source_kind,p_source_id,left(p_error,1000))
    ON CONFLICT (company_id,source_kind,source_id)
      DO UPDATE SET last_error=excluded.last_error,last_seen=now(),
                    failure_count=cost_center_auto_failures.failure_count+1;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'Cannot record cost center allocation diagnostic for source %: %',
      p_source_id,SQLERRM;
  END;
END
$cc_failure$;

-- The auto engine does not backfill; it runs only after newly inserted source
-- entries. Constraint triggers are deferred so an accounting transaction can
-- finish its FX normalization and optional voucher-finalization updates first.
CREATE OR REPLACE FUNCTION cost_center_auto_apply_voucher_entry(p_entry_id INTEGER)
RETURNS VOID LANGUAGE plpgsql AS $cc_auto_voucher$
DECLARE
  src RECORD;
  rule_rec RECORD;
  remaining_native NUMERIC(20,6);
  remaining_base NUMERIC(20,6);
  next_native NUMERIC(20,6);
  next_base NUMERIC(20,6);
  specificity INTEGER;
BEGIN
  SELECT ve.id,ve.company_id,ve.ledger_account_id,la.account_type,
    v.currency AS voucher_currency,v.source_module,v.optional,v.deleted_at,
    v.voucher_number,
    coalesce(ve.transaction_currency,v.currency,'USD') AS native_currency,
    coalesce(ve.transaction_debit_amount,ve.debit_amount,0) AS native_debit,
    coalesce(ve.transaction_credit_amount,ve.credit_amount,0) AS native_credit,
    coalesce(ve.base_debit_amount,ve.debit_amount,0) AS base_debit,
    coalesce(ve.base_credit_amount,ve.credit_amount,0) AS base_credit,
    ve.debit_amount,ve.credit_amount,
    ve.historical_exchange_rate,ve.rate_convention
  INTO src
  FROM voucher_entries ve
  JOIN vouchers v ON v.id=ve.voucher_id AND v.company_id=ve.company_id
  LEFT JOIN ledger_accounts la ON la.id=ve.ledger_account_id AND la.company_id=ve.company_id
  WHERE ve.id=p_entry_id AND v.deleted_at IS NULL;
  IF NOT FOUND OR src.optional OR src.debit_amount<=0 OR src.credit_amount<>0
      OR src.native_debit<=0 OR src.native_credit<>0
      OR src.base_debit<=0 OR src.base_credit<>0
      OR upper(btrim(coalesce(src.account_type,''))) NOT IN
         ('EXPENSE','DIRECT EXPENSE','INDIRECT EXPENSE')
      OR src.voucher_number LIKE 'GC-%' OR src.voucher_number LIKE 'MIG-%'
      OR src.source_module='SP_MIGRATION_READONLY' THEN RETURN; END IF;

  -- Do not override any manual or previous automatic split; also remember
  -- deliberate CLEAR ALL operations in cost_center_source_overrides.
  IF EXISTS (SELECT 1 FROM cost_center_allocations a WHERE a.voucher_entry_id=p_entry_id)
    OR EXISTS (SELECT 1 FROM cost_center_source_overrides o WHERE o.voucher_entry_id=p_entry_id) THEN
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cost_center_auto_rules r WHERE r.company_id=src.company_id
    AND r.source_kind='VOUCHER_ENTRY' AND r.ledger_account_id=src.ledger_account_id
    AND r.active) THEN RETURN; END IF;

  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM cost_center_auto_rules r JOIN cost_centers c ON c.company_id=r.company_id
       AND c.id=r.cost_center_id AND c.active
    WHERE r.company_id=src.company_id AND r.source_kind='VOUCHER_ENTRY'
      AND r.ledger_account_id=src.ledger_account_id
      AND r.source_module=src.source_module AND r.active
  ) THEN 1 ELSE 0 END INTO specificity;

  PERFORM pg_advisory_xact_lock(721031,src.company_id);
  remaining_native := round(src.native_debit,6);
  remaining_base := round(src.base_debit,6);
  FOR rule_rec IN
    SELECT r.* FROM cost_center_auto_rules r
    JOIN cost_centers c ON c.company_id=r.company_id AND c.id=r.cost_center_id AND c.active
    WHERE r.company_id=src.company_id AND r.source_kind='VOUCHER_ENTRY'
      AND r.ledger_account_id=src.ledger_account_id AND r.active
      AND ((specificity=1 AND r.source_module=src.source_module)
        OR (specificity=0 AND r.source_module IS NULL))
    ORDER BY r.id
  LOOP
    next_native := least(remaining_native,
      round(src.native_debit * rule_rec.allocation_percent / 100,6));
    next_base := least(remaining_base,
      round(src.base_debit * rule_rec.allocation_percent / 100,6));
    IF next_native > 0 THEN
      INSERT INTO cost_center_allocations(company_id,cost_center_id,voucher_entry_id,
        amount_native,currency,amount_base,base_currency,historical_rate,
        rate_convention,cost_treatment,allocation_origin,auto_rule_id,created_by,updated_by)
      VALUES (src.company_id,rule_rec.cost_center_id,p_entry_id,next_native,src.native_currency,
        next_base,'USD',src.historical_exchange_rate,src.rate_convention,'EXPENSE','AUTO',
        rule_rec.id,'system:auto','system:auto');
      remaining_native := remaining_native - next_native;
      remaining_base := remaining_base - next_base;
    END IF;
  END LOOP;
END
$cc_auto_voucher$;

CREATE OR REPLACE FUNCTION cost_center_auto_apply_factory_daybook(p_entry_id INTEGER)
RETURNS VOID LANGUAGE plpgsql AS $cc_auto_daybook$
DECLARE
  src RECORD;
  rule_rec RECORD;
  remaining_native NUMERIC(20,6);
  remaining_base NUMERIC(20,6);
  next_native NUMERIC(20,6);
  next_base NUMERIC(20,6);
BEGIN
  SELECT * INTO src FROM factory_daybook_entries
  WHERE id=p_entry_id
    AND tx_type IN ('EXPENSE','OPERATING_EXPENSE','FACTORY_EXPENSE')
    -- An independent event must have no accounting/document reference.
    -- Referenced expenses can share a voucher even when the reference table
    -- isn't literally named "vouchers"; never tag both representations.
    AND nullif(btrim(coalesce(reference_table,'')),'') IS NULL
    AND reference_id IS NULL
    AND amount_currency>0 AND amount_usd>=0;
  IF NOT FOUND THEN RETURN; END IF;
  IF EXISTS (SELECT 1 FROM cost_center_allocations a WHERE a.factory_daybook_entry_id=p_entry_id)
    OR EXISTS (SELECT 1 FROM cost_center_source_overrides o WHERE o.factory_daybook_entry_id=p_entry_id)
    THEN RETURN; END IF;
  PERFORM pg_advisory_xact_lock(721031,src.company_id);
  remaining_native:=round(abs(src.amount_currency),6);
  remaining_base:=round(abs(src.amount_usd),6);
  FOR rule_rec IN
    SELECT r.* FROM cost_center_auto_rules r
    JOIN cost_centers c ON c.company_id=r.company_id AND c.id=r.cost_center_id AND c.active
    WHERE r.company_id=src.company_id AND r.source_kind='FACTORY_DAYBOOK'
      AND r.factory_tx_type=src.tx_type AND r.active ORDER BY r.id
  LOOP
    next_native:=least(remaining_native,round(src.amount_currency*rule_rec.allocation_percent/100,6));
    next_base:=least(remaining_base,round(src.amount_usd*rule_rec.allocation_percent/100,6));
    IF next_native>0 THEN
      INSERT INTO cost_center_allocations(company_id,cost_center_id,factory_daybook_entry_id,
        amount_native,currency,amount_base,base_currency,historical_rate,
        rate_convention,cost_treatment,allocation_origin,auto_rule_id,created_by,updated_by)
      VALUES (src.company_id,rule_rec.cost_center_id,p_entry_id,next_native,src.currency_code,
        next_base,'USD',src.fx_rate_to_usd,'BASE_PER_TRANSACTION','EXPENSE',
        'AUTO',rule_rec.id,'system:auto','system:auto');
      remaining_native:=remaining_native-next_native;
      remaining_base:=remaining_base-next_base;
    END IF;
  END LOOP;
END
$cc_auto_daybook$;

CREATE OR REPLACE FUNCTION cost_center_auto_after_voucher_entry_insert()
RETURNS trigger LANGUAGE plpgsql AS $cc_auto_ve_trg$
BEGIN
  -- Keep financial posting available if analytical classification encounters
  -- a stale rule; the transaction's accounting facts are authoritative.
  BEGIN
    PERFORM cost_center_auto_apply_voucher_entry(NEW.id);
  EXCEPTION WHEN OTHERS THEN
    PERFORM cost_center_auto_record_failure(NEW.company_id,'VOUCHER_ENTRY',NEW.id,SQLERRM);
    RAISE WARNING 'Cost center auto allocation skipped voucher entry %: %',NEW.id,SQLERRM;
  END;
  RETURN NULL;
END
$cc_auto_ve_trg$;
DROP TRIGGER IF EXISTS cost_center_auto_voucher_insert_trg ON voucher_entries;
CREATE CONSTRAINT TRIGGER cost_center_auto_voucher_insert_trg
  AFTER INSERT ON voucher_entries DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION cost_center_auto_after_voucher_entry_insert();

CREATE OR REPLACE FUNCTION cost_center_auto_after_daybook_insert()
RETURNS trigger LANGUAGE plpgsql AS $cc_auto_fd_trg$
BEGIN
  BEGIN
    PERFORM cost_center_auto_apply_factory_daybook(NEW.id);
  EXCEPTION WHEN OTHERS THEN
    PERFORM cost_center_auto_record_failure(NEW.company_id,'FACTORY_DAYBOOK',NEW.id,SQLERRM);
    RAISE WARNING 'Cost center auto allocation skipped factory daybook entry %: %',NEW.id,SQLERRM;
  END;
  RETURN NULL;
END
$cc_auto_fd_trg$;
DROP TRIGGER IF EXISTS cost_center_auto_daybook_insert_trg ON factory_daybook_entries;
CREATE CONSTRAINT TRIGGER cost_center_auto_daybook_insert_trg
  AFTER INSERT ON factory_daybook_entries DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION cost_center_auto_after_daybook_insert();


-- Optional/draft vouchers receive no automatic allocations until finalized.
-- This trigger handles the later finalize transition in the SAME voucher
-- transaction, without assigning draft lines or modifying financial postings.
CREATE OR REPLACE FUNCTION cost_center_auto_after_voucher_finalize()
RETURNS trigger LANGUAGE plpgsql AS $cc_finalize$
DECLARE
  item RECORD;
BEGIN
  IF OLD.optional IS DISTINCT FROM TRUE OR NEW.optional IS DISTINCT FROM FALSE
    OR NEW.deleted_at IS NOT NULL THEN RETURN NULL; END IF;
  FOR item IN SELECT id FROM voucher_entries WHERE voucher_id=NEW.id AND company_id=NEW.company_id
  LOOP
    BEGIN
      PERFORM cost_center_auto_apply_voucher_entry(item.id);
    EXCEPTION WHEN OTHERS THEN
      PERFORM cost_center_auto_record_failure(NEW.company_id,'VOUCHER_ENTRY',item.id,SQLERRM);
      RAISE WARNING 'Cost center auto tagging skipped finalized voucher %, entry %: %',
        NEW.id,item.id,SQLERRM;
    END;
  END LOOP;
  RETURN NULL;
END
$cc_finalize$;
DROP TRIGGER IF EXISTS cost_center_auto_voucher_finalize_trg ON vouchers;
CREATE CONSTRAINT TRIGGER cost_center_auto_voucher_finalize_trg
  AFTER UPDATE OF optional ON vouchers DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (OLD.optional = true AND NEW.optional = false)
  EXECUTE FUNCTION cost_center_auto_after_voucher_finalize();
