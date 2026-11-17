-- Phase 2 cost-center integrity; append-only migration, no historical DML.
-- Existing (Phase 1) analytical rows are empty in new installations.
-- New allocations must respect accounting source classification, and previously
-- tagged sources cannot be mutated without first adjusting/removing allocations.

CREATE OR REPLACE FUNCTION cost_center_allocation_eligibility_guard()
RETURNS trigger LANGUAGE plpgsql AS $cc_eligibility$
DECLARE
  active_center BOOLEAN;
  parent_voucher RECORD;
  daybook_type TEXT;
  daybook_reference TEXT;
BEGIN
  SELECT active INTO active_center FROM cost_centers
    WHERE id=NEW.cost_center_id AND company_id=NEW.company_id;
  IF active_center IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'Cannot allocate to missing or archived cost center';
  END IF;

  IF NEW.voucher_entry_id IS NOT NULL THEN
    SELECT la.account_type, la.code AS account_code, ve.debit_amount, ve.credit_amount, v.voucher_number, v.source_module, v.optional, v.deleted_at
      INTO parent_voucher
    FROM voucher_entries ve
    JOIN vouchers v ON v.id=ve.voucher_id
    LEFT JOIN ledger_accounts la ON la.id=ve.ledger_account_id AND la.company_id=ve.company_id
    WHERE ve.id=NEW.voucher_entry_id AND ve.company_id=NEW.company_id
      AND v.company_id=NEW.company_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Voucher entry is unavailable for cost allocation';
    END IF;
    IF parent_voucher.voucher_number IS NULL OR parent_voucher.deleted_at IS NOT NULL
       OR parent_voucher.optional = TRUE
       OR parent_voucher.voucher_number LIKE 'GC-%'
       OR parent_voucher.voucher_number LIKE 'MIG-%'
       OR parent_voucher.source_module = 'SP_MIGRATION_READONLY' THEN
      RAISE EXCEPTION 'Protected, optional, deleted or migrated vouchers cannot be allocated';
    END IF;
    IF upper(btrim(parent_voucher.account_type)) IN ('EXPENSE','DIRECT EXPENSE','INDIRECT EXPENSE') THEN
      IF NEW.cost_treatment <> 'EXPENSE' THEN
        RAISE EXCEPTION 'Expense ledger lines must keep EXPENSE cost treatment';
      END IF;
    ELSIF upper(btrim(parent_voucher.account_type)) = 'ASSET' THEN
      IF parent_voucher.account_code NOT IN (
        'FACTORY_RAW_MATERIAL_STOCK','FACTORY_WIP','FACTORY_FINISHED_GOODS'
      ) OR coalesce(parent_voucher.debit_amount,0) <= 0
        OR coalesce(parent_voucher.credit_amount,0) <> 0
        OR NEW.cost_treatment <> 'INVENTORY_COST' THEN
        RAISE EXCEPTION 'Only factory inventory stock accounts may receive INVENTORY_COST treatment';
      END IF;
    ELSE
      RAISE EXCEPTION 'Only expense or asset ledger lines may have cost center allocations';
    END IF;
  ELSE
    SELECT tx_type, reference_table INTO daybook_type, daybook_reference FROM factory_daybook_entries
    WHERE id=NEW.factory_daybook_entry_id AND company_id=NEW.company_id;
    -- No double-counting of Factory payment, journal, sale, or POS expense
    -- daybook mirrors. Future supported standalone expense types are explicit.
    IF daybook_type IS NULL OR daybook_type NOT IN
       ('EXPENSE', 'OPERATING_EXPENSE', 'FACTORY_EXPENSE')
       OR lower(coalesce(daybook_reference,'')) IN ('vouchers','voucher','voucher_entries','factory_pos_sales')
       OR NEW.cost_treatment <> 'EXPENSE' THEN
      RAISE EXCEPTION 'Factory daybook source is not a standalone expense';
    END IF;
  END IF;
  RETURN NEW;
END
$cc_eligibility$;

DROP TRIGGER IF EXISTS cost_center_allocation_eligibility_trg ON cost_center_allocations;
CREATE TRIGGER cost_center_allocation_eligibility_trg
BEFORE INSERT OR UPDATE ON cost_center_allocations
FOR EACH ROW EXECUTE FUNCTION cost_center_allocation_eligibility_guard();

