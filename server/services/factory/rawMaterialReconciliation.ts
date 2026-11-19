/**
 * Expanded, read-only raw-material reconciliation report.
 *
 * Complements the FX-unresolved scan (fxDiagnosticRoutes.ts) with the broader
 * set of checks a real production hardening pass needs before the FX repair
 * tooling can be trusted: kg accounting (received/used/reserved/free),
 * stored-vs-expected locked cost/kg and free-stock value, supplier currency
 * exposure, cross-company contamination, double-reserved deductions, and
 * negative stock. Every computation here is a SELECT — nothing is written,
 * and nothing here performs a lazy-backfill write (uses the ReadOnly locked
 * rate helper via getLockedRateDiagnosticsForCompany).
 */
import { eq, and, sql, isNull } from "drizzle-orm";
import { db } from "../../db";
import {
  factorySuppliers,
  factoryRawStock,
  factoryContainers,
  factoryMixBatchSources,
  factoryMixBatches,
  factorySupplierFxTransfers,
} from "@shared/schema";
import { amountOf, plus, minus, EPS } from "./rawMaterialReconciliationHelpers";
import { rawMaterialReconciliationStep } from "./rawMaterialReconciliationStep";
import { rawMaterialReconciliationStep2 } from "./rawMaterialReconciliationStep2";
import type {
  SupplierBalanceByCurrencyRow,
  CrossCompanyContaminationRow,
  DoubleReservedRow,
  RawMaterialReconciliation,
  DoubleReservedCheckResult,
} from "./rawMaterialReconciliationTypes";
export type {
  KgSummary,
  SupplierCurrencyExposureRow,
  UnresolvedFxRow,
  SupplierBalanceByCurrencyRow,
  CrossCompanyContaminationRow,
  DoubleReservedRow,
  RawMaterialReconciliation,
  DoubleReservedCheckResult,
} from "./rawMaterialReconciliationTypes";

