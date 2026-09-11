#!/usr/bin/env tsx
/**
 * Wave 5 inventory valuation dry run.
 *
 * This command is deliberately read-only. It identifies POS-edit valuation
 * candidates, reconstructs a conservative pre-edit cost baseline, and prints a
 * repair estimate only when the evidence is unambiguous enough for Wave 6.
 *
 * Usage:
 *   DATABASE_URL=postgres://... npx tsx scripts/inventory-valuation-wave5-dry-run.ts --company=8
 *   DATABASE_URL=postgres://... npx tsx scripts/inventory-valuation-wave5-dry-run.ts --company=8 --location=122 --json
 */

import { Pool } from "pg";
import {
  buildInventoryValuationRepairPlan,
  type InventoryValuationRepairClassification,
  type InventoryValuationRepairEvidence,
  type InventoryValuationRepairPlan,
} from "../server/services/inventory/inventoryValuationRepairPlan";

type DatabaseScalar = string | number | Date | null;

interface EvidenceRow {
  [column: string]: DatabaseScalar;
  company_id: number;
  location_id: number;
  location_name: string;
  stock_item_id: number;
  code: string;
  name: string;
  current_qty: string;
  current_rate: string;
  current_value: string;
  first_edit_at: Date;
  baseline_at: Date | null;
  baseline_rate: string | null;
  first_post_sale_at: Date | null;
  first_post_sale_rate: string | null;
  intervening_true_receipts: number;
  later_true_receipts: number;
  net_delta_since_edit: string;
  adjustment_edit_net_qty: string;
  max_adjustment_apply_rate_delta: string;
  last_updated: Date | null;
}

const args = process.argv.slice(2);

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return args.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

function positiveInteger(name: string, required = false): number | null {
  const raw = argument(name);
  if (!raw) {
    if (required) throw new Error(`--${name}=<positive integer> is required`);
    return null;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`--${name} must be a positive integer`);
  }
  return parsed;
}

