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