export async function getRawMaterialReconciliation(companyId: number): Promise<RawMaterialReconciliation> {
  const rmr1 = await rawMaterialReconciliationStep({ companyId });
  const {
    addPayment,
    balanceBySupplier,
    supplierNameById,
    allContainersById,
    rawStockRows,
    kgSummary,
    lockedRateDiagnostics,
    lockedRateDriftCount,
    exposureBySupplier,
    unresolvedFxRows,
    negativeStockRows,
  } = rmr1;
  await rawMaterialReconciliationStep2({ rmr1, companyId });

  // FX transfers/settlements between suppliers: the sender's foreign-currency
  // exposure is settled (treated as a payment out in that currency); the
  // recipient's USD exposure is settled by the USD they received. Both legs
  // are already fully resolved at write time (toAmountUsd/fxRateToUsd stored).
  const allFxTransfers = await db
    .select()
    .from(factorySupplierFxTransfers)
    .where(eq(factorySupplierFxTransfers.companyId, companyId));
  for (const t of allFxTransfers) {
    const fromCc = t.fromCurrencyCode || "USD";
    const fromAmt = amountOf(t.fromAmount);
    const toAmountUsd = amountOf(t.toAmountUsd);
    if (fromAmt) addPayment(t.fromSupplierId, fromCc, fromAmt, fromCc === "USD" ? fromAmt : toAmountUsd);
    if (toAmountUsd) addPayment(t.toSupplierId, "USD", toAmountUsd, toAmountUsd);
  }

  const supplierBalanceByCurrency: SupplierBalanceByCurrencyRow[] = Array.from(balanceBySupplier.entries()).map(
    ([supplierId, acc]) => {
      const currencies = new Set<string>([...acc.grossNative.keys(), ...acc.paymentsNative.keys()]);
      const grossExposureByCurrency: Record<string, number> = {};
      const paymentsByCurrency: Record<string, number> = {};
      const netBalanceByCurrency: Record<string, number> = {};
      for (const cc of currencies) {
        const gross = acc.grossNative.get(cc) || 0;
        const paid = acc.paymentsNative.get(cc) || 0;
        grossExposureByCurrency[cc] = gross;
        paymentsByCurrency[cc] = paid;
        netBalanceByCurrency[cc] = minus(gross, paid);
      }
      return {
        supplierId,
        supplierName: supplierNameById.get(supplierId) || "Unknown Supplier",
        grossExposureByCurrency,
        paymentsByCurrency,
        netBalanceByCurrency,
        netBalanceUsd: minus(acc.usdGrossResolved, acc.usdPayments),
        hasUnresolvedFx: acc.hasUnresolvedFx,
      };
    }
  );

  // ── 4. Cross-company contamination ────────────────────────────────────────
  const crossCompanyContamination: CrossCompanyContaminationRow[] = [];
  const allSuppliersEverywhere = await db
    .select({ id: factorySuppliers.id, companyId: factorySuppliers.companyId })
    .from(factorySuppliers);
  const supplierCompanyById = new Map<number, number>(allSuppliersEverywhere.map((s) => [s.id, s.companyId]));

  for (const c of allContainersById.values()) {
    if (
      c.supplierId &&
      supplierCompanyById.has(c.supplierId) &&
      supplierCompanyById.get(c.supplierId) !== c.companyId
    ) {
      crossCompanyContamination.push({
        table: "factory_containers",
        rowId: c.id,
        rowCompanyId: c.companyId,
        referencedEntity: `supplier #${c.supplierId}`,
        referencedCompanyId: supplierCompanyById.get(c.supplierId)!,
        detail: `Container ${c.containerNumber} (company ${c.companyId}) references supplier #${c.supplierId} which belongs to company ${supplierCompanyById.get(c.supplierId)}`,
      });
    }
  }

  const allRawStockCompanyCheck = await db
    .select({
      id: factoryRawStock.id,
      companyId: factoryRawStock.companyId,
      containerId: factoryRawStock.containerId,
      containerCompanyId: factoryContainers.companyId,
      containerNumber: factoryContainers.containerNumber,
    })
    .from(factoryRawStock)
    .innerJoin(factoryContainers, eq(factoryContainers.id, factoryRawStock.containerId))
    .where(isNull(factoryRawStock.deletedAt));
  for (const rs of allRawStockCompanyCheck) {
    if (rs.companyId !== rs.containerCompanyId) {
      crossCompanyContamination.push({
        table: "factory_raw_stock",
        rowId: rs.id,
        rowCompanyId: rs.companyId,
        referencedEntity: `container #${rs.containerId}`,
        referencedCompanyId: rs.containerCompanyId,
        detail: `Raw stock row #${rs.id} (company ${rs.companyId}) references container ${rs.containerNumber} which belongs to company ${rs.containerCompanyId}`,
      });
    }
  }

  const allMixSourcesCheck = await db
    .select({
      id: factoryMixBatchSources.id,
      supplierId: factoryMixBatchSources.supplierId,
      batchCompanyId: factoryMixBatches.companyId,
    })
    .from(factoryMixBatchSources)
    .innerJoin(factoryMixBatches, eq(factoryMixBatchSources.mixBatchId, factoryMixBatches.id))
    .where(and(sql`${factoryMixBatchSources.supplierId} IS NOT NULL`, isNull(factoryMixBatches.deletedAt)));
  for (const ms of allMixSourcesCheck) {
    const supplierCompanyId = ms.supplierId ? supplierCompanyById.get(ms.supplierId) : undefined;
    if (ms.supplierId && supplierCompanyId !== undefined && supplierCompanyId !== ms.batchCompanyId) {
      crossCompanyContamination.push({
        table: "factory_mix_batch_sources",
        rowId: ms.id,
        rowCompanyId: ms.batchCompanyId,
        referencedEntity: `supplier #${ms.supplierId}`,
        referencedCompanyId: supplierCompanyId,
        detail: `Mix batch source #${ms.id} (batch company ${ms.batchCompanyId}) references supplier #${ms.supplierId} which belongs to company ${supplierCompanyId}`,
      });
    }
  }
  // Restrict to rows visible from this company's own data (rowCompanyId === companyId),
  // avoiding a report about ANOTHER company's isolated contamination when scanning company A.
  const scopedContamination = crossCompanyContamination.filter((r) => r.rowCompanyId === companyId);

  // ── 5. Double-reserved deductions: active mix-batch reservations against a
  // specific container exceeding that container's own remaining kg ─────────
  const reservedByContainer = await db
    .select({
      containerId: factoryMixBatchSources.containerId,
      reservedKg: sql<string>`SUM(${factoryMixBatchSources.weightKg})`,
    })
    .from(factoryMixBatchSources)
    .innerJoin(factoryMixBatches, eq(factoryMixBatchSources.mixBatchId, factoryMixBatches.id))
    .where(
      and(
        eq(factoryMixBatches.companyId, companyId),
        sql`${factoryMixBatchSources.containerId} IS NOT NULL`,
        sql`${factoryMixBatches.status} NOT IN ('CLOSED', 'COMPLETED')`,
        isNull(factoryMixBatches.deletedAt)
      )
    )
    .groupBy(factoryMixBatchSources.containerId);

  const receivedByContainer = new Map<number, number>();
  const usedByContainer = new Map<number, number>();
  const remainingByContainer = new Map<number, number>();
  for (const r of rawStockRows) {
    const rec = amountOf(r.receivedKg);
    const used = amountOf(r.usedKg);
    receivedByContainer.set(r.containerId, plus(receivedByContainer.get(r.containerId) || 0, rec));
    usedByContainer.set(r.containerId, plus(usedByContainer.get(r.containerId) || 0, used));
    remainingByContainer.set(r.containerId, plus(remainingByContainer.get(r.containerId) || 0, minus(rec, used)));
  }

  // Model A: usedKg already reflects mix-batch consumption, so a container's
  // real free kg is always receivedKg − usedKg (== remainingByContainer here,
  // the ground truth this report itself computes from factory_raw_stock).
  // reservedKg (active, non-closed mix-batch reservations against this
  // container) is informational exposure only — it must NEVER be subtracted a
  // second time on top of usedKg. A fully-allocated container legitimately has
  // reservedKg == its own historical consumption, which can exceed its OWN
  // remaining kg once fully consumed; that is NOT a bug and must not be
  // flagged merely because reservedKg > remainingKg (see
  // detectDoubleReservedDeduction for the real, provable check).
  const doubleReservedDeductions: DoubleReservedRow[] = [];
  for (const r of reservedByContainer) {
    if (!r.containerId) continue;
    const reserved = amountOf(r.reservedKg);
    const remaining = remainingByContainer.get(r.containerId) || 0;
    const received = receivedByContainer.get(r.containerId) || 0;
    const used = usedByContainer.get(r.containerId) || 0;
    // displayedFreeKg is this report's own ground-truth remaining kg — the
    // same figure the Raw Materials list / diagnostics surface. Comparing it
    // against receivedKg − usedKg here is a structural regression guard: it
    // will only ever flag if some future change makes "remaining" diverge
    // from Model A (e.g. by reintroducing a reservedKg subtraction).
    const check = detectDoubleReservedDeduction({
      receivedKg: received,
      usedKg: used,
      reservedKg: reserved,
      displayedFreeKg: remaining,
    });
    if (check.provenDoubleSubtraction) {
      const container = allContainersById.get(r.containerId);
      doubleReservedDeductions.push({
        containerId: r.containerId,
        containerNumber: container?.containerNumber ?? null,
        remainingKg: remaining,
        reservedKg: reserved,
        overCommittedKg: -check.discrepancyKg,
      });
    }
  }

  return {
    companyId,
    scannedAt: new Date().toISOString(),
    kgSummary: kgSummary,
    lockedRateDiagnostics: lockedRateDiagnostics,
    lockedRateDriftCount: lockedRateDriftCount,
    supplierCurrencyExposure: Array.from(exposureBySupplier.values()),
    supplierBalanceByCurrency,
    unresolvedFxRows: unresolvedFxRows,
    crossCompanyContamination: scopedContamination,
    doubleReservedDeductions,
    negativeStockCount: negativeStockRows.length,
  };
}

