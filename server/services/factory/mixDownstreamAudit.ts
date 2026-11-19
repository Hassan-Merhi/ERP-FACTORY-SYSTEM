/**
 * Phase 5 — read-only accounting / production lineage of all factory mixes.
 *
 * A historical batch's stored cost is NOT authority to change old bale costs
 * when the production/output links have never been recorded. In particular,
 * finalizing pressing is NOT the same as finalizing a sale (finalized_at on
 * factory_bales may be present even for IN_STOCK stock).
 */
import Decimal from "decimal.js";
import { pool } from "../../db";

interface DbBatchLine {
  id: number;
  batch_code: string;
  batch_date: string | null;
  status: string;
  deleted_at: string | null;
  total_weight_kg: string;
  used_kg: string;
  total_cost: string;
  cost_per_kg: string;
  linked_bales: string;
  linked_bale_cost_usd: string;
  linked_pressing_batches: string;
  linked_daily_usages: string;
  mismatch_bales: string;
}
interface DbBaleTotals {
  total: string;
  active_rows: string;
  linked_to_mix: string;
  linked_via_pressing: string;
  missing_mix_link: string;
  sold: string;
  dispatched: string;
  in_stock: string;
  finished_stock_value_usd: string;
  linked_cost_mismatch: string;
  linked_total_abs_difference_usd: string;
}
interface DbLedgerState {
  effective_from: string | null;
  status: string | null;
  opening_voucher_id: number | null;
  replay_undo_runs: string;
  prior_recost_runs: string;
  prior_recost_linked_vouchers: string;
  factory_stock_value_events: string;
}
interface DbSaleLinks {
  ordered_bales: string;
  invoiced_loading_bales: string;
  pos_sale_bales: string;
}
export type DownstreamLineageClassification =
  | "DELETED_HISTORY"
  | "NO_RECORDED_PRODUCTION_LINEAGE"
  | "LINKED_BALE_COST_MISMATCH"
  | "LINKED_PRODUCTION_EVIDENCE"
  | "NOT_YET_CONSUMED";

export interface Phase5MixBatchLine {
  batchId: number;
  batchCode: string;
  batchDate: string | null;
  status: string;
  deleted: boolean;
  totalKg: string;
  usedKg: string;
  remainingKg: string;
  recordedUsd: string;
  recordedRateUsdPerKg: string;
  baleCount: number;
  pressingRecordCount: number;
  dailyUsageCount: number;
  recordedLinkedBaleCostUsd: string;
  mismatchedLinkedBales: number;
  classification: DownstreamLineageClassification;
  correctionDecision: "BLOCK_HISTORICAL_REPRICE" | "REVIEW_ONLY";
}
export interface Phase5DownstreamReconciliation {
  companyId: number;
  generatedAt: string;
  readOnly: true;
  summary: {
    activeMixBatches: number;
    deletedMixBatches: number;
    consumedMixesWithoutLineage: number;
    totalUsedMixKgWithoutLineage: string;
    batchesWithDownstreamLineage: number;
    activeBaleRows: number;
    unlinkedBaleRows: number;
    balesLinkedDirectlyToMix: number;
    balesLinkedViaPressing: number;
    soldBales: number;
    dispatchedBales: number;
    inStockBales: number;
    finishedGoodsSavedValueUsd: string;
    baleCostMismatchRows: number;
    linkedBaleAbsoluteValueDifferenceUsd: string;
    orderLinkedBales: number;
    invoiceLoadingLinkedBales: number;
    posSaleLinkedBales: number;
    inventoryCutoverActive: boolean;
    inventoryCutoverEffectiveFrom: string | null;
    historicalBaleRecostRuns: number;
    historicalBaleRecostVouchers: number;
    historicalReplayUndoRuns: number;
    factoryValueEvents: number;
  };
  batches: Phase5MixBatchLine[];
  recommendations: string[];
}

const value = (x: string | number | null | undefined): Decimal => new Decimal(x ?? "0");
const fixed = (x: Decimal, digits = 3): string => x.toDecimalPlaces(digits).toFixed(digits);
const int = (x: string | number | null | undefined): number => Number(x ?? 0);