function numeric(value: string | number | null): number {
  if (value === null || value === "") return 0;
  const parsed = typeof value === "number" ? value : Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function timestamp(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

const EVIDENCE_SQL = `
WITH first_edits AS (
  SELECT
    company_id,
    location_id,
    stock_item_id,
    MIN(occurred_at) AS first_edit_at
  FROM canonical_stock_movements
  WHERE company_id = $1
    AND source_type = 'pos-sale'
    AND idempotency_key LIKE '%:reverse:%'
    AND ($2::int IS NULL OR location_id = $2)
    AND ($3::int IS NULL OR stock_item_id = $3)
  GROUP BY company_id, location_id, stock_item_id
),
evidence AS (
  SELECT
    fe.*,
    baseline.occurred_at AS baseline_at,
    baseline.unit_cost::numeric AS baseline_rate,
    post_sale.occurred_at AS first_post_sale_at,
    post_sale.unit_cost::numeric AS first_post_sale_rate,
    COALESCE(intervening.true_receipts, 0)::int AS intervening_true_receipts,
    COALESCE(later.true_receipts, 0)::int AS later_true_receipts,
    COALESCE(movement.net_delta_since_edit, 0)::numeric AS net_delta_since_edit,
    COALESCE(adjustments.net_qty, 0)::numeric AS adjustment_edit_net_qty,
    COALESCE(adjustments.max_rate_delta, 0)::numeric AS max_adjustment_apply_rate_delta
  FROM first_edits fe
  LEFT JOIN LATERAL (
    SELECT c.occurred_at, c.unit_cost
    FROM canonical_stock_movements c
    WHERE c.company_id = fe.company_id
      AND c.location_id = fe.location_id
      AND c.stock_item_id = fe.stock_item_id
      AND c.source_type = 'pos-sale'
      AND c.quantity_delta::numeric < 0
      AND c.idempotency_key LIKE '%:rev0:%'
      AND c.occurred_at < fe.first_edit_at
    ORDER BY c.occurred_at DESC, c.id DESC
    LIMIT 1
  ) baseline ON TRUE
  LEFT JOIN LATERAL (
    SELECT c.occurred_at, c.unit_cost
    FROM canonical_stock_movements c
    WHERE c.company_id = fe.company_id
      AND c.location_id = fe.location_id
      AND c.stock_item_id = fe.stock_item_id
      AND c.source_type = 'pos-sale'
      AND c.quantity_delta::numeric < 0
      AND c.idempotency_key LIKE '%:rev0:%'
      AND c.occurred_at > fe.first_edit_at
    ORDER BY c.occurred_at ASC, c.id ASC
    LIMIT 1
  ) post_sale ON TRUE
  LEFT JOIN LATERAL (
    SELECT COUNT(*) AS true_receipts
    FROM canonical_stock_movements c
    WHERE c.company_id = fe.company_id
      AND c.location_id = fe.location_id
      AND c.stock_item_id = fe.stock_item_id
      AND c.occurred_at > baseline.occurred_at
      AND c.occurred_at < fe.first_edit_at
      AND c.quantity_delta::numeric > 0
      AND c.source_type NOT IN (
        'pos-sale',
        'stock_adjustment_edit_apply',
        'stock_adjustment_edit_reverse'
      )
  ) intervening ON TRUE
  LEFT JOIN LATERAL (
    SELECT COUNT(*) AS true_receipts
    FROM canonical_stock_movements c
    WHERE c.company_id = fe.company_id
      AND c.location_id = fe.location_id
      AND c.stock_item_id = fe.stock_item_id
      AND c.occurred_at > fe.first_edit_at
      AND c.quantity_delta::numeric > 0
      AND c.source_type NOT IN (
        'pos-sale',
        'stock_adjustment_edit_apply',
        'stock_adjustment_edit_reverse'
      )
  ) later ON TRUE
  LEFT JOIN LATERAL (
    SELECT COALESCE(SUM(c.quantity_delta::numeric), 0) AS net_delta_since_edit
    FROM canonical_stock_movements c
    WHERE c.company_id = fe.company_id
      AND c.location_id = fe.location_id
      AND c.stock_item_id = fe.stock_item_id
      AND c.occurred_at >= fe.first_edit_at
  ) movement ON TRUE
  LEFT JOIN LATERAL (
    SELECT
      COALESCE(SUM(c.quantity_delta::numeric), 0) AS net_qty,
      MAX(
        CASE
          WHEN c.source_type = 'stock_adjustment_edit_apply' AND baseline.unit_cost IS NOT NULL
            THEN ABS(c.unit_cost::numeric - baseline.unit_cost::numeric)
          ELSE 0
        END
      ) AS max_rate_delta
    FROM canonical_stock_movements c
    WHERE c.company_id = fe.company_id
      AND c.location_id = fe.location_id
      AND c.stock_item_id = fe.stock_item_id
      AND c.occurred_at > fe.first_edit_at
      AND c.source_type IN ('stock_adjustment_edit_apply', 'stock_adjustment_edit_reverse')
  ) adjustments ON TRUE
)
SELECT
  i.company_id,
  i.location_id,
  l.name AS location_name,
  i.stock_item_id,
  si.code,
  si.name,
  i.quantity::numeric AS current_qty,
  i.average_rate::numeric AS current_rate,
  i.total_value::numeric AS current_value,
  e.first_edit_at,
  e.baseline_at,
  e.baseline_rate,
  e.first_post_sale_at,
  e.first_post_sale_rate,
  e.intervening_true_receipts,
  e.later_true_receipts,
  e.net_delta_since_edit,
  e.adjustment_edit_net_qty,
  e.max_adjustment_apply_rate_delta,
  i.last_updated
FROM evidence e
JOIN inventory i
  ON i.company_id = e.company_id
 AND i.location_id = e.location_id
 AND i.stock_item_id = e.stock_item_id
JOIN locations l ON l.id = i.location_id
JOIN stock_items si ON si.id = i.stock_item_id
WHERE i.company_id = $1
ORDER BY i.location_id, si.code, i.stock_item_id;
`;

function toEvidence(row: EvidenceRow): InventoryValuationRepairEvidence {
  return {
    companyId: row.company_id,
    locationId: row.location_id,
    stockItemId: row.stock_item_id,
    code: row.code,
    name: row.name,
    currentQuantity: numeric(row.current_qty),
    currentRate: numeric(row.current_rate),
    currentValue: numeric(row.current_value),
    firstEditAt: row.first_edit_at.toISOString(),
    baselineAt: timestamp(row.baseline_at),
    baselineRate: row.baseline_rate === null ? null : numeric(row.baseline_rate),
    firstPostSaleAt: timestamp(row.first_post_sale_at),
    firstPostSaleRate: row.first_post_sale_rate === null ? null : numeric(row.first_post_sale_rate),
    interveningTrueReceipts: numeric(row.intervening_true_receipts),
    laterTrueReceipts: numeric(row.later_true_receipts),
    netDeltaSinceEdit: numeric(row.net_delta_since_edit),
    adjustmentEditNetQuantity: numeric(row.adjustment_edit_net_qty),
    maxAdjustmentApplyRateDelta: numeric(row.max_adjustment_apply_rate_delta),
    lastUpdated: timestamp(row.last_updated),
  };
}

function classificationCounts(
  plans: InventoryValuationRepairPlan[]
): Record<InventoryValuationRepairClassification, number> {
  const counts: Record<InventoryValuationRepairClassification, number> = {
    HIGH_CONFIDENCE_DRY_RUN: 0,
    MANUAL_MISSING_BASELINE: 0,
    MANUAL_BASELINE_QTY_NONPOSITIVE: 0,
    MANUAL_NO_POST_EDIT_SALE: 0,
    MANUAL_INTERVENING_TRUE_RECEIPT: 0,
    MANUAL_LATER_TRUE_RECEIPT: 0,
    MANUAL_NONZERO_ADJUSTMENT_EDIT_NET: 0,
    MANUAL_ADJUSTMENT_RATE_CHANGED: 0,
    NO_ASSET_REPAIR: 0,
    NO_HIGH_CONFIDENCE_DRIFT: 0,
  };

  for (const plan of plans) counts[plan.classification] += 1;
  return counts;
}

function printText(plans: InventoryValuationRepairPlan[], companyId: number): void {
  const counts = classificationCounts(plans);
  const candidates = plans.filter((plan) => plan.dryRunEligible);

  console.log("Inventory valuation Wave 5 dry run");
  console.log(`Company: ${companyId}`);
  console.log(`Rows reviewed: ${plans.length}`);
  console.log(`High-confidence dry-run candidates: ${candidates.length}`);
  console.log("");

  for (const candidate of candidates) {
    console.log(
      [
        `${candidate.code} (${candidate.stockItemId})`,
        `location ${candidate.locationId}`,
        `qty ${candidate.currentQuantity}`,
        `current ${candidate.currentRate.toFixed(2)} / ${candidate.currentValue.toFixed(2)}`,
        `baseline ${candidate.expectedRate?.toFixed(2)}`,
        `estimated value ${candidate.expectedValueEstimate?.toFixed(2)}`,
        `estimated delta ${candidate.repairValueDeltaEstimate?.toFixed(2)}`,
        `snapshot ${candidate.lastUpdated ?? "unknown"}`,
      ].join(" | ")
    );
  }

  console.log("");
  for (const [classification, count] of Object.entries(counts)) {
    console.log(`${classification}: ${count}`);
  }
}

async function main(): Promise<void> {
  if (args.includes("--apply")) {
    throw new Error("Wave 5 is dry-run only; --apply is not supported");
  }

  const companyId = positiveInteger("company", true);
  if (companyId === null) throw new Error("Company is required");
  const locationId = positiveInteger("location");
  const stockItemId = positiveInteger("stock-item");
  const asJson = args.includes("--json");
  const databaseUrl = process.env.DATABASE_URL || process.env.RENDER_DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL (or RENDER_DATABASE_URL) is required");

  const pool = new Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  let transactionStarted = false;

  try {
    await client.query("BEGIN READ ONLY");
    transactionStarted = true;
    await client.query("SELECT set_config('app.current_company_id', $1, true)", [String(companyId)]);

    const result = await client.query<EvidenceRow>(EVIDENCE_SQL, [companyId, locationId, stockItemId]);
    const plans = result.rows.map(toEvidence).map(buildInventoryValuationRepairPlan);

    if (asJson) {
      console.log(
        JSON.stringify(
          {
            mode: "dry-run",
            companyId,
            locationId,
            stockItemId,
            generatedAt: new Date().toISOString(),
            counts: classificationCounts(plans),
            plans,
          },
          null,
          2
        )
      );
    } else {
      printText(plans, companyId);
    }
  } finally {
    if (transactionStarted) await client.query("ROLLBACK");
    client.release();
    await pool.end();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
