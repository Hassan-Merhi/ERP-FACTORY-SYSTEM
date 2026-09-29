-- Phase 5: stock-adjustment voucher headers must equal the values persisted
-- on stock_adjustment_items. Consumption rates can be resolved by inventory
-- after request validation, so submitted qty × rate is not authoritative.
--
-- Idempotent: only rows whose rounded header differs by at least one cent are
-- updated. Inventory, adjustment lines, and ledger entries are not changed.

WITH calculated AS (
  SELECT
    sav.voucher_id,
    ROUND(
      CASE
        WHEN LOWER(COALESCE(sav.adjustment_type, '')) = 'mixed' THEN
          COALESCE(
            SUM(
              CASE
                WHEN COALESCE(sai.quantity, 0) > 0
                  THEN ABS(COALESCE(sai.total_amount, 0))
                ELSE -ABS(COALESCE(sai.total_amount, 0))
              END
            ),
            0
          )
        ELSE COALESCE(SUM(ABS(COALESCE(sai.total_amount, 0))), 0)
      END,
      2
    ) AS expected_total
  FROM stock_adjustment_vouchers sav
  JOIN stock_adjustment_items sai
    ON sai.adjustment_id = sav.id
  GROUP BY sav.id, sav.voucher_id, sav.adjustment_type
)
UPDATE vouchers v
SET total_amount = calculated.expected_total
FROM calculated
WHERE v.id = calculated.voucher_id
  AND ABS(COALESCE(v.total_amount, 0) - calculated.expected_total) >= 0.01;
