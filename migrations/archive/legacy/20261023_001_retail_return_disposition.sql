-- Retail Phase 5: Additive per-line restock disposition.
-- Existing returns always restored stock; default TRUE preserves their history.
-- Damaged/non-sellable returns are refunded but do not increase inventory.
ALTER TABLE retail_pos_return_items
  ADD COLUMN IF NOT EXISTS restocked BOOLEAN NOT NULL DEFAULT true;
