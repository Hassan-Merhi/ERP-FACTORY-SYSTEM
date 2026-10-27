/**
 * Read-only provenance report for ERP supplier receipt / sales / stock COGS.
 *
 * npx tsx scripts/audit-erp-supplier-inventory-cost.ts --company 9 --supplier 27 --group 130 --repair-run 62
 * Optionally pass --out /tmp/mali-hmd-costs.json
 *
 * Safe by design: one repeatable-read READ ONLY transaction; --apply is refused.
 */
import { writeFileSync } from "node:fs";
import Decimal from "decimal.js";
import { pool } from "../server/db";

const dec = (value: unknown) => new Decimal(value == null ? "0" : String(value));
const usd = (value: Decimal) => value.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);

function positiveInt(name: string): number {
  const index = process.argv.indexOf(name);
  const raw = index < 0 ? "" : process.argv[index + 1];
  if (!raw || !/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw new Error("Missing valid " + name);
  }
  return Number(raw);
}

export interface CostRow {
  id: number;
  code: string;
  name: string;
  opening_qty: string;
  opening_value: string;
  qty_received: string;
  landed: string;
  qty_sold: string;
  sales: string;
  cogs: string;
  historical_profit: string;
  missing_sale_relief: number;
  qty_stock: string;
  stock_value: string;
  stock_at_rate: string;
  adj_qty: string;
  adj_value: string;
  transfer_lines: number;
  transfer_value_missing: number;
  blocked_sales: number;
  blocker: string | null;
}

export function costRowFlags(row: CostRow): string[] {
  const flags: string[] = [];
  const quantityGap = dec(row.qty_received).minus(row.qty_sold).minus(row.qty_stock);
  if (!quantityGap.isZero()) flags.push("QUANTITY_GAP");
  if (!quantityGap.plus(dec(row.adj_qty)).isZero()) flags.push("QUANTITY_UNRESOLVED_AFTER_ADJUSTMENTS");
  if (!dec(row.opening_qty).isZero() || !dec(row.opening_value).isZero()) flags.push("OPENING_STOCK_PRESENT");
  if (row.transfer_value_missing > 0) flags.push("TRANSFER_SOURCE_VALUE_UNPROVEN");
  if (row.blocked_sales > 0) flags.push("HISTORICAL_COST_PROOF_BLOCKED");
  if (row.missing_sale_relief > 0) flags.push("LEGACY_SALE_RELIEF_MISSING");
  if (
    dec(row.qty_sold).isZero() &&
    dec(row.qty_received).equals(row.qty_stock) &&
    row.transfer_lines > 0 &&
    !dec(row.landed).minus(row.stock_value).isZero()
  ) {
    flags.push("UNSOLD_TRANSFER_VALUE_DIFFERENCE");
  }
  const rawGap = dec(row.landed).minus(row.cogs).minus(row.stock_value);
  const afterAdjustments = rawGap.plus(row.adj_value);
  if (!rawGap.isZero() && afterAdjustments.isZero()) flags.push("COST_EXPLAINED_BY_ADJUSTMENT");
  if (!afterAdjustments.isZero()) flags.push("COST_GAP_AFTER_RECORDED_ADJUSTMENTS");
  return flags;
}

