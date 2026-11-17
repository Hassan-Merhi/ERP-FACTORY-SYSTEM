-- Phase 3: additive legacy startup schema extracted from 033-sp-container-invoice-charges.ts.
-- No data repair, DELETE, or UPDATE. Controlled approval required.

ALTER TABLE sp_containers ADD COLUMN IF NOT EXISTS surcharge_usd NUMERIC(20, 4) DEFAULT 0;

ALTER TABLE sp_containers ADD COLUMN IF NOT EXISTS fumigation_usd NUMERIC(20, 4) DEFAULT 0;

ALTER TABLE sp_containers ADD COLUMN IF NOT EXISTS document_charges_usd NUMERIC(20, 4) DEFAULT 0;