export function classifyDownstreamMixLine(row: DbBatchLine): Phase5MixBatchLine {
  const deleted = row.deleted_at !== null;
  const remainingKg = value(row.total_weight_kg).minus(row.used_kg);
  const baleCount = int(row.linked_bales);
  const pressingCount = int(row.linked_pressing_batches);
  const dailyCount = int(row.linked_daily_usages);
  const mismatchCount = int(row.mismatch_bales);
  const hasLineage = baleCount > 0 || pressingCount > 0 || dailyCount > 0;
  const classification: DownstreamLineageClassification = deleted
    ? "DELETED_HISTORY"
    : value(row.used_kg).gt(0) && !hasLineage
      ? "NO_RECORDED_PRODUCTION_LINEAGE"
      : mismatchCount > 0
        ? "LINKED_BALE_COST_MISMATCH"
        : hasLineage
          ? "LINKED_PRODUCTION_EVIDENCE"
          : "NOT_YET_CONSUMED";
  return {
    batchId: row.id,
    batchCode: row.batch_code,
    batchDate: row.batch_date?.slice(0, 10) ?? null,
    status: row.status,
    deleted,
    totalKg: fixed(value(row.total_weight_kg)),
    usedKg: fixed(value(row.used_kg)),
    remainingKg: fixed(remainingKg),
    recordedUsd: fixed(value(row.total_cost), 7),
    recordedRateUsdPerKg: fixed(value(row.cost_per_kg), 7),
    baleCount,
    pressingRecordCount: pressingCount,
    dailyUsageCount: dailyCount,
    recordedLinkedBaleCostUsd: fixed(value(row.linked_bale_cost_usd), 7),
    mismatchedLinkedBales: mismatchCount,
    classification,
    correctionDecision:
      classification === "NO_RECORDED_PRODUCTION_LINEAGE" || classification === "LINKED_BALE_COST_MISMATCH"
        ? "BLOCK_HISTORICAL_REPRICE"
        : "REVIEW_ONLY",
  };
}

export function summarizePhase5MixDownstream(
  companyId: number,
  batchRows: DbBatchLine[],
  totals: DbBaleTotals,
  ledger: DbLedgerState,
  sales: DbSaleLinks
): Phase5DownstreamReconciliation {
  const batches = batchRows.map(classifyDownstreamMixLine);
  const active = batches.filter((b) => !b.deleted);
  const consumedWithoutLineage = active.filter((b) => b.classification === "NO_RECORDED_PRODUCTION_LINEAGE");
  const effectiveFrom = ledger.effective_from?.slice(0, 10) ?? null;
  const activeCutover =
    ledger.status === "ACTIVE" && !!effectiveFrom && effectiveFrom <= new Date().toISOString().slice(0, 10);
  return {
    companyId,
    generatedAt: new Date().toISOString(),
    readOnly: true,
    summary: {
      activeMixBatches: active.length,
      deletedMixBatches: batches.length - active.length,
      consumedMixesWithoutLineage: consumedWithoutLineage.length,
      totalUsedMixKgWithoutLineage: fixed(consumedWithoutLineage.reduce((sum, b) => sum.plus(b.usedKg), value(0))),
      batchesWithDownstreamLineage: active.filter(
        (b) => b.baleCount > 0 || b.pressingRecordCount > 0 || b.dailyUsageCount > 0
      ).length,
      activeBaleRows: int(totals.active_rows),
      unlinkedBaleRows: int(totals.missing_mix_link),
      balesLinkedDirectlyToMix: int(totals.linked_to_mix),
      balesLinkedViaPressing: int(totals.linked_via_pressing),
      soldBales: int(totals.sold),
      dispatchedBales: int(totals.dispatched),
      inStockBales: int(totals.in_stock),
      finishedGoodsSavedValueUsd: fixed(value(totals.finished_stock_value_usd), 7),
      baleCostMismatchRows: int(totals.linked_cost_mismatch),
      linkedBaleAbsoluteValueDifferenceUsd: fixed(value(totals.linked_total_abs_difference_usd), 7),
      orderLinkedBales: int(sales.ordered_bales),
      invoiceLoadingLinkedBales: int(sales.invoiced_loading_bales),
      posSaleLinkedBales: int(sales.pos_sale_bales),
      inventoryCutoverActive: !!activeCutover,
      inventoryCutoverEffectiveFrom: effectiveFrom,
      historicalBaleRecostRuns: int(ledger.prior_recost_runs),
      historicalBaleRecostVouchers: int(ledger.prior_recost_linked_vouchers),
      historicalReplayUndoRuns: int(ledger.replay_undo_runs),
      factoryValueEvents: int(ledger.factory_stock_value_events),
    },
    batches,
    recommendations: [
      "Do not infer a mix-to-bale mapping from bale timestamps, product names, weight or sale price.",
      "Reconcile pressing sheets, daily production/consumption, stock-entry source IDs, orders and dispatched/sold invoices before changing completed mix values.",
      "A zero linked-bale cost discrepancy count when no bales are linked proves nothing about the historical valuation of unlinked bales.",
      "Keep billed, dispatched, invoiced, POS-sold and finalized sale costs/COGS frozen until a separate approved accounting-period correction exists.",
      "Use reviewed bale-recost for proven eligible stock only. Never generate a duplicate voucher or a speculative COGS posting.",
      "If perpetual accounting is active, historical replay must not change inventory values without a matching atomic GL revaluation and open-period approval.",
    ],
  };
}

