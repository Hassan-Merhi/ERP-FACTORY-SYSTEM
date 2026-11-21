/**
 * Factory mix cost integrity Phase 4: ownership, adjustment and physical stock
 * provenance. Read-only consistent snapshot; never repairs historic quantities,
 * supplier links, adjustments, locked rates, FX or vouchers on a GET.
 */
import Decimal from "decimal.js";
import { pool } from "../../db";
import {
  dec,
  fix,
  groupSupplierKey,
  type Money,
  type RawRow,
  type OwnershipRow,
  type AdjustmentRow,
  type SupplierOnlyRow,
  type RawStockCoverage,
  type SupplierStockBalanceReview,
  type RawStockException,
  type OwnershipException,
  type AdjustmentEvidenceException,
  type Phase4SourceProvenanceReport,
} from "./mixPhase4ProvenanceAuditHelpers";
export {
  phase4MixProvenanceCsv,
  type RawStockCoverage,
  type SupplierStockBalanceReview,
  type RawStockException,
  type OwnershipException,
  type AdjustmentEvidenceException,
  type Phase4SourceProvenanceReport,
} from "./mixPhase4ProvenanceAuditHelpers";

const POSITIVE = new Decimal("0.01");

/** Pure classifier; negative raw row amounts can be explainable by ADD stock. */
export function classifySupplierStockCoverage(params: {
  receivedKg: Money;
  usedKg: Money;
  addAdjustmentKg: Money;
  deductAdjustmentKg: Money;
  rowOverdrawKg: Money;
}): { coverage: RawStockCoverage; netKg: string } {
  // DEDUCT has already reduced raw-stock receivedKg in legacy operations.
  // We report DEDUCT separately and do not subtract it a second time.
  const netKg = dec(params.receivedKg).plus(dec(params.addAdjustmentKg)).minus(dec(params.usedKg));
  const excess = dec(params.rowOverdrawKg);
  const add = dec(params.addAdjustmentKg);
  return {
    coverage: excess.lte(POSITIVE)
      ? "NON_NEGATIVE"
      : netKg.lt(POSITIVE.neg()) || add.plus(POSITIVE).lt(excess)
        ? "UNBACKED_SHORTAGE"
        : "POTENTIALLY_ADJUSTMENT_BACKED",
    netKg: fix(netKg),
  };
}