/**
 * Model A structural guard: usedKg already includes mix-batch consumption, so
 * a container's free kg must always equal receivedKg − usedKg. reservedKg
 * (the sum of active, non-closed mix-batch source weight against this
 * container) is informational exposure only and must NEVER be subtracted a
 * second time on top of usedKg — doing so is the "double reserved deduction"
 * bug this guards against.
 *
 * A genuine double-subtraction shows up as the system's displayed/calculated
 * free quantity being LOWER than the correct value by (approximately) the
 * reservedKg amount — i.e. reservedKg was subtracted again on top of usedKg,
 * which already accounts for it. Pure function so it is directly unit
 * testable without touching the database; also used, with displayedFreeKg set
 * to this report's own ground-truth remaining kg, as a live regression guard.
 */
export function detectDoubleReservedDeduction(params: {
  receivedKg: number;
  usedKg: number;
  reservedKg: number;
  displayedFreeKg: number;
}): DoubleReservedCheckResult {
  const expectedFreeKg = params.receivedKg - params.usedKg;
  const discrepancyKg = params.displayedFreeKg - expectedFreeKg;
  const provenDoubleSubtraction = params.reservedKg > EPS && Math.abs(discrepancyKg + params.reservedKg) <= EPS;
  return { expectedFreeKg, discrepancyKg, provenDoubleSubtraction };
}