/** All queries share one repeatable-read, tenant-scoped, strictly read-only snapshot. */
export async function getPhase5MixDownstreamReconciliation(companyId: number): Promise<Phase5DownstreamReconciliation> {
  if (!Number.isSafeInteger(companyId) || companyId <= 0) throw new Error("Factory company is required");
  const client = await pool.connect();
  let open = false;
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    open = true;
    await client.query("SELECT set_config('app.current_company_id', $1, true)", [String(companyId)]);
    const batches = (
      await client.query<DbBatchLine>(
        "SELECT m.id,m.batch_code,m.batch_date::text,m.status,m.deleted_at::text, " +
          "m.total_weight_kg::text,m.used_kg::text,m.total_cost::text,m.cost_per_kg::text, " +
          "COALESCE(b.cnt,0)::text AS linked_bales,COALESCE(b.usd,0)::text AS linked_bale_cost_usd," +
          "COALESCE(p.cnt,0)::text AS linked_pressing_batches,COALESCE(d.cnt,0)::text AS linked_daily_usages," +
          "COALESCE(b.bad,0)::text AS mismatch_bales " +
          "FROM factory_mix_batches m " +
          "LEFT JOIN LATERAL (SELECT COUNT(*) cnt,COALESCE(SUM(fb.total_cost),0) usd, " +
          "COUNT(*) FILTER(WHERE abs(fb.cost_per_kg-m.cost_per_kg)>0.0001 " +
          "OR abs(fb.total_cost-(fb.weight_kg*m.cost_per_kg))>0.02) bad " +
          "FROM factory_bales fb WHERE fb.company_id=m.company_id AND fb.mix_batch_id=m.id " +
          "AND fb.deleted_at IS NULL AND fb.status NOT IN('DELETED','REMOVED')) b ON TRUE " +
          "LEFT JOIN LATERAL (SELECT COUNT(*) cnt FROM factory_pressing_batches pb " +
          "WHERE pb.company_id=m.company_id AND pb.mix_batch_id=m.id) p ON TRUE " +
          "LEFT JOIN LATERAL (SELECT COUNT(*) cnt FROM factory_daily_usages du " +
          "WHERE du.company_id=m.company_id AND du.mix_batch_id=m.id) d ON TRUE " +
          "WHERE m.company_id=$1 ORDER BY m.id",
        [companyId]
      )
    ).rows;
    const [totals] = (
      await client.query<DbBaleTotals>(
        "SELECT COUNT(*)::text AS total, " +
          "COUNT(*) FILTER(WHERE b.deleted_at IS NULL)::text AS active_rows," +
          "COUNT(*) FILTER(WHERE b.deleted_at IS NULL AND b.mix_batch_id IS NOT NULL)::text AS linked_to_mix," +
          "COUNT(*) FILTER(WHERE b.deleted_at IS NULL AND pb.mix_batch_id IS NOT NULL)::text AS linked_via_pressing," +
          "COUNT(*) FILTER(WHERE b.deleted_at IS NULL AND b.mix_batch_id IS NULL)::text AS missing_mix_link," +
          "COUNT(*) FILTER(WHERE b.deleted_at IS NULL AND b.status='SOLD')::text AS sold," +
          "COUNT(*) FILTER(WHERE b.deleted_at IS NULL AND b.status='DISPATCHED')::text AS dispatched," +
          "COUNT(*) FILTER(WHERE b.deleted_at IS NULL AND b.status='IN_STOCK')::text AS in_stock," +
          "COALESCE(SUM(b.total_cost) FILTER(WHERE b.deleted_at IS NULL AND b.status IN " +
          "('IN_STOCK','AVAILABLE','RESERVED_FOR_ORDER','RESERVED_FOR_DISPATCH')),0)::text AS finished_stock_value_usd," +
          "COUNT(*) FILTER(WHERE b.deleted_at IS NULL AND m.id IS NOT NULL " +
          "AND (abs(b.cost_per_kg-m.cost_per_kg)>0.0001 " +
          "OR abs(b.total_cost-b.weight_kg*m.cost_per_kg)>0.02))::text AS linked_cost_mismatch," +
          "COALESCE(SUM(abs(b.total_cost-b.weight_kg*m.cost_per_kg)) FILTER(WHERE b.deleted_at IS NULL " +
          "AND m.id IS NOT NULL AND (abs(b.cost_per_kg-m.cost_per_kg)>0.0001 " +
          "OR abs(b.total_cost-b.weight_kg*m.cost_per_kg)>0.02)),0)::text AS linked_total_abs_difference_usd " +
          "FROM factory_bales b LEFT JOIN factory_mix_batches m ON m.id=b.mix_batch_id AND m.company_id=b.company_id " +
          "LEFT JOIN factory_pressing_batches pb ON pb.id=b.pressing_batch_id AND pb.company_id=b.company_id " +
          "WHERE b.company_id=$1",
        [companyId]
      )
    ).rows;
    const [ledger] = (
      await client.query<DbLedgerState>(
        "SELECT (SELECT effective_from::text FROM gl_inventory_cutovers WHERE company_id=$1 LIMIT 1) effective_from," +
          "(SELECT status FROM gl_inventory_cutovers WHERE company_id=$1 LIMIT 1) status," +
          "(SELECT opening_voucher_id FROM gl_inventory_cutovers WHERE company_id=$1 LIMIT 1) opening_voucher_id," +
          "(SELECT COUNT(*)::text FROM factory_recalc_undo_log WHERE company_id=$1) replay_undo_runs," +
          "(SELECT COUNT(*)::text FROM factory_bale_recost_runs WHERE company_id=$1) prior_recost_runs," +
          "(SELECT COUNT(*)::text FROM factory_bale_recost_runs WHERE company_id=$1 AND voucher_id IS NOT NULL) prior_recost_linked_vouchers," +
          "(SELECT COUNT(*)::text FROM factory_stock_value_events WHERE company_id=$1) factory_stock_value_events",
        [companyId]
      )
    ).rows;
    const [sales] = (
      await client.query<DbSaleLinks>(
        "SELECT " +
          "(SELECT COUNT(DISTINCT cob.bale_id)::text FROM customer_order_bales cob " +
          "JOIN factory_bales b ON b.id=cob.bale_id AND b.company_id=$1 WHERE b.deleted_at IS NULL) ordered_bales," +
          "(SELECT COUNT(DISTINCT filb.bale_id)::text FROM factory_invoice_loading_bales filb " +
          "WHERE filb.company_id=$1) invoiced_loading_bales," +
          "(SELECT COUNT(DISTINCT psb.bale_id)::text FROM factory_pos_sale_bales psb " +
          "WHERE psb.company_id=$1) pos_sale_bales",
        [companyId]
      )
    ).rows;
    if (batches.length > 50000) throw new Error("Phase 5 mix reconciliation exceeded safe batch bound");
    const report = summarizePhase5MixDownstream(companyId, batches, totals!, ledger!, sales!);
    await client.query("COMMIT");
    open = false;
    return report;
  } catch (error) {
    if (open) await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export function phase5MixDownstreamCsv(report: Phase5DownstreamReconciliation): string {
  const cell = (raw: unknown): string => {
    const value = String(raw ?? "");
    const isFormula = /^\s*[=+@-]/.test(value) && !/^-?(?:\d+(\.\d*)?|\.\d+)$/.test(value.trim());
    return '"' + (isFormula ? "'" + value : value).replace(/\r?\n/g, " ").replace(/"/g, '""') + '"';
  };
  const rows: unknown[][] = [
    [
      "Batch ID",
      "Batch Code",
      "Date",
      "Status",
      "Deleted",
      "Used Kg",
      "Remaining Kg",
      "Recorded Total USD",
      "Recorded USD/kg",
      "Linked Bales",
      "Pressing Records",
      "Daily Usage Records",
      "Linked Bale Cost USD",
      "Linked Bale Mismatches",
      "Lineage Classification",
      "Historical Recost Decision",
    ],
  ];
  for (const b of report.batches)
    rows.push([
      b.batchId,
      b.batchCode,
      b.batchDate,
      b.status,
      b.deleted,
      b.usedKg,
      b.remainingKg,
      b.recordedUsd,
      b.recordedRateUsdPerKg,
      b.baleCount,
      b.pressingRecordCount,
      b.dailyUsageCount,
      b.recordedLinkedBaleCostUsd,
      b.mismatchedLinkedBales,
      b.classification,
      b.correctionDecision,
    ]);
  return "\uFEFF" + rows.map((row) => row.map(cell).join(",")).join("\r\n") + "\r\n";
}