export function buildPhase4ProvenanceReport(
  companyId: number,
  raw: RawRow[],
  ownership: OwnershipRow[],
  adjustments: AdjustmentRow[],
  supplierOnly: SupplierOnlyRow[]
): Phase4SourceProvenanceReport {
  const totals = new Map<
    string,
    {
      id: number | null;
      name: string | null;
      received: Decimal;
      used: Decimal;
      excess: Decimal;
      add: Decimal;
      deduct: Decimal;
      rawIds: number[];
    }
  >();
  const ensure = (id: number | null, name: string | null) => {
    const key = groupSupplierKey(id);
    let item = totals.get(key);
    if (!item) {
      item = { id, name, received: dec(0), used: dec(0), excess: dec(0), add: dec(0), deduct: dec(0), rawIds: [] };
      totals.set(key, item);
    }
    if (name && !item.name) item.name = name;
    return item;
  };
  for (const row of raw) {
    const sup = ensure(row.supplier_id, row.supplier_name);
    const received = dec(row.received_kg);
    const used = dec(row.used_kg);
    sup.received = sup.received.plus(received);
    sup.used = sup.used.plus(used);
    if (used.gt(received)) {
      sup.excess = sup.excess.plus(used.minus(received));
      sup.rawIds.push(row.raw_stock_id);
    }
  }
  for (const adj of adjustments) {
    const sup = ensure(adj.supplier_id, adj.supplier_name);
    const type = adj.type.toUpperCase();
    if (type === "ADD") sup.add = sup.add.plus(adj.kg);
    if (type === "DEDUCT") sup.deduct = sup.deduct.plus(adj.kg);
  }
  const balances = [...totals.values()]
    .map((v): SupplierStockBalanceReview => {
      const classification = classifySupplierStockCoverage({
        receivedKg: v.received.toString(),
        usedKg: v.used.toString(),
        addAdjustmentKg: v.add.toString(),
        deductAdjustmentKg: v.deduct.toString(),
        rowOverdrawKg: v.excess.toString(),
      });
      return {
        supplierId: v.id,
        supplierName: v.name,
        receivedContainerKg: fix(v.received),
        usedContainerKg: fix(v.used),
        rawRowOverdrawKg: fix(v.excess),
        addAdjustmentKg: fix(v.add),
        deductAdjustmentKg: fix(v.deduct),
        netSupplierKg: classification.netKg,
        coverage: classification.coverage,
        explanation:
          classification.coverage === "POTENTIALLY_ADJUSTMENT_BACKED"
            ? "Recorded supplier ADD quantity can explain container-row overdraw; confirm historical event order before any repair."
            : classification.coverage === "UNBACKED_SHORTAGE"
              ? "Recorded receipts plus supplier ADD quantities do not cover usage. A physical movement reconciliation is required."
              : "No receipt-row overdraw beyond the audit tolerance.",
        affectedRawStockIds: v.rawIds,
      };
    })
    .sort((a, b) => (a.supplierId === null ? 1 : b.supplierId === null ? -1 : a.supplierId - b.supplierId));
  const supplierBalanceMap = new Map(balances.map((b) => [groupSupplierKey(b.supplierId), b]));
  const rawExceptions = raw
    .filter((r) => dec(r.used_kg).minus(r.received_kg).gt(POSITIVE))
    .map((r): RawStockException => ({
      rawStockId: r.raw_stock_id,
      supplierId: r.supplier_id,
      containerId: r.container_id,
      containerNumber: r.container_number,
      receivedKg: fix(dec(r.received_kg)),
      usedKg: fix(dec(r.used_kg)),
      excessUsedKg: fix(dec(r.used_kg).minus(r.received_kg)),
      stockValueRateUsd: r.cost_per_kg_usd,
      supplierCoverage: supplierBalanceMap.get(groupSupplierKey(r.supplier_id))?.coverage ?? "UNBACKED_SHORTAGE",
    }));
  const ownerExceptions: OwnershipException[] = ownership.map((row) => ({
    batchId: row.batch_id,
    batchCode: row.batch_code,
    batchStatus: row.batch_status,
    sourceId: row.source_id,
    containerId: row.container_id,
    containerNumber: row.container_company_id === companyId ? row.container_number : null,
    pricingSupplierId: row.source_supplier_id,
    recordedInventorySupplierId: row.inventory_supplier_id,
    currentContainerSupplierId: row.container_company_id === companyId ? row.container_supplier_id : null,
    sourceWeightKg: fix(dec(row.source_weight_kg)),
    recordedRateUsd: row.source_rate_usd,
    recordedSourceTotalUsd: row.source_total_usd,
    currentContainerCompanyId: row.container_company_id,
    classification:
      row.container_company_id === companyId ? "REQUIRES_HISTORICAL_TRANSFER_PROOF" : "CROSS_COMPANY_REFERENCE",
    readOnly: true,
  }));
  const unclassified = adjustments.filter(
    (adj) => adj.type.toUpperCase() === "ADD" && dec(adj.cost_per_kg).gt(0) && !adj.valuation_basis
  );
  const adjustmentEvidence: AdjustmentEvidenceException[] = unclassified.map((a) => ({
    adjustmentId: a.id,
    date: a.date,
    supplierId: a.supplier_id,
    supplierName: a.supplier_name,
    type: a.type,
    kg: fix(dec(a.kg)),
    recordedCostPerKg: a.cost_per_kg ?? "0",
    currency: a.currency_code ?? "USD",
    basis: a.valuation_basis,
    reference: a.reference,
    notes: a.notes,
    classification:
      (a.currency_code ?? "USD").toUpperCase() === "USD" ? "BASIS_EVIDENCE_REQUIRED" : "FX_AND_BASIS_EVIDENCE_REQUIRED",
  }));
  const nonUsd = adjustmentEvidence.filter((a) => a.classification === "FX_AND_BASIS_EVIDENCE_REQUIRED");
  const rawOverdraw = rawExceptions.reduce((sum, row) => sum.plus(row.excessUsedKg), dec(0));
  const supplierOnlyRows = supplierOnly.reduce((sum, r) => sum + Number(r.source_count), 0);
  const supplierOnlyKg = supplierOnly.reduce((sum, r) => sum.plus(r.total_kg), dec(0));
  return {
    companyId,
    generatedAt: new Date().toISOString(),
    readOnly: true,
    summary: {
      rawStockRows: raw.length,
      rawStockOverdrawRows: rawExceptions.length,
      totalRawRowOverdrawKg: fix(rawOverdraw),
      supplierOverdrawReviewCount: balances.filter((v) => v.coverage === "POTENTIALLY_ADJUSTMENT_BACKED").length,
      unbackedShortageSupplierCount: balances.filter((v) => v.coverage === "UNBACKED_SHORTAGE").length,
      ownershipSourceExceptions: ownerExceptions.length,
      ownershipAffectedBatches: new Set(ownerExceptions.map((row) => row.batchId)).size,
      unclassifiedValuedAdds: adjustmentEvidence.length,
      unclassifiedNonUsdAdds: nonUsd.length,
      supplierOnlySourceRows: supplierOnlyRows,
      supplierOnlySourceWeightKg: fix(supplierOnlyKg),
    },
    supplierBalances: balances,
    rawStockExceptions: rawExceptions,
    ownershipExceptions: ownerExceptions,
    adjustmentEvidence,
    recommendations: [
      "Do not overwrite historical supplier pricing, source totals, USD/FX rates or completed batch quantities.",
      "Inspect the originating supplier transfer documents before changing inventory_supplier_id: current container ownership is not historical proof.",
      "For raw-stock overdraw, reconcile supplier ADD history and event dates. Exact aggregate coverage does not prove per-container attribution.",
      "Classify valued ADD adjustments through the existing audited Historical Replay valuation-basis route only when dated evidence supports the category; non-USD valued transfers require verified FX.",
      "No blanket repair, fake receipt, automatically created journal voucher or negative inventory clamp is authorized.",
    ],
  };
}

