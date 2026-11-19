// Extracted from ./rawMaterialReconciliation.ts: a stage of rawMaterialReconciliation.
import { eq, and, sql, isNull, ne } from "drizzle-orm";
import { db } from "../../db";
import {
  factorySuppliers,
  factoryRawStock,
  factoryContainers,
  factoryMixBatchSources,
  factoryMixBatches,
  factoryOffloadAdditionalCharges,
  factoryContainerCommissions,
} from "@shared/schema";
import { getLockedRateDiagnosticsForCompany } from "./rawStockLockedRate";
import { resolveStoredFxRate } from "./currencyConversion";
import { resolveParentCompanyId } from "../../routes/helpers/supplierBalanceHelpers";
import { toMoney } from "../../lib/money";
import { amountOf, plus, minus, times, EPS } from "./rawMaterialReconciliationHelpers";
import type { KgSummary, SupplierCurrencyExposureRow, UnresolvedFxRow } from "./rawMaterialReconciliation";

export async function rawMaterialReconciliationStep({ companyId }: { companyId: number }) {
  // ── 1. Received / used / reserved / free kg, negative stock ──────────────
  const rawStockRows = await db
    .select({
      id: factoryRawStock.id,
      containerId: factoryRawStock.containerId,
      receivedKg: factoryRawStock.receivedKg,
      usedKg: factoryRawStock.usedKg,
      containerNumber: factoryContainers.containerNumber,
    })
    .from(factoryRawStock)
    .innerJoin(factoryContainers, eq(factoryContainers.id, factoryRawStock.containerId))
    .where(and(eq(factoryRawStock.companyId, companyId), isNull(factoryRawStock.deletedAt)));

  let receivedKg = 0;
  let usedKg = 0;
  const negativeStockRows: KgSummary["negativeStockRows"] = [];
  for (const r of rawStockRows) {
    const rec = amountOf(r.receivedKg);
    const used = amountOf(r.usedKg);
    receivedKg = plus(receivedKg, rec);
    usedKg = plus(usedKg, used);
    const free = minus(rec, used);
    if (free < -EPS) {
      negativeStockRows.push({
        rawStockId: r.id,
        containerId: r.containerId,
        containerNumber: r.containerNumber,
        freeKg: free,
      });
    }
  }

  const [{ reservedKgTotal }] = await db
    .select({
      reservedKgTotal: sql<string>`COALESCE(SUM(${factoryMixBatchSources.weightKg}), 0)`,
    })
    .from(factoryMixBatchSources)
    .innerJoin(factoryMixBatches, eq(factoryMixBatchSources.mixBatchId, factoryMixBatches.id))
    .where(
      and(
        eq(factoryMixBatches.companyId, companyId),
        sql`${factoryMixBatches.status} NOT IN ('CLOSED', 'COMPLETED')`,
        isNull(factoryMixBatches.deletedAt)
      )
    );

  const kgSummary: KgSummary = {
    receivedKg,
    usedKg,
    reservedKg: amountOf(reservedKgTotal),
    // Model A (matches rawStockReceiptRoutes.ts / rawStockDiagnosticRoutes.ts): usedKg
    // already reflects mix-batch consumption, so freeKg is received-used, NOT that
    // minus reservedKg a second time — reservedKg is informational exposure only.
    freeKg: minus(receivedKg, usedKg),
    negativeStockCount: negativeStockRows.length,
    negativeStockRows,
  };

  // ── 2. Stored vs expected locked cost/kg and free-stock value ────────────
  const lockedRateDiagnostics = await getLockedRateDiagnosticsForCompany(companyId);
  const lockedRateDriftCount = lockedRateDiagnostics.filter((r) => toMoney(r.difference).abs().gt(EPS)).length;

  // ── 3. Supplier currency exposure (resolved vs unresolved native amounts) ─
  const suppliers = await db
    .select({ id: factorySuppliers.id, name: factorySuppliers.name })
    .from(factorySuppliers)
    .where(eq(factorySuppliers.companyId, companyId));
  const supplierNameById = new Map<number, string>(suppliers.map((s) => [s.id, s.name]));

  const exposureBySupplier = new Map<number, SupplierCurrencyExposureRow>();
  function bumpExposure(supplierId: number | null, currencyCode: string, nativeAmount: number, resolved: boolean) {
    if (!supplierId) return;
    if (!exposureBySupplier.has(supplierId)) {
      exposureBySupplier.set(supplierId, {
        supplierId,
        supplierName: supplierNameById.get(supplierId) || "Unknown Supplier",
        byCurrency: {},
      });
    }
    const row = exposureBySupplier.get(supplierId)!;
    if (!row.byCurrency[currencyCode]) {
      row.byCurrency[currencyCode] = { resolvedNative: 0, unresolvedNative: 0, unresolvedCount: 0 };
    }
    const bucket = row.byCurrency[currencyCode];
    if (resolved) bucket.resolvedNative = plus(bucket.resolvedNative, nativeAmount);
    else {
      bucket.unresolvedNative = plus(bucket.unresolvedNative, nativeAmount);
      row.byCurrency[currencyCode].unresolvedCount += 1;
    }
  }

  const nonUsdContainers = await db
    .select()
    .from(factoryContainers)
    .where(and(eq(factoryContainers.companyId, companyId), ne(factoryContainers.currencyCode, "USD")));
  for (const c of nonUsdContainers) {
    const { looksSet } = resolveStoredFxRate(c.currencyCode, c.fxRateToUsd, c.fxRateConfirmed);
    const amt = times(amountOf(c.ratePerKg), amountOf(c.actualReceivedKg || c.totalKg));
    bumpExposure(c.supplierId, c.currencyCode, amt, looksSet);
  }

  const allContainersById = new Map(
    (await db.select().from(factoryContainers).where(eq(factoryContainers.companyId, companyId))).map((c) => [c.id, c])
  );

  const nonUsdCharges = await db
    .select()
    .from(factoryOffloadAdditionalCharges)
    .where(
      and(
        eq(factoryOffloadAdditionalCharges.companyId, companyId),
        ne(factoryOffloadAdditionalCharges.currencyCode, "USD")
      )
    );
  for (const oc of nonUsdCharges) {
    const { looksSet } = resolveStoredFxRate(oc.currencyCode, oc.fxRateToUsd, oc.fxRateConfirmed);
    const container = allContainersById.get(oc.containerId);
    const supplierId = oc.supplierId ?? container?.supplierId ?? null;
    // The currency_code <> 'USD' filter above also excludes NULL currencies,
    // so every row here carries a currency code.
    bumpExposure(supplierId, oc.currencyCode!, amountOf(oc.amount), looksSet);
  }

  const nonUsdCommissions = await db
    .select()
    .from(factoryContainerCommissions)
    .where(
      and(eq(factoryContainerCommissions.companyId, companyId), ne(factoryContainerCommissions.currencyCode, "USD"))
    );
  for (const cm of nonUsdCommissions) {
    const { looksSet } = resolveStoredFxRate(cm.currencyCode, cm.fxRateToUsd, cm.fxRateConfirmed);
    const container = allContainersById.get(cm.containerId);
    bumpExposure(container?.supplierId ?? null, cm.currencyCode, amountOf(cm.commissionTotal), looksSet);
  }

  // ── 3b. Supplier balance-by-currency reconciliation ───────────────────────
  // Completes #3 above into an actual net balance (not just gross exposure):
  // opening balance (parent-company context only, USD) + container liabilities
  // + freight/charges/commissions, netted against supplier payments, voucher
  // payments, and FX transfers/settlements. Gross and net are kept as
  // distinctly-named fields — grossExposureByCurrency is never presented as
  // "the balance".
  const unresolvedFxRows: UnresolvedFxRow[] = [];
  const balanceBySupplier = new Map<
    number,
    {
      grossNative: Map<string, number>;
      paymentsNative: Map<string, number>;
      usdGrossResolved: number;
      usdPayments: number;
      hasUnresolvedFx: boolean;
    }
  >();
  function getBalanceAcc(supplierId: number) {
    if (!balanceBySupplier.has(supplierId)) {
      balanceBySupplier.set(supplierId, {
        grossNative: new Map(),
        paymentsNative: new Map(),
        usdGrossResolved: 0,
        usdPayments: 0,
        hasUnresolvedFx: false,
      });
    }
    return balanceBySupplier.get(supplierId)!;
  }
  function addGross(supplierId: number | null, cc: string, nativeAmount: number, usdAmount: number | null) {
    if (!supplierId || !nativeAmount) return;
    const acc = getBalanceAcc(supplierId);
    acc.grossNative.set(cc, plus(acc.grossNative.get(cc) || 0, nativeAmount));
    if (usdAmount !== null) acc.usdGrossResolved = plus(acc.usdGrossResolved, usdAmount);
    else acc.hasUnresolvedFx = true;
  }
  function addPayment(supplierId: number | null, cc: string, nativeAmount: number, usdAmount: number | null) {
    if (!supplierId || !nativeAmount) return;
    const acc = getBalanceAcc(supplierId);
    acc.paymentsNative.set(cc, plus(acc.paymentsNative.get(cc) || 0, nativeAmount));
    if (usdAmount !== null) acc.usdPayments = plus(acc.usdPayments, usdAmount);
    else acc.hasUnresolvedFx = true;
  }

  // Opening balance — USD-only, and only counts in the parent company's own books.
  let parentCompanyId: number | null;
  try {
    parentCompanyId = await resolveParentCompanyId();
  } catch {
    parentCompanyId = null; // ambiguous/unconfigured — skip opening balances rather than guess.
  }
  if (parentCompanyId === companyId) {
    for (const s of suppliers) {
      // NOTE — behaviour preserved verbatim: the supplier projection above
      // selects only id/name, so openingBalance reads as undefined and ob is
      // always 0, meaning this branch adds nothing today. Adding the real
      // column to the projection would change reported balances and needs its
      // own reviewed change.
      const ob = amountOf((s as { openingBalance?: string | null }).openingBalance);
      if (ob !== 0) addGross(s.id, "USD", ob, ob);
    }
  }

  // Container liabilities (kg × ratePerKg, native currency) + freight (native
  // freight currency) — only payable-status containers, matching the broker
  // statement's own definition of what is actually owed to a supplier.
  const PAYABLE_CONTAINER_STATUSES = new Set(["OFFLOADED", "RECEIVED", "PARTIALLY_RECEIVED"]);

  return {
    rawStockRows,
    negativeStockRows,
    kgSummary,
    lockedRateDiagnostics,
    lockedRateDriftCount,
    suppliers,
    supplierNameById,
    exposureBySupplier,
    allContainersById,
    unresolvedFxRows,
    balanceBySupplier,
    addGross,
    addPayment,
    PAYABLE_CONTAINER_STATUSES,
  };
}
