// Extracted from ./supplierStatementRoutes.ts to keep that module under the source-size cap.
import { db } from "../../../db";
import { sqlArray } from "../../../lib/sqlArray";
import { resolveStoredFxRate } from "../../../services/factory/currencyConversion";
import { sumMoney, toMoney } from "../../../lib/money";
import type Decimal from "decimal.js";
import { factoryContainers, factoryFxAllocations, factorySupplierFxTransfers, factorySuppliers } from "@shared/schema";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { buildLinkedSupplierGroups } from "./linkedSupplierGroups";
import { computeSettlementCurrencyGroups } from "./balance/settlementPools";
import {
  ZERO,
  decimalMax,
  formatLedgerAmount,
  handleGetFactorySuppliersIdStatementStep1,
} from "./handleGetFactorySuppliersIdStatementStep1";

export async function handleGetFactorySuppliersIdStatementStep2({
  allSupplierCharges,
  commissions,
  companyId,
  containers,
  obRawStockWithCommission,
  payments,
  statement,
  supplier,
  supplierId,
  voucherPaymentRows,
}: Pick<
  Extract<Awaited<ReturnType<typeof handleGetFactorySuppliersIdStatementStep1>>, { done: false }>,
  | "allSupplierCharges"
  | "commissions"
  | "companyId"
  | "containers"
  | "obRawStockWithCommission"
  | "payments"
  | "statement"
  | "supplier"
  | "supplierId"
  | "voucherPaymentRows"
>) {
  // Fetch FX transfers involving this supplier (as source or destination)
  const fxTransfers = await db
    .select()
    .from(factorySupplierFxTransfers)
    .where(
      and(
        eq(factorySupplierFxTransfers.companyId, companyId),
        sql`(${factorySupplierFxTransfers.fromSupplierId} = ${supplierId} OR ${factorySupplierFxTransfers.toSupplierId} = ${supplierId})`
      )
    )
    .orderBy(desc(factorySupplierFxTransfers.date));

  // Phase 3: Enrich FX transfers with counterparty supplier names for bilateral visibility
  const fxSupplierIds = [...new Set(fxTransfers.flatMap((t) => [t.fromSupplierId, t.toSupplierId]).filter(Boolean))];
  const fxSupplierNames: Record<number, string> = {};
  if (fxSupplierIds.length > 0) {
    const fxSups = await db
      .select({ id: factorySuppliers.id, name: factorySuppliers.name })
      .from(factorySuppliers)
      .where(inArray(factorySuppliers.id, fxSupplierIds));
    for (const s of fxSups) fxSupplierNames[s.id] = s.name;
  }
  // Enrich incoming FX transfers with the container numbers they cover (cross-reference)
  const incomingFxIds = fxTransfers.filter((t) => t.toSupplierId === supplierId).map((t) => t.id);
  const fxContainerRefsMap: Record<number, Array<{ containerNumber: string; allocatedAmount: string }>> = {};
  if (incomingFxIds.length > 0) {
    const fxAllocs = await db
      .select({
        fxTransferId: factoryFxAllocations.fxTransferId,
        containerId: factoryFxAllocations.containerId,
        allocatedAmount: factoryFxAllocations.allocatedAmount,
        containerNumber: factoryContainers.containerNumber,
      })
      .from(factoryFxAllocations)
      .innerJoin(factoryContainers, eq(factoryFxAllocations.containerId, factoryContainers.id))
      .where(inArray(factoryFxAllocations.fxTransferId, incomingFxIds));
    for (const a of fxAllocs) {
      if (!fxContainerRefsMap[a.fxTransferId]) fxContainerRefsMap[a.fxTransferId] = [];
      fxContainerRefsMap[a.fxTransferId].push({
        containerNumber: a.containerNumber,
        allocatedAmount: String(a.allocatedAmount),
      });
    }
  }

  const enrichedFxTransfers = fxTransfers.map((t) => ({
    ...t,
    fromSupplierName: fxSupplierNames[t.fromSupplierId] || "",
    toSupplierName: fxSupplierNames[t.toSupplierId] || "",
    containerRefs: fxContainerRefsMap[t.id] || [],
  }));

  const currencyGroups = computeSettlementCurrencyGroups({
    supplierId,
    openingBalance: supplier.openingBalance,
    isLinkedSupplier: !!supplier.parentId,
    statement,
    charges: allSupplierCharges,
    payments,
    voucherPayments: voucherPaymentRows,
    fxTransfers: enrichedFxTransfers,
  });

  // Compute the combined USD-equivalent net payable across all currency groups.
  // Correctly accounts for FX transfers (already deducted in paidByCurrency) and
  // converts non-USD remaining balances to USD using the containers' fxRateToUsd.
  const totalNetPayableUsd = currencyGroups.reduce((sum, cg) => {
    const netPay = toMoney(cg.netPayable);
    if (netPay.lte(0)) return sum;
    if (cg.currencyCode === "USD") return sum.plus(netPay);
    // Weighted-average fxRateToUsd across this currency's containers whose rate actually
    // looks resolved (confirmed non-USD rate, or legacy heuristic where no flag exists yet).
    // The statement rows do not carry fxRateConfirmed, so this has always
    // fallen back to the legacy heuristic inside resolveStoredFxRate.
    const resolvedRates = cg.containers
      .map((c) => ({ value: toMoney(c.value), ...resolveStoredFxRate(cg.currencyCode, c.fxRateToUsd, undefined) }))
      .filter((c) => c.looksSet);
    const totalRawVal = sumMoney(resolvedRates.map((c) => c.value));
    if (totalRawVal.lte(0)) return sum; // no resolved-rate containers → exclude rather than guess
    const weightedRate = resolvedRates
      .reduce((total, c) => total.plus(c.value.times(c.fxRate)), ZERO)
      .dividedBy(totalRawVal);
    return sum.plus(netPay.times(weightedRate));
  }, ZERO);

  // Build OB commissions list
  const containerMap: Record<number, Pick<(typeof containers)[number], "id" | "containerNumber" | "createdAt">> = {};
  for (const c of containers) containerMap[c.id] = c;

  // Offload charges may reference containers belonging to child suppliers (broker receives a charge
  // on a child's container). Fetch any missing containers so we can show the real container number.
  const missingContainerIds = [
    ...new Set(allSupplierCharges.map((oc) => oc.containerId).filter((id: number) => !containerMap[id])),
  ];
  if (missingContainerIds.length > 0) {
    const extraContainers = await db
      .select({
        id: factoryContainers.id,
        containerNumber: factoryContainers.containerNumber,
        createdAt: factoryContainers.createdAt,
      })
      .from(factoryContainers)
      .where(
        and(
          eq(factoryContainers.companyId, companyId),
          sql`${factoryContainers.id} = ANY(${sqlArray(missingContainerIds)})`
        )
      );
    for (const c of extraContainers) containerMap[c.id] = c;
  }

  // Fetch commission supplier names for the statement
  const commSupplierIds = obRawStockWithCommission
    .map((r) => r.commissionSupplierId)
    .filter((id): id is number => id != null);
  const commSupplierMap: Record<number, string> = {};
  if (commSupplierIds.length > 0) {
    const commSuppliers = await db
      .select({ id: factorySuppliers.id, name: factorySuppliers.name })
      .from(factorySuppliers)
      .where(sql`${factorySuppliers.id} = ANY(${sqlArray(commSupplierIds)})`);
    for (const s of commSuppliers) commSupplierMap[s.id] = s.name;
  }
  const obCommissions = obRawStockWithCommission
    .filter((r) => toMoney(r.commissionAmount).gt(0))
    .map((r) => ({
      rawStockId: r.id,
      containerId: r.containerId,
      containerNumber: containerMap[r.containerId]?.containerNumber || "",
      date: containerMap[r.containerId]?.createdAt || r.createdAt,
      personName: r.commissionSupplierId
        ? commSupplierMap[r.commissionSupplierId] || r.commissionPersonName || ""
        : r.commissionPersonName || "",
      commissionSupplierId: r.commissionSupplierId || null,
      amount: r.commissionAmount,
      currencyCode: r.commissionCurrencyCode || "USD",
      fxRateToUsd: (() => {
        const ccy = r.commissionCurrencyCode || "USD";
        const { fxRate, looksSet } = resolveStoredFxRate(ccy, r.commissionFxRateToUsd);
        return looksSet ? String(fxRate) : "unresolved";
      })(),
      amountUsd: r.commissionAmountUsd || r.commissionAmount,
    }));
  const totalObCommissions = sumMoney(obCommissions.map((c) => c.amountUsd));

  // Phase 2: Broker statement - per-linked-supplier rollups, built in
  // ./linkedSupplierGroups.
  const linkedSupplierGroups = await buildLinkedSupplierGroups(supplierId, companyId, commissions);

  // ── Phase 1: Fetch per-container FX allocations ──────────────────────────
  const containerIds = containers.map((c) => c.id);
  const allocationsByContainer: Record<number, Decimal> = {};
  if (containerIds.length > 0) {
    const allocs = await db
      .select({
        containerId: factoryFxAllocations.containerId,
        allocatedAmount: factoryFxAllocations.allocatedAmount,
      })
      .from(factoryFxAllocations)
      .where(
        and(eq(factoryFxAllocations.companyId, companyId), inArray(factoryFxAllocations.containerId, containerIds))
      );
    for (const a of allocs) {
      allocationsByContainer[a.containerId] = (allocationsByContainer[a.containerId] ?? ZERO).plus(
        toMoney(a.allocatedAmount)
      );
    }
  }
  // Enrich each statement row with allocatedAmount + remainingAmount
  const enrichedStatement = statement.map((s) => {
    const netVal = toMoney(s.value).minus(toMoney(s.totalCommission));
    const allocAmt = allocationsByContainer[s.id] ?? ZERO;
    return {
      ...s,
      allocatedAmount: allocAmt.toFixed(2),
      remainingAmount: decimalMax(ZERO, netVal.minus(allocAmt)).toFixed(2),
    };
  });
  // ── Phase 5: Build pre-sorted unified ledger ─────────────────────────────
  const fmtAmt = formatLedgerAmount;
  return {
    containerMap,
    currencyGroups,
    enrichedFxTransfers,
    enrichedStatement,
    fmtAmt,
    linkedSupplierGroups,
    obCommissions,
    totalNetPayableUsd,
    totalObCommissions,
  };
}
