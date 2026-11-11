-- Phase 5: freeze exact approved stock quantities without prices and render one cost-free Excel.
-- Additive only, no historical voucher or inventory mutations.
CREATE TABLE IF NOT EXISTS stock_transfer_order_approval_workbooks (
 company_id integer NOT NULL,
 batch_id bigint NOT NULL,
 snapshot_json jsonb NOT NULL,
 snapshot_sha256 varchar(64) NOT NULL,
 workbook_bytes bytea,
 workbook_sha256 varchar(64),
 filename text,
 rendered_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT sto_wa_workbooks_pk PRIMARY KEY (company_id,batch_id),
 CONSTRAINT sto_wa_workbooks_batch_fk FOREIGN KEY(company_id,batch_id)
  REFERENCES stock_transfer_order_approval_batches(company_id,id) ON DELETE RESTRICT,
 CONSTRAINT sto_wa_workbooks_snapshot_ck CHECK (jsonb_typeof(snapshot_json)='object' AND snapshot_sha256 ~ '^[a-f0-9]{64}$'),
 CONSTRAINT sto_wa_workbooks_render_ck CHECK
  ((workbook_bytes IS NULL AND workbook_sha256 IS NULL AND filename IS NULL AND rendered_at IS NULL)
    OR (workbook_bytes IS NOT NULL AND workbook_sha256 ~ '^[a-f0-9]{64}$'
      AND filename IS NOT NULL AND rendered_at IS NOT NULL AND octet_length(workbook_bytes) <= 20971520))
);

ALTER TABLE stock_transfer_order_approval_workbooks ENABLE ROW LEVEL SECURITY;

ALTER TABLE stock_transfer_order_approval_workbooks FORCE ROW LEVEL SECURITY;

DO $sto_workbook_policy$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_policies
   WHERE schemaname=current_schema() AND tablename='stock_transfer_order_approval_workbooks'
   AND policyname='sto_wa_company_scope') THEN
  CREATE POLICY sto_wa_company_scope ON stock_transfer_order_approval_workbooks
   USING (current_setting('app.company_scope_maintenance',true)='on'
     OR company_id=NULLIF(current_setting('app.current_company_id',true),'')::integer)
   WITH CHECK (current_setting('app.company_scope_maintenance',true)='on'
     OR company_id=NULLIF(current_setting('app.current_company_id',true),'')::integer);
 END IF;
 END $sto_workbook_policy$;

CREATE OR REPLACE FUNCTION sto_wa_workbook_immutable_guard() RETURNS trigger LANGUAGE plpgsql AS $sto_workbook$
 BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Approved workbook evidence cannot be deleted'; END IF;
  IF NEW.company_id IS DISTINCT FROM OLD.company_id
     OR NEW.batch_id IS DISTINCT FROM OLD.batch_id
     OR NEW.snapshot_json IS DISTINCT FROM OLD.snapshot_json
     OR NEW.snapshot_sha256 IS DISTINCT FROM OLD.snapshot_sha256
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR (OLD.workbook_bytes IS NOT NULL AND
       (NEW.workbook_bytes IS DISTINCT FROM OLD.workbook_bytes
        OR NEW.workbook_sha256 IS DISTINCT FROM OLD.workbook_sha256
        OR NEW.filename IS DISTINCT FROM OLD.filename
        OR NEW.rendered_at IS DISTINCT FROM OLD.rendered_at))
  THEN RAISE EXCEPTION 'Approved workbook snapshot is immutable'; END IF;
  RETURN NEW;
 END $sto_workbook$;

DO $sto_workbook_guard$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_trigger
   WHERE tgname='sto_wa_workbook_immutable_trg'
   AND tgrelid='stock_transfer_order_approval_workbooks'::regclass) THEN
  CREATE TRIGGER sto_wa_workbook_immutable_trg
   BEFORE UPDATE OR DELETE ON stock_transfer_order_approval_workbooks
   FOR EACH ROW EXECUTE FUNCTION sto_wa_workbook_immutable_guard();
 END IF;
 END $sto_workbook_guard$;

CREATE INDEX IF NOT EXISTS sto_wa_delivery_claim_expiry_idx
 ON stock_transfer_order_approval_deliveries(claim_expires_at,id)
 WHERE status='sending';
