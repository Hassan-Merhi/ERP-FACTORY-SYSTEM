-- Presentation-only account grouping; never creates a ledger account or moves vouchers.
-- Apply once per database before enabling the Accounts layout editor.
CREATE TABLE IF NOT EXISTS account_display_layout (
  company_id INTEGER NOT NULL,
  node_key VARCHAR(100) NOT NULL,
  node_type VARCHAR(12) NOT NULL CHECK (node_type IN ('group', 'ledger')),
  name TEXT,
  parent_key VARCHAR(100),
  sort_order INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (company_id, node_key),
  CONSTRAINT account_display_layout_shape CHECK (
    (node_type = 'group' AND parent_key IS NULL AND length(trim(coalesce(name, ''))) > 0)
    OR (node_type = 'ledger' AND name IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS account_display_layout_company_parent_sort_idx
  ON account_display_layout(company_id, parent_key, sort_order);
