-- Phase 5 operator diagnostics — company FX rate integrity, READ ONLY.
-- Run under a restricted DB role. Does not write or retroactively revalue GL.
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '30s';

-- Same company/day/direction/pair duplicates. Before the unique constraint some
-- databases could contain these; saving only the earliest row would not change
-- the highest-id row used by the reporting resolver.
SELECT company_id, effective_date, UPPER(from_currency) AS from_currency,
       UPPER(to_currency) AS to_currency, COUNT(*) AS duplicate_count,
       ARRAY_AGG(id ORDER BY id) AS rate_row_ids
FROM exchange_rates
GROUP BY company_id, effective_date, UPPER(from_currency), UPPER(to_currency)
HAVING COUNT(*) > 1
ORDER BY company_id, effective_date;

-- Opposite USD -> foreign vs foreign -> USD quotes with differing rates
-- on the same company/day. XOF and CFA are the same canonical foreign code.
WITH quoted AS (
  SELECT id, company_id, effective_date,
         CASE WHEN UPPER(from_currency) = 'XOF' THEN 'CFA'
              ELSE UPPER(from_currency) END AS from_cc,
         CASE WHEN UPPER(to_currency) = 'XOF' THEN 'CFA'
              ELSE UPPER(to_currency) END AS to_cc,
         rate::numeric AS rate
  FROM exchange_rates
)
SELECT a.company_id, a.effective_date,
       a.to_cc AS foreign_currency,
       a.id AS usd_to_foreign_row,
       b.id AS foreign_to_usd_row,
       a.rate AS foreign_per_usd,
       b.rate AS usd_per_foreign,
       ABS((1 / NULLIF(a.rate, 0)) - b.rate) AS reciprocal_error
FROM quoted a
JOIN quoted b ON b.company_id = a.company_id
 AND b.effective_date = a.effective_date
 AND b.from_cc = a.to_cc AND b.to_cc = 'USD'
WHERE a.from_cc = 'USD' AND a.to_cc <> 'USD'
  AND a.rate > 0 AND b.rate > 0
  AND ABS((1 / a.rate) - b.rate) > 0.00000001
ORDER BY a.company_id, a.effective_date, a.to_cc;

-- Invalid stored rate values that must not be treated as a usable quote.
SELECT company_id, id, effective_date, from_currency, to_currency, rate
FROM exchange_rates
WHERE rate IS NULL OR rate <= 0
ORDER BY company_id, effective_date, id;

ROLLBACK;
