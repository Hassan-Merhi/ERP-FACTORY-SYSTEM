-- Read-only Wave 1 audit for inventory valuation drift.
-- Safe to run against production: SELECT-only, no temporary tables, no writes.
--
-- Goals:
--   1. Surface positive inventory rows whose stored total_value materially differs
--      from quantity * average_rate.
--   2. Surface items that had POS edit reversal/apply activity while negative
--      layers existed, because ordinary receipt settlement can consume those
--      unrelated layers and collapse the live cost basis.
--   3. Give enough evidence to build a deterministic repair plan in Wave 5/6.

WITH inventory_drift AS (
  SELECT
    i.company_id,
    i.location_id,
    i.stock_item_id,
    si.code,
    si.name,
    i.quantity::numeric AS current_qty,
    i.average_rate::numeric AS current_rate,
    i.total_value::numeric AS current_value,
    (i.quantity::numeric * i.average_rate::numeric) AS qty_x_rate,
    (i.total_value::numeric - (i.quantity::numeric * i.average_rate::numeric)) AS value_delta,
    i.last_updated
  FROM inventory i
  JOIN stock_items si ON si.id = i.stock_item_id
  WHERE i.quantity::numeric > 0
),
pos_edit_activity AS (
  SELECT
    csm.company_id,
    csm.location_id,
    csm.stock_item_id,
    MIN(csm.occurred_at) AS first_edit_at,
    MAX(csm.occurred_at) AS last_edit_at,
    COUNT(*) FILTER (WHERE csm.idempotency_key LIKE '%:reverse:%') AS reversal_rows,
    COUNT(*) FILTER (WHERE csm.idempotency_key LIKE '%:issue:%') AS reissue_rows
  FROM canonical_stock_movements csm
  WHERE csm.source_type = 'pos-sale'
    AND (
      csm.idempotency_key LIKE '%:reverse:%'
      OR csm.idempotency_key LIKE '%:issue:%'
    )
  GROUP BY csm.company_id, csm.location_id, csm.stock_item_id
),
negative_layer_state AS (
  SELECT
    inl.company_id,
    inl.location_id,
    inl.stock_item_id,
    COUNT(*) AS open_negative_layers,
    SUM(inl.qty::numeric) AS open_negative_qty,
    MIN(inl.provisional_rate::numeric) AS min_layer_rate,
    MAX(inl.provisional_rate::numeric) AS max_layer_rate
  FROM inventory_negative_layers inl
  GROUP BY inl.company_id, inl.location_id, inl.stock_item_id
)
SELECT
  d.company_id,
  d.location_id,
  d.stock_item_id,
  d.code,
  d.name,
  d.current_qty,
  d.current_rate,
  d.current_value,
  d.qty_x_rate,
  d.value_delta,
  pea.first_edit_at,
  pea.last_edit_at,
  pea.reversal_rows,
  pea.reissue_rows,
  COALESCE(nls.open_negative_layers, 0) AS open_negative_layers,
  COALESCE(nls.open_negative_qty, 0) AS open_negative_qty,
  nls.min_layer_rate,
  nls.max_layer_rate,
  d.last_updated,
  CASE
    WHEN pea.stock_item_id IS NOT NULL AND COALESCE(nls.open_negative_layers, 0) > 0 THEN 'HIGH: POS edit activity + open negative layers'
    WHEN ABS(d.value_delta) >= 1 THEN 'MEDIUM: stored total differs from qty x avg rate by >= 1'
    WHEN ABS(d.value_delta) >= 0.10 THEN 'LOW: rounding/value drift >= 0.10'
    ELSE 'INFO'
  END AS risk
FROM inventory_drift d
LEFT JOIN pos_edit_activity pea
  ON pea.company_id = d.company_id
 AND pea.location_id = d.location_id
 AND pea.stock_item_id = d.stock_item_id
LEFT JOIN negative_layer_state nls
  ON nls.company_id = d.company_id
 AND nls.location_id = d.location_id
 AND nls.stock_item_id = d.stock_item_id
WHERE
  ABS(d.value_delta) >= 0.10
  OR pea.stock_item_id IS NOT NULL
  OR COALESCE(nls.open_negative_layers, 0) > 0
ORDER BY
  CASE
    WHEN pea.stock_item_id IS NOT NULL AND COALESCE(nls.open_negative_layers, 0) > 0 THEN 0
    WHEN ABS(d.value_delta) >= 1 THEN 1
    WHEN ABS(d.value_delta) >= 0.10 THEN 2
    ELSE 3
  END,
  ABS(d.value_delta) DESC,
  d.company_id,
  d.location_id,
  d.code;
