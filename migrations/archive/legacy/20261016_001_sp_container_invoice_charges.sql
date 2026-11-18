-- Supplier Partner containers carry the supplier-invoice charges of the PO Import
-- Excel (freight already existed as freight_estimate_usd). They are part of the
-- invoice total and are added to landed cost automatically at offload, so they no
-- longer have to be re-typed as offload charges. Additive and idempotent.

ALTER TABLE sp_containers
  ADD COLUMN IF NOT EXISTS surcharge_usd NUMERIC(20, 4) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS fumigation_usd NUMERIC(20, 4) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS document_charges_usd NUMERIC(20, 4) DEFAULT 0;
