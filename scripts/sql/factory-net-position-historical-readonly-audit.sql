-- Phase 8 READ-ONLY evidence worksheet for an authorized engineer.
--
-- DO NOT run during implementation. This file is for Claude's later
-- read-only review against a designated copy/replica, or a separately
-- approved production read-only connection. No DDL or DML is executed here.
--
-- Before using it, replace 1 with the actual FACTORY company ID and
-- Asia/Beirut with that company's Settings timezone. Output is evidence,
-- not an authorization to fabricate historical vouchers or values.

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '30s';

-- 1. Confirm that the trigger-owned audit columns actually exist.
-- If either is missing, historical Factory Net Position must fail closed.
SELECT table_name, column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN ('customer_order_bales', 'customer_order_bales_history')
  AND column_name = 'scanned_at'
ORDER BY table_name;

-- 2. A three-day comparison: only what was recorded by the end of each
-- company's business day counts, even if the source effective date was older.
WITH scope AS (
  SELECT 1::int AS company_id, 'Asia/Beirut'::text AS tz
), days AS (
  SELECT value::date AS as_of
    FROM (VALUES ('2026-10-19'), ('2026-10-20'), ('2026-10-21')) d(value)
), cuts AS (
  SELECT d.as_of, s.company_id,
         (((d.as_of + 1)::timestamp AT TIME ZONE s.tz) AT TIME ZONE 'UTC') AS utc_naive_cut,
         ((d.as_of + 1)::timestamp AT TIME ZONE s.tz) AS instant_cut
    FROM days d CROSS JOIN scope s
)
SELECT cut.as_of,
       (SELECT COUNT(*) FROM vouchers v
         WHERE v.company_id = cut.company_id AND v.optional = false
           AND COALESCE(v.effective_date, v.voucher_date) <= cut.as_of
           AND v.created_at < cut.utc_naive_cut
           AND (v.deleted_at IS NULL OR v.deleted_at >= cut.utc_naive_cut)
       ) AS voucher_headers_known_at_date,
       (SELECT COUNT(*) FROM factory_container_receipts r
         WHERE r.company_id = cut.company_id
           AND r.receipt_date <= cut.as_of AND r.created_at < cut.utc_naive_cut
           AND (r.deleted_at IS NULL OR r.deleted_at >= cut.utc_naive_cut)
       ) AS receipt_events_known_at_date,
       (SELECT COALESCE(SUM(r.received_kg),0) FROM factory_container_receipts r
         WHERE r.company_id = cut.company_id
           AND r.receipt_date <= cut.as_of AND r.created_at < cut.utc_naive_cut
           AND (r.deleted_at IS NULL OR r.deleted_at >= cut.utc_naive_cut)
       ) AS historical_received_kg,
       (SELECT COUNT(*) FROM customer_order_bales cob
          JOIN customer_orders co ON co.id = cob.order_id AND co.company_id = cut.company_id
         WHERE cob.scanned_at < cut.instant_cut AND co.created_at < cut.utc_naive_cut
       ) AS live_scan_rows_known_at_date,
       (SELECT COUNT(*) FROM customer_order_bales_history h
          JOIN customer_orders co ON co.id = h.order_id AND co.company_id = cut.company_id
         WHERE h.scanned_at < cut.instant_cut
           AND h.cancelled_at >= cut.instant_cut AND co.created_at < cut.utc_naive_cut
       ) AS cancelled_later_scans_known_at_date,
       (SELECT COUNT(*) FROM factory_fx_rates fx
         WHERE fx.company_id = cut.company_id AND fx.source = 'manual'
           AND fx.effective_date <= cut.as_of
           AND fx.created_at >= cut.utc_naive_cut
       ) AS backdated_fx_rates_not_yet_known
  FROM cuts cut
 ORDER BY cut.as_of;

-- 3. Containers with raw-stock quantities but no immutable receipt log.
-- This identifies **unrecoverable** historical quantities unless independent
-- signed daybook/offload evidence proves the original increments.
WITH scope AS (SELECT 1::int AS company_id)
SELECT fc.id AS container_id, fc.container_number,
       rs.received_kg AS current_cumulative_received_kg,
       rs.offloaded_at,
       fc.updated_at
  FROM factory_raw_stock rs
  JOIN factory_containers fc ON fc.id = rs.container_id AND fc.company_id = rs.company_id
 CROSS JOIN scope
 WHERE rs.company_id = scope.company_id
   AND NOT EXISTS (
      SELECT 1 FROM factory_container_receipts r
       WHERE r.company_id = rs.company_id AND r.container_id = rs.container_id
   )
 ORDER BY fc.id
 LIMIT 100;

-- 4. A time-audit window to distinguish the contents of historic orders.
-- NULL scanned_at is not a signal to backdate a bale allocation.
WITH scope AS (SELECT 1::int AS company_id)
SELECT co.id AS order_id,
       co.order_date,
       co.status AS current_status,
       co.created_at,
       co.updated_at,
       co.loading_started_at,
       co.verified_at,
       co.loading_finalized_at,
       co.finalized_at,
       COUNT(cob.id) AS current_scan_rows,
       COUNT(cob.id) FILTER (WHERE cob.scanned_at IS NULL) AS undated_live_scans
  FROM customer_orders co
 CROSS JOIN scope
  LEFT JOIN customer_order_bales cob ON cob.order_id = co.id
 WHERE co.company_id = scope.company_id
   AND co.order_date BETWEEN '2026-10-19'::date AND '2026-10-21'::date
 GROUP BY co.id
 ORDER BY co.id
 LIMIT 100;

-- 5. Deliberately no INSERT/UPDATE/DELETE of accounting or historical rows.
ROLLBACK;