export async function getPhase4MixProvenanceReport(companyId: number): Promise<Phase4SourceProvenanceReport> {
  if (!Number.isSafeInteger(companyId) || companyId <= 0) throw new Error("Invalid Factory company");
  const client = await pool.connect();
  let begun = false;
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    begun = true;
    await client.query("SELECT set_config('app.current_company_id', $1, true)", [String(companyId)]);
    const raw = (
      await client.query<RawRow>(
        "SELECT rs.id AS raw_stock_id, rs.container_id, c.container_number, rs.company_id, " +
          "c.supplier_id, CASE WHEN sp.company_id=$1 THEN sp.name ELSE NULL END AS supplier_name, " +
          "rs.received_kg::text, rs.used_kg::text, rs.cost_per_kg_usd::text, rs.offloaded_at::text " +
          "FROM factory_raw_stock rs JOIN factory_containers c ON c.id=rs.container_id AND c.company_id=$1 " +
          "LEFT JOIN factory_suppliers sp ON sp.id=c.supplier_id AND sp.company_id=$1 " +
          "WHERE rs.company_id=$1 AND rs.deleted_at IS NULL AND c.deleted_at IS NULL ORDER BY rs.id",
        [companyId]
      )
    ).rows;
    const ownership = (
      await client.query<OwnershipRow>(
        "SELECT m.id AS batch_id,m.batch_code,m.status AS batch_status,s.id AS source_id,s.source_type," +
          "s.supplier_id AS source_supplier_id,s.inventory_supplier_id," +
          "c.supplier_id AS container_supplier_id,s.container_id," +
          "CASE WHEN c.company_id=$1 THEN c.container_number ELSE NULL END AS container_number," +
          "c.company_id AS container_company_id,s.weight_kg::text AS source_weight_kg," +
          "s.cost_per_kg::text AS source_rate_usd,s.total_cost::text AS source_total_usd " +
          "FROM factory_mix_batch_sources s JOIN factory_mix_batches m ON m.id=s.mix_batch_id " +
          "LEFT JOIN factory_containers c ON c.id=s.container_id " +
          "WHERE m.company_id=$1 AND m.deleted_at IS NULL AND s.container_id IS NOT NULL " +
          "AND (s.inventory_supplier_id IS DISTINCT FROM c.supplier_id OR s.supplier_id IS DISTINCT FROM c.supplier_id) " +
          "ORDER BY m.batch_code,s.id",
        [companyId]
      )
    ).rows;
    const adjustments = (
      await client.query<AdjustmentRow>(
        "SELECT a.id,a.supplier_id,CASE WHEN sp.company_id=$1 THEN sp.name ELSE NULL END AS supplier_name," +
          "a.date::text,a.type,a.kg::text,a.cost_per_kg::text,a.currency_code,a.valuation_basis,a.reference,a.notes " +
          "FROM factory_raw_material_adjustments a " +
          "LEFT JOIN factory_suppliers sp ON sp.id=a.supplier_id AND sp.company_id=$1 " +
          "WHERE a.company_id=$1 AND a.deleted_at IS NULL ORDER BY a.id",
        [companyId]
      )
    ).rows;
    const supplierOnly = (
      await client.query<SupplierOnlyRow>(
        "SELECT s.supplier_id,COUNT(*)::int AS source_count, COALESCE(SUM(s.weight_kg),0)::text AS total_kg " +
          "FROM factory_mix_batch_sources s JOIN factory_mix_batches m ON m.id=s.mix_batch_id AND m.company_id=$1 " +
          "WHERE m.deleted_at IS NULL AND s.supplier_id IS NOT NULL " +
          "AND s.container_id IS NULL AND s.source_batch_id IS NULL GROUP BY s.supplier_id",
        [companyId]
      )
    ).rows;
    if (raw.length > 50000 || ownership.length > 250000 || adjustments.length > 50000) {
      throw new Error("Phase 4 report exceeds safe snapshot bounds");
    }
    const report = buildPhase4ProvenanceReport(companyId, raw, ownership, adjustments, supplierOnly);
    await client.query("COMMIT");
    begun = false;
    return report;
  } catch (error) {
    if (begun) await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