// All sources are tenant-filtered. The group is only a reporting proxy for the
// supplier and must not be treated as verified historical stock provenance.
const QUERY = [
  "WITH items AS MATERIALIZED (",
  "SELECT id,code,name,opening_qty,opening_value FROM stock_items",
  "WHERE company_id=$1 AND stock_group_id=$3 AND deleted_at IS NULL",
  "), received AS MATERIALIZED (",
  "SELECT oi.stock_item_id,SUM(oi.quantity::numeric) qty,SUM(oi.total_value::numeric) cost",
  "FROM container_offload_items oi JOIN container_offloads o ON o.id=oi.offload_id",
  "JOIN containers c ON c.id=o.container_id JOIN items i ON i.id=oi.stock_item_id",
  "WHERE c.company_id=$1 AND c.supplier_id=$2 AND c.status='OFFLOADED'",
  "AND c.deleted_at IS NULL AND o.optional=false GROUP BY oi.stock_item_id",
  "), sold AS MATERIALIZED (",
  "SELECT si.stock_item_id,SUM(si.quantity::numeric) qty,SUM(si.total_sales::numeric) sales,",
  "SUM(si.total_cost::numeric) cogs,SUM(si.profit::numeric) historical_profit,",
  "COUNT(*) FILTER (WHERE si.value_moved IS NULL)::int missing_relief",
  "FROM sales_items si JOIN vouchers v ON v.id=si.voucher_id",
  "JOIN items i ON i.id=si.stock_item_id",
  "WHERE v.company_id=$1 AND v.optional=false AND v.deleted_at IS NULL",
  "GROUP BY si.stock_item_id",
  "), stock AS MATERIALIZED (",
  "SELECT i.stock_item_id,SUM(i.quantity::numeric) qty,SUM(i.total_value::numeric) cost,",
  "SUM(i.quantity::numeric*i.average_rate::numeric) rate_cost",
  "FROM inventory i JOIN items it ON it.id=i.stock_item_id",
  "WHERE i.company_id=$1 GROUP BY i.stock_item_id",
  "), adjustments AS MATERIALIZED (",
  "SELECT m.stock_item_id,SUM(m.quantity_delta::numeric) qty,",
  "SUM(m.quantity_delta::numeric*m.unit_cost::numeric) adjustment_value",
  "FROM canonical_stock_movements m JOIN items i ON i.id=m.stock_item_id",
  "WHERE m.company_id=$1 AND m.source_type IN",
  "('stock-adjustment','stock_adjustment_edit_apply','stock_adjustment_edit_reverse',",
  "'credit-note','voucher_delete_pos_sale') GROUP BY m.stock_item_id",
  "), transfers AS MATERIALIZED (",
  "SELECT ti.stock_item_id,COUNT(*)::int n,",
  "COUNT(*) FILTER(WHERE ti.value_moved IS NULL)::int missing",
  "FROM stock_transfer_items ti JOIN stock_transfer_vouchers t ON t.id=ti.transfer_id",
  "JOIN vouchers v ON v.id=t.voucher_id JOIN items i ON i.id=ti.stock_item_id",
  "WHERE v.company_id=$1 AND v.deleted_at IS NULL AND v.optional=false",
  "GROUP BY ti.stock_item_id",
  "), blocked AS MATERIALIZED (",
  "SELECT r.stock_item_id,COUNT(*)::int n,",
  "STRING_AGG(DISTINCT r.blocker_code,', ' ORDER BY r.blocker_code) reasons",
  "FROM historical_sales_cost_repair_rows r JOIN items i ON i.id=r.stock_item_id",
  "WHERE r.company_id=$1 AND r.run_id=$4 AND r.status='blocked'",
  "GROUP BY r.stock_item_id",
  ") SELECT i.id,i.code,i.name,i.opening_qty::text,i.opening_value::text,",
  "COALESCE(r.qty,0)::text qty_received,COALESCE(r.cost,0)::text landed,",
  "COALESCE(s.qty,0)::text qty_sold,COALESCE(s.sales,0)::text sales,",
  "COALESCE(s.cogs,0)::text cogs,COALESCE(s.historical_profit,0)::text historical_profit,",
  "COALESCE(s.missing_relief,0)::int missing_sale_relief,",
  "COALESCE(st.qty,0)::text qty_stock,COALESCE(st.cost,0)::text stock_value,",
  "COALESCE(st.rate_cost,0)::text stock_at_rate,",
  "COALESCE(a.qty,0)::text adj_qty,COALESCE(a.adjustment_value,0)::text adj_value,",
  "COALESCE(t.n,0)::int transfer_lines,",
  "COALESCE(t.missing,0)::int transfer_value_missing,",
  "COALESCE(b.n,0)::int blocked_sales,b.reasons blocker",
  "FROM items i LEFT JOIN received r ON r.stock_item_id=i.id",
  "LEFT JOIN sold s ON s.stock_item_id=i.id",
  "LEFT JOIN stock st ON st.stock_item_id=i.id",
  "LEFT JOIN adjustments a ON a.stock_item_id=i.id",
  "LEFT JOIN transfers t ON t.stock_item_id=i.id",
  "LEFT JOIN blocked b ON b.stock_item_id=i.id ORDER BY i.code,i.id",
].join("\n");

