-- Phase 3: additive legacy startup schema extracted from 024-stock-item-schema-catchup.ts.
-- No data repair, DELETE, or UPDATE. Controlled approval required.

ALTER TABLE stock_items ADD COLUMN IF NOT EXISTS stock_group_id integer;

ALTER TABLE stock_items ADD COLUMN IF NOT EXISTS grade_id integer;

ALTER TABLE stock_items ADD COLUMN IF NOT EXISTS category_id integer;

ALTER TABLE stock_items ADD COLUMN IF NOT EXISTS opening_qty numeric(15,3) DEFAULT 0;

ALTER TABLE stock_items ADD COLUMN IF NOT EXISTS opening_rate numeric(15,2) DEFAULT 0;

ALTER TABLE stock_items ADD COLUMN IF NOT EXISTS opening_value numeric(15,2) DEFAULT 0;

ALTER TABLE stock_items ADD COLUMN IF NOT EXISTS reorder_level numeric(15,3) DEFAULT 0;

ALTER TABLE stock_items ADD COLUMN IF NOT EXISTS selling_price numeric(15,2) DEFAULT 0;

ALTER TABLE stock_items ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true;

ALTER TABLE stock_items ADD COLUMN IF NOT EXISTS deleted_at timestamp;

ALTER TABLE stock_items ADD COLUMN IF NOT EXISTS created_at timestamp NOT NULL DEFAULT now();