CREATE OR REPLACE FUNCTION cost_center_voucher_entry_change_guard()
RETURNS trigger LANGUAGE plpgsql AS $cc_ve_guard$
BEGIN
  IF EXISTS (SELECT 1 FROM cost_center_allocations WHERE voucher_entry_id=OLD.id)
     AND (
       NEW.company_id IS DISTINCT FROM OLD.company_id OR
       NEW.voucher_id IS DISTINCT FROM OLD.voucher_id OR
       NEW.ledger_account_id IS DISTINCT FROM OLD.ledger_account_id OR
       NEW.debit_amount IS DISTINCT FROM OLD.debit_amount OR
       NEW.credit_amount IS DISTINCT FROM OLD.credit_amount OR
       NEW.transaction_currency IS DISTINCT FROM OLD.transaction_currency OR
       NEW.transaction_debit_amount IS DISTINCT FROM OLD.transaction_debit_amount OR
       NEW.transaction_credit_amount IS DISTINCT FROM OLD.transaction_credit_amount OR
       NEW.base_debit_amount IS DISTINCT FROM OLD.base_debit_amount OR
       NEW.base_credit_amount IS DISTINCT FROM OLD.base_credit_amount OR
       NEW.historical_exchange_rate IS DISTINCT FROM OLD.historical_exchange_rate OR
       NEW.rate_convention IS DISTINCT FROM OLD.rate_convention
     ) THEN
    RAISE EXCEPTION 'Voucher entry has cost center allocations; clear them before changing its monetary source fields';
  END IF;
  RETURN NEW;
END
$cc_ve_guard$;

DROP TRIGGER IF EXISTS cost_center_voucher_entry_change_trg ON voucher_entries;
CREATE TRIGGER cost_center_voucher_entry_change_trg
BEFORE UPDATE ON voucher_entries
FOR EACH ROW EXECUTE FUNCTION cost_center_voucher_entry_change_guard();

CREATE OR REPLACE FUNCTION cost_center_voucher_change_guard()
RETURNS trigger LANGUAGE plpgsql AS $cc_voucher_guard$
BEGIN
  IF EXISTS (
      SELECT 1 FROM voucher_entries ve
      JOIN cost_center_allocations a ON a.voucher_entry_id=ve.id
      WHERE ve.voucher_id=OLD.id
    ) AND (
      NEW.company_id IS DISTINCT FROM OLD.company_id OR
      NEW.voucher_date IS DISTINCT FROM OLD.voucher_date OR
      NEW.effective_date IS DISTINCT FROM OLD.effective_date OR
      NEW.currency IS DISTINCT FROM OLD.currency OR
      NEW.optional IS DISTINCT FROM OLD.optional
    ) THEN
    RAISE EXCEPTION 'Voucher has cost center allocations; clear them before changing its date, currency or posting status';
  END IF;
  -- A soft-deleted voucher is excluded from analytical activity. Never create
  -- a new voucher or manipulate existing posted amounts on source retirement.
  RETURN NEW;
END
$cc_voucher_guard$;

DROP TRIGGER IF EXISTS cost_center_voucher_change_trg ON vouchers;
CREATE TRIGGER cost_center_voucher_change_trg
BEFORE UPDATE ON vouchers
FOR EACH ROW EXECUTE FUNCTION cost_center_voucher_change_guard();

CREATE OR REPLACE FUNCTION cost_center_factory_daybook_change_guard()
RETURNS trigger LANGUAGE plpgsql AS $cc_factory_guard$
BEGIN
  IF EXISTS (SELECT 1 FROM cost_center_allocations WHERE factory_daybook_entry_id=OLD.id)
     AND (
       NEW.company_id IS DISTINCT FROM OLD.company_id OR
       NEW.tx_date IS DISTINCT FROM OLD.tx_date OR
       NEW.tx_type IS DISTINCT FROM OLD.tx_type OR
       NEW.currency_code IS DISTINCT FROM OLD.currency_code OR
       NEW.amount_currency IS DISTINCT FROM OLD.amount_currency OR
       NEW.amount_usd IS DISTINCT FROM OLD.amount_usd OR
       NEW.fx_rate_to_usd IS DISTINCT FROM OLD.fx_rate_to_usd
     ) THEN
    RAISE EXCEPTION 'Factory daybook entry is allocated; clear cost centers before modifying the source';
  END IF;
  RETURN NEW;
END
$cc_factory_guard$;

DROP TRIGGER IF EXISTS cost_center_factory_daybook_change_trg ON factory_daybook_entries;
CREATE TRIGGER cost_center_factory_daybook_change_trg
BEFORE UPDATE ON factory_daybook_entries
FOR EACH ROW EXECUTE FUNCTION cost_center_factory_daybook_change_guard();

-- Keep cost center hierarchy active/archived status internally consistent.
CREATE OR REPLACE FUNCTION cost_center_archive_children_guard()
RETURNS trigger LANGUAGE plpgsql AS $cc_archive_guard$
BEGIN
  IF OLD.active = TRUE AND NEW.active = FALSE AND EXISTS (
      SELECT 1 FROM cost_centers WHERE company_id=NEW.company_id
      AND parent_id=NEW.id AND active=TRUE
    ) THEN
    RAISE EXCEPTION 'Archive active child cost centers first';
  END IF;
  RETURN NEW;
END
$cc_archive_guard$;
DROP TRIGGER IF EXISTS cost_center_archive_children_trg ON cost_centers;
CREATE TRIGGER cost_center_archive_children_trg
BEFORE UPDATE OF active ON cost_centers
FOR EACH ROW EXECUTE FUNCTION cost_center_archive_children_guard();