export async function auditSupplierCost(company: number, supplier: number, group: number, run: number) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await client.query("SELECT set_config('app.current_company_id',$1,true)", [String(company)]);
    const ownedSupplier = await client.query(
      "SELECT id FROM suppliers WHERE company_id=$1 AND id=$2 AND deleted_at IS NULL",
      [company, supplier]
    );
    if (ownedSupplier.rowCount !== 1) throw new Error("Supplier does not belong to this company");
    const ownedGroup = await client.query(
      "SELECT id FROM stock_groups WHERE company_id=$1 AND id=$2 AND deleted_at IS NULL",
      [company, group]
    );
    if (ownedGroup.rowCount !== 1) throw new Error("Stock group does not belong to this company");
    const repairRun = await client.query("SELECT id FROM historical_sales_cost_repair_runs WHERE id=$1", [run]);
    if (repairRun.rowCount !== 1) throw new Error("Historical repair run not found");

    const result = await client.query<CostRow>(QUERY, [company, supplier, group, run]);
    const total = { landed: dec(0), sales: dec(0), cogs: dec(0), profit: dec(0), stock: dec(0), rateStock: dec(0), adjustments: dec(0) };
    const items = result.rows.map((r) => {
      total.landed = total.landed.plus(r.landed);
      total.sales = total.sales.plus(r.sales);
      total.cogs = total.cogs.plus(r.cogs);
      total.profit = total.profit.plus(r.historical_profit);
      total.stock = total.stock.plus(r.stock_value);
      total.rateStock = total.rateStock.plus(r.stock_at_rate);
      total.adjustments = total.adjustments.plus(r.adj_value);
      const qtyGap = dec(r.qty_received).minus(r.qty_sold).minus(r.qty_stock);
      return {
        stockItemId: r.id,
        code: r.code,
        qtyGap: qtyGap.toFixed(3),
        afterAdjustments: qtyGap.plus(r.adj_qty).toFixed(3),
        costGap: usd(dec(r.landed).minus(r.cogs).minus(r.stock_value)),
        costGapAfterNominalAdjustments: usd(dec(r.landed).plus(r.adj_value).minus(r.cogs).minus(r.stock_value)),
        blockedSaleLines: Number(r.blocked_sales),
        blocker: r.blocker,
        unrecordedTransferValues: Number(r.transfer_value_missing),
        flags: costRowFlags(r),
      };
    });
    const report = {
      readOnly: true,
      evidence: "current-snapshot-not-historical-as-of",
      company, supplier, stockGroup: group, historicalRepairRun: run,
      amountsUsd: {
        supplierReceipts: usd(total.landed),
        recordedSales: usd(total.sales),
        recordedCogs: usd(total.cogs),
        storedProfit: usd(total.profit),
        bookedProfit: usd(total.sales.minus(total.cogs)),
        stockAtSavedValue: usd(total.stock),
        stockAtRoundedRate: usd(total.rateStock),
        savedValueDifference: usd(total.landed.minus(total.cogs).minus(total.stock)),
        signedNominalAdjustments: usd(total.adjustments),
        gapAfterNominalAdjustments: usd(total.landed.plus(total.adjustments).minus(total.cogs).minus(total.stock)),
        roundedRateDifference: usd(total.landed.minus(total.cogs).minus(total.rateStock)),
        manualProfit: usd(total.sales.minus(total.landed).plus(total.rateStock)),
      },
      items,
      repairRules: [
        "Do not post a balancing expense or automatically rewrite 78.89.",
        "The adjustment tally is diagnostic only: some sources reverse sales or were edited; do not treat the full tally as an independent COGS correction.",
        "Resolve source receipt value, unrecorded transfer values and quantities by item.",
        "Use the historical sales-cost repair engine only for evidence-proven rows.",
        "Correct physical inventory and any perpetual-inventory journal together, under one audited transaction.",
        "Require zero unexplained per-item quantity and cost gaps before declaring reconciliation complete.",
      ],
    };
    await client.query("ROLLBACK");
    return report;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function main() {
  if (process.argv.includes("--apply")) throw new Error("Writes are disabled. Historical source values must be proven first.");
  const report = await auditSupplierCost(
    positiveInt("--company"),
    positiveInt("--supplier"),
    positiveInt("--group"),
    positiveInt("--repair-run")
  );
  const reportJson = JSON.stringify(report, null, 2);
  const out = process.argv.indexOf("--out");
  if (out < 0) console.log(reportJson);
  else {
    const file = process.argv[out + 1];
    if (!file) throw new Error("--out requires a file path");
    writeFileSync(file, reportJson + "\n");
    console.log("Read-only report saved to " + file);
  }
}

if (process.argv[1]?.endsWith("audit-erp-supplier-inventory-cost.ts")) {
  main()
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
