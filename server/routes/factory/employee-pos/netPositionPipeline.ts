// Extracted from ./employeeNetPositionRoutes.ts: inventory valuation and the uninvoiced order pipeline for the Factory Net Position.
import { loadHistoricalFactoryPipeline } from "../../../services/factory/netPositionHistoricalPipeline";
import { db } from "../../../db";
import { customerOrders, customers } from "@shared/schema";
import { eq, and, desc, inArray, lte } from "drizzle-orm";
import { computeNetPositionInventory } from "./netPositionInventory";
import { toMoney } from "../../../lib/money";
import type { Request } from "express";
import type { computeNetPositionSupplierBalances } from "./netPositionSupplierBalances";
import type { loadNetPositionConfigFx } from "./netPositionLedgerBalances";
import type { FactoryNetPositionAsOf } from "@shared/factoryNetPositionAsOf";

type ComputeNetPositionSupplierBalancesResult = Awaited<ReturnType<typeof computeNetPositionSupplierBalances>>;
type LoadNetPositionConfigFxResult = Awaited<ReturnType<typeof loadNetPositionConfigFx>>;

export async function loadFactoryNetPositionPipeline({
  req,
  companyId,
  asOf,
  getConfigFx,
  configFxRates,
  supplierLockedRateMapNp,
  allContainersF,
  asOfContext,
  round2,
}: {
  req: Request;
  companyId: number;
  asOf: string;
  getConfigFx: LoadNetPositionConfigFxResult["getConfigFx"];
  configFxRates: LoadNetPositionConfigFxResult["configFxRates"];
  supplierLockedRateMapNp: ComputeNetPositionSupplierBalancesResult["supplierLockedRateMapNp"];
  allContainersF: ComputeNetPositionSupplierBalancesResult["allContainersF"];
  asOfContext: FactoryNetPositionAsOf;
  round2: (n: number) => number;
}) {
  // Inventory valuations - finished stock, raw material, stock on the
  // water and material in process - are computed in ./netPositionInventory.
  // Only Stock In Hand switches valuation mode; Balance on Table stays on
  // its original all-time blended raw-material cost basis.
  const valuationMode: "selling" | "cost" = req.query.valuationMode === "selling" ? "selling" : "cost";
  const {
    inventorySellValue: computedInventorySellValue,
    inventorySellingValue,
    rawMaterialStockValue: computedRawMaterialStockValue,
    stockOtwValue: computedStockOtwValue,
    balanceOnTableValue: computedBalanceOnTableValue,
  } = await computeNetPositionInventory({
    companyId,
    asOf,
    getConfigFx,
    configFxRates,
    supplierLockedRateMapNp,
    allContainersF,
  });

  // Only the historical report reconstructs OTW and scan/verification
  // lifecycle from dated events. The live/current Net Position keeps its
  // existing accepted behavior; no source orders or containers are edited.
  const historicalPipeline = asOfContext.isHistorical
    ? await loadHistoricalFactoryPipeline(companyId, asOfContext, getConfigFx)
    : null;
  const stockOtwValue = historicalPipeline?.stockOtwValue ?? computedStockOtwValue;

  // From the cut-over the ledger's factory stock accounts replace the computed
  // values (the selling-price view keeps its bale value, in place of the
  // ledger's finished goods at cost).
  const inventorySellValue = computedInventorySellValue;
  const rawMaterialStockValue = computedRawMaterialStockValue;
  const balanceOnTableValue = computedBalanceOnTableValue;

  // ── 4. Pending, Verified & Loading orders (upcoming receivables) ──────────
  // Verified and Loading orders are included in the dashboard's "What We Have"
  // at their current order values, even though they have not been invoiced.
  // Pending Verification stays informational. These are dashboard pipeline
  // values only: do not create or change ledger receivables here.
  //
  // Allocated bales are excluded from Stock In Hand by
  // computeNetPositionInventory, including bales still marked IN_STOCK,
  // so an order's allocated stock is not also valued as available inventory.
  const pendingVerifiedRows = historicalPipeline
    ? []
    : await db
        .select({
          id: customerOrders.id,
          status: customerOrders.status,
          orderDate: customerOrders.orderDate,
          grandTotal: customerOrders.grandTotal,
          totalQtyBales: customerOrders.totalQtyBales,
          customerId: customerOrders.customerId,
          customerName: customers.legalName,
        })
        .from(customerOrders)
        .innerJoin(customers, eq(customerOrders.customerId, customers.id))
        .where(
          and(
            eq(customerOrders.companyId, companyId),
            inArray(customerOrders.status, ["PENDING_VERIFICATION", "VERIFIED", "LOADING"]),
            lte(customerOrders.orderDate, asOf)
          )
        )
        .orderBy(desc(customerOrders.orderDate));

  const mapOrder = (r: (typeof pendingVerifiedRows)[number]) => ({
    id: r.id,
    customerName: r.customerName || `Customer #${r.customerId}`,
    orderDate: r.orderDate,
    grandTotal: round2(toMoney(r.grandTotal).toNumber()),
    totalQtyBales: r.totalQtyBales ?? 0,
  });

  const pendingOrders =
    historicalPipeline?.pendingOrders ??
    pendingVerifiedRows.filter((r) => r.status === "PENDING_VERIFICATION").map(mapOrder);
  const verifiedOrders =
    historicalPipeline?.verifiedOrders ?? pendingVerifiedRows.filter((r) => r.status === "VERIFIED").map(mapOrder);
  const loadingOrders =
    historicalPipeline?.loadingOrders ?? pendingVerifiedRows.filter((r) => r.status === "LOADING").map(mapOrder);

  const pendingTotal = historicalPipeline?.pendingTotal ?? round2(pendingOrders.reduce((s, o) => s + o.grandTotal, 0));
  const verifiedTotal =
    historicalPipeline?.verifiedTotal ?? round2(verifiedOrders.reduce((s, o) => s + o.grandTotal, 0));
  const loadingTotal = historicalPipeline?.loadingTotal ?? round2(loadingOrders.reduce((s, o) => s + o.grandTotal, 0));

  return {
    valuationMode,
    inventorySellingValue,
    historicalPipeline,
    stockOtwValue,
    inventorySellValue,
    rawMaterialStockValue,
    balanceOnTableValue,
    pendingOrders,
    verifiedOrders,
    loadingOrders,
    pendingTotal,
    verifiedTotal,
    loadingTotal,
  };
}
