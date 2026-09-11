#!/usr/bin/env node

import pg from "pg";

const { Client } = pg;

function usage(message) {
  if (message) console.error(message);
  console.error(
    "Usage: node scripts/audit-inventory-valuation-drift.mjs --company-id <id> [--threshold <fraction>] [--json]"
  );
  process.exitCode = 2;
}

function parseArgs(argv) {
  let companyId = null;
  let threshold = 0.15;
  let json = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--company-id") {
      companyId = Number(argv[index + 1]);
      index += 1;
    } else if (arg === "--threshold") {
      threshold = Number(argv[index + 1]);
      index += 1;
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--help" || arg === "-h") {
      usage();
      return null;
    } else {
      usage(`Unknown argument: ${arg}`);
      return null;
    }
  }

  if (!Number.isInteger(companyId) || companyId <= 0) {
    usage("--company-id must be a positive integer");
    return null;
  }
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold >= 1) {
    usage("--threshold must be a fraction greater than 0 and less than 1");
    return null;
  }

  return { companyId, threshold, json };
}

const AUDIT_SQL = `
WITH pos_edit_activity AS (
  SELECT
    company_id,
    location_id,
    stock_item_id,
    COUNT(*) FILTER (WHERE idempotency_key LIKE 'pos-sale:%:rev%:reverse:%')::int AS reversal_rows,
    COUNT(*) FILTER (WHERE idempotency_key LIKE 'pos-sale:%:rev%:issue:%')::int AS reissue_rows,
    MAX(occurred_at) AS last_pos_edit_at
  FROM canonical_stock_movements
  WHERE company_id = $1
    AND source_type = 'pos-sale'
    AND (
      idempotency_key LIKE 'pos-sale:%:rev%:reverse:%'
      OR idempotency_key LIKE 'pos-sale:%:rev%:issue:%'
    )
  GROUP BY company_id, location_id, stock_item_id
),
latest_movement AS (
  SELECT DISTINCT ON (company_id, location_id, stock_item_id)
    company_id,
    location_id,
    stock_item_id,
    occurred_at AS last_movement_at,
    unit_cost::numeric AS last_unit_cost,
    source_type AS last_source_type,
    source_id AS last_source_id
  FROM canonical_stock_movements
  WHERE company_id = $1
    AND quantity_delta <> 0
  ORDER BY company_id, location_id, stock_item_id, occurred_at DESC, id DESC
),
negative_layers AS (
  SELECT
    company_id,
    location_id,
    stock_item_id,
    SUM(qty)::numeric AS negative_layer_qty,
    COUNT(*)::int AS negative_layer_count
  FROM inventory_negative_layers
  WHERE company_id = $1
  GROUP BY company_id, location_id, stock_item_id
)
SELECT
  i.company_id,
  i.location_id,
  l.name AS location_name,
  i.stock_item_id,
  si.code AS stock_code,
  si.name AS stock_name,
  i.quantity::numeric AS current_qty,
  i.average_rate::numeric AS current_rate,
  i.total_value::numeric AS current_value,
  ROUND(i.quantity::numeric * i.average_rate::numeric, 2) AS qty_times_rate,
  ROUND(i.total_value::numeric - i.quantity::numeric * i.average_rate::numeric, 2) AS value_rate_diff,
  COALESCE(pea.reversal_rows, 0) AS pos_edit_reversal_rows,
  COALESCE(pea.reissue_rows, 0) AS pos_edit_reissue_rows,
  pea.last_pos_edit_at,
  lm.last_movement_at,
  lm.last_unit_cost,
  lm.last_source_type,
  lm.last_source_id,
  COALESCE(nl.negative_layer_qty, 0) AS negative_layer_qty,
  COALESCE(nl.negative_layer_count, 0) AS negative_layer_count,
  CASE
    WHEN lm.last_unit_cost > 0
      THEN ROUND(ABS(i.average_rate::numeric - lm.last_unit_cost) / lm.last_unit_cost * 100, 2)
    ELSE NULL
  END AS rate_drift_pct,
  CASE
    WHEN i.quantity::numeric > 0 AND COALESCE(nl.negative_layer_qty, 0) > 0
      THEN 'POSITIVE_STOCK_WITH_NEGATIVE_LAYER'
    WHEN COALESCE(pea.reversal_rows, 0) > 0
      AND lm.last_unit_cost > 0
      AND ABS(i.average_rate::numeric - lm.last_unit_cost) / lm.last_unit_cost >= $2
      THEN 'RATE_DRIFT_AFTER_POS_EDIT'
    ELSE NULL
  END AS reason
FROM inventory i
JOIN stock_items si ON si.id = i.stock_item_id AND si.company_id = i.company_id
JOIN locations l ON l.id = i.location_id
LEFT JOIN pos_edit_activity pea
  ON pea.company_id = i.company_id
 AND pea.location_id = i.location_id
 AND pea.stock_item_id = i.stock_item_id
LEFT JOIN latest_movement lm
  ON lm.company_id = i.company_id
 AND lm.location_id = i.location_id
 AND lm.stock_item_id = i.stock_item_id
LEFT JOIN negative_layers nl
  ON nl.company_id = i.company_id
 AND nl.location_id = i.location_id
 AND nl.stock_item_id = i.stock_item_id
WHERE i.company_id = $1
  AND i.quantity::numeric > 0
  AND (
    COALESCE(nl.negative_layer_qty, 0) > 0
    OR (
      COALESCE(pea.reversal_rows, 0) > 0
      AND lm.last_unit_cost > 0
      AND ABS(i.average_rate::numeric - lm.last_unit_cost) / lm.last_unit_cost >= $2
    )
  )
ORDER BY
  CASE
    WHEN i.quantity::numeric > 0 AND COALESCE(nl.negative_layer_qty, 0) > 0 THEN 0
    ELSE 1
  END,
  rate_drift_pct DESC NULLS LAST,
  pea.last_pos_edit_at DESC NULLS LAST,
  si.code;
`;

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options || process.exitCode) return;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required");
  }

  const client = new Client({ connectionString });
  await client.connect();

  try {
    await client.query("BEGIN READ ONLY");
    await client.query(
      `SELECT
         set_config('app.company_scope_maintenance', 'off', true),
         set_config('app.current_company_id', $1, true),
         set_config('app.authorized_company_ids', '', true)`,
      [String(options.companyId)]
    );

    const result = await client.query(AUDIT_SQL, [options.companyId, options.threshold]);

    if (options.json) {
      console.log(JSON.stringify({ companyId: options.companyId, threshold: options.threshold, rows: result.rows }, null, 2));
    } else if (result.rows.length === 0) {
      console.log(`No inventory valuation drift candidates found for company ${options.companyId}.`);
    } else {
      const summary = result.rows.reduce((counts, row) => {
        const key = String(row.reason || "REVIEW");
        counts[key] = (counts[key] || 0) + 1;
        return counts;
      }, {});
      console.log(`Inventory valuation drift candidates for company ${options.companyId}`);
      console.log(`Rate drift threshold: ${(options.threshold * 100).toFixed(1)}%`);
      console.table(summary);
      console.table(result.rows);
    }

    await client.query("ROLLBACK");
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // The connection may already be closed by the original error.
    }
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
