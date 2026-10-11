-- Accounting audit phase 24 (M5): non-USD purchase orders keep their native
-- currency, rate and amounts. The PO's money columns (items total, charges)
-- and its lines' rate / line total hold USD, the ledger currency; these
-- columns keep what was imported. Additive and idempotent: existing rows keep
-- NULL (a legacy PO). Also applied at boot by ensurePurchaseOrderCurrencySchema
-- (server/services/accounting/fx/purchaseOrderCurrencySchema.ts).

ALTER TABLE purchase_orders
  ADD COLUMN IF NOT EXISTS native_currency VARCHAR(10),
  ADD COLUMN IF NOT EXISTS exchange_rate NUMERIC(20, 10),
  ADD COLUMN IF NOT EXISTS native_items_total NUMERIC(20, 2),
  ADD COLUMN IF NOT EXISTS native_grand_total NUMERIC(20, 2);

ALTER TABLE po_line_items
  ADD COLUMN IF NOT EXISTS native_rate NUMERIC(20, 6),
  ADD COLUMN IF NOT EXISTS native_line_total NUMERIC(20, 2);
