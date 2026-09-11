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
import { eq, and, sql, isNull, ne, inArray } from "drizzle-orm";
import { db } from "../../db";
import {
  factorySuppliers,
  factoryRawStock,
  factoryContainers,
  factoryMixBatchSources,
  factoryMixBatches,
  factoryOffloadAdditionalCharges,
  factoryContainerCommissions,
  factoryContainerOtherCharges,
  factorySupplierPayments,
  factorySupplierFxTransfers,
  voucherEntries,
  vouchers,
} from "@shared/schema";
import { getLockedRateDiagnosticsForCompany, type LockedRateDiagnosticRow } from "./rawStockLockedRate";
import { resolveStoredFxRate } from "./currencyConversion";
import { resolveParentCompanyId } from "../../routes/helpers/supplierBalanceHelpers";

export interface KgSummary {
  receivedKg: number;
  usedKg: number;
  reservedKg: number;
  freeKg: number;
  negativeStockCount: number;
  negativeStockRows: Array<{ rawStockId: number; containerId: number; containerNumber: string | null; freeKg: number }>;
}

export interface SupplierCurrencyExposureRow {
  supplierId: number;
  supplierName: string;
  byCurrency: Record<string, { resolvedNative: number; unresolvedNative: number; unresolvedCount: number }>;
}

export interface UnresolvedFxRow {
  supplierId: number;
  supplierName: string;
  currencyCode: string;
  source: "container" | "offload_charge" | "commission" | "container_other_charge" | "voucher_payment";
  rowId: number;
  nativeAmount: number;
}

/**
 * A supplier's true net balance by currency — NOT the same thing as gross
 * exposure. grossExposureByCurrency is everything ever owed to the supplier
 * (opening balance + container liabilities + freight/charges/commissions),
 * before any payment is netted off; it must never be presented to a user as
 * "the balance". paymentsByCurrency nets off supplier payments, voucher
 * payments, and FX transfers/settlements. netBalanceByCurrency is the actual
 * per-currency amount still owed (gross − payments, computed from native
 * amounts, so it never depends on FX resolution). netBalanceUsd converts each
 * currency's net balance using that row's OWN resolved FX rate and excludes
 * any amount whose FX could not be resolved (see unresolvedFxRows on the
 * parent report) rather than guessing at a rate.
 */
export interface SupplierBalanceByCurrencyRow {
  supplierId: number;
  supplierName: string;
  grossExposureByCurrency: Record<string, number>;
  paymentsByCurrency: Record<string, number>;
  netBalanceByCurrency: Record<string, number>;
  netBalanceUsd: number;
  hasUnresolvedFx: boolean;
}

export interface CrossCompanyContaminationRow {
  table: "factory_containers" | "factory_raw_stock" | "factory_mix_batch_sources";
  rowId: number;
  rowCompanyId: number;
  referencedEntity: string;
  referencedCompanyId: number;
  detail: string;
}

export interface DoubleReservedRow {
  containerId: number;
  containerNumber: string | null;
  remainingKg: number;
  reservedKg: number;
  overCommittedKg: number;
}

export interface RawMaterialReconciliation {
  companyId: number;
  scannedAt: string;
  kgSummary: KgSummary;
  lockedRateDiagnostics: LockedRateDiagnosticRow[];
  lockedRateDriftCount: number;
  supplierCurrencyExposure: SupplierCurrencyExposureRow[];
  supplierBalanceByCurrency: SupplierBalanceByCurrencyRow[];
  unresolvedFxRows: UnresolvedFxRow[];
  crossCompanyContamination: CrossCompanyContaminationRow[];
  doubleReservedDeductions: DoubleReservedRow[];
  negativeStockCount: number;
}

const EPS = 0.01;

export async function getRawMaterialReconciliation(companyId: number): Promise<RawMaterialReconciliation> {
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
    const rec = parseFloat(r.receivedKg as string) || 0;
    const used = parseFloat(r.usedKg as string) || 0;
    receivedKg += rec;
    usedKg += used;
    const free = rec - used;
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
    reservedKg: parseFloat(reservedKgTotal || "0") || 0,
    // Model A (matches rawStockReceiptRoutes.ts / rawStockDiagnosticRoutes.ts): usedKg
    // already reflects mix-batch consumption, so freeKg is received-used, NOT that
    // minus reservedKg a second time — reservedKg is informational exposure only.
    freeKg: receivedKg - usedKg,
    negativeStockCount: negativeStockRows.length,
    negativeStockRows,
  };

  // ── 2. Stored vs expected locked cost/kg and free-stock value ────────────
  const lockedRateDiagnostics = await getLockedRateDiagnosticsForCompany(companyId);
  const lockedRateDriftCount = lockedRateDiagnostics.filter((r) => Math.abs(parseFloat(r.difference)) > EPS).length;

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
    if (resolved) row.byCurrency[currencyCode].resolvedNative += nativeAmount;
    else {
      row.byCurrency[currencyCode].unresolvedNative += nativeAmount;
      row.byCurrency[currencyCode].unresolvedCount += 1;
    }
  }

  const nonUsdContainers = await db
    .select()
    .from(factoryContainers)
    .where(and(eq(factoryContainers.companyId, companyId), ne(factoryContainers.currencyCode, "USD")));
  for (const c of nonUsdContainers) {
    const { looksSet } = resolveStoredFxRate(c.currencyCode, c.fxRateToUsd, c.fxRateConfirmed);
    const amt = (parseFloat(c.ratePerKg || "0") || 0) * (parseFloat(c.actualReceivedKg || c.totalKg || "0") || 0);
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
    bumpExposure(supplierId, oc.currencyCode!, parseFloat(oc.amount || "0") || 0, looksSet);
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
    bumpExposure(container?.supplierId ?? null, cm.currencyCode, parseFloat(cm.commissionTotal || "0") || 0, looksSet);
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
    acc.grossNative.set(cc, (acc.grossNative.get(cc) || 0) + nativeAmount);
    if (usdAmount !== null) acc.usdGrossResolved += usdAmount;
    else acc.hasUnresolvedFx = true;
  }
  function addPayment(supplierId: number | null, cc: string, nativeAmount: number, usdAmount: number | null) {
    if (!supplierId || !nativeAmount) return;
    const acc = getBalanceAcc(supplierId);
    acc.paymentsNative.set(cc, (acc.paymentsNative.get(cc) || 0) + nativeAmount);
    if (usdAmount !== null) acc.usdPayments += usdAmount;
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
      const ob = parseFloat((s as { openingBalance?: string | null }).openingBalance || "0") || 0;
      if (ob !== 0) addGross(s.id, "USD", ob, ob);
    }
  }

  // Container liabilities (kg × ratePerKg, native currency) + freight (native
  // freight currency) — only payable-status containers, matching the broker
  // statement's own definition of what is actually owed to a supplier.
  const PAYABLE_CONTAINER_STATUSES = new Set(["OFFLOADED", "RECEIVED", "PARTIALLY_RECEIVED"]);
  for (const c of allContainersById.values()) {
    if (!c.supplierId) continue;
    if (c.deletedAt) continue;
    if (!PAYABLE_CONTAINER_STATUSES.has(String(c.status || "").toUpperCase())) continue;
    const cc = c.currencyCode || "USD";
    const kg = parseFloat(c.actualReceivedKg || c.totalKg || "0") || 0;
    const rate = parseFloat(c.ratePerKg || "0") || 0;
    const amt = kg * rate;
    if (amt) {
      const { fxRate, looksSet } = resolveStoredFxRate(cc, c.fxRateToUsd, c.fxRateConfirmed);
      addGross(c.supplierId, cc, amt, cc === "USD" ? amt : looksSet ? amt * fxRate : null);
      if (cc !== "USD" && !looksSet) {
        unresolvedFxRows.push({
          supplierId: c.supplierId,
          supplierName: supplierNameById.get(c.supplierId) || "Unknown Supplier",
          currencyCode: cc,
          source: "container",
          rowId: c.id,
          nativeAmount: amt,
        });
      }
    }

    const freight = parseFloat(c.freight || "0") || 0;
    if (freight) {
      const freightCc = c.freightCurrencyCode || cc;
      const { fxRate, looksSet } = resolveStoredFxRate(freightCc, c.fxRateToUsd, c.fxRateConfirmed);
      addGross(c.supplierId, freightCc, freight, freightCc === "USD" ? freight : looksSet ? freight * fxRate : null);
      if (freightCc !== "USD" && !looksSet) {
        unresolvedFxRows.push({
          supplierId: c.supplierId,
          supplierName: supplierNameById.get(c.supplierId) || "Unknown Supplier",
          currencyCode: freightCc,
          source: "container",
          rowId: c.id,
          nativeAmount: freight,
        });
      }
    }
  }

  // Offload additional charges assigned directly to a supplier.
  const allOffloadCharges = await db
    .select()
    .from(factoryOffloadAdditionalCharges)
    .where(eq(factoryOffloadAdditionalCharges.companyId, companyId));
  for (const oc of allOffloadCharges) {
    const supplierId = oc.supplierId ?? allContainersById.get(oc.containerId)?.supplierId ?? null;
    if (!supplierId) continue;
    const cc = oc.currencyCode || "USD";
    const amt = parseFloat(oc.amount || "0") || 0;
    if (!amt) continue;
    const { fxRate, looksSet } = resolveStoredFxRate(cc, oc.fxRateToUsd, oc.fxRateConfirmed);
    addGross(supplierId, cc, amt, cc === "USD" ? amt : looksSet ? amt * fxRate : null);
    if (cc !== "USD" && !looksSet) {
      unresolvedFxRows.push({
        supplierId,
        supplierName: supplierNameById.get(supplierId) || "Unknown Supplier",
        currencyCode: cc,
        source: "offload_charge",
        rowId: oc.id,
        nativeAmount: amt,
      });
    }
  }

  // Container-level other-charges table (multi-row) and the legacy single
  // other-charges column, both scoped to whichever supplier they're assigned to.
  const allContainerOtherCharges = await db
    .select()
    .from(factoryContainerOtherCharges)
    .where(eq(factoryContainerOtherCharges.companyId, companyId));
  for (const oc of allContainerOtherCharges) {
    const container = allContainersById.get(oc.containerId);
    const supplierId = container?.supplierId ?? null;
    if (!supplierId) continue;
    const cc = oc.currencyCode || container?.currencyCode || "USD";
    const amt = parseFloat(oc.amount || "0") || 0;
    if (!amt) continue;
    // This table has no FX fields of its own — reuse the container's, since the
    // charge's currency defaults to the container's currency when unset.
    const { fxRate, looksSet } = resolveStoredFxRate(cc, container?.fxRateToUsd, container?.fxRateConfirmed);
    addGross(supplierId, cc, amt, cc === "USD" ? amt : looksSet ? amt * fxRate : null);
    if (cc !== "USD" && !looksSet) {
      unresolvedFxRows.push({
        supplierId,
        supplierName: supplierNameById.get(supplierId) || "Unknown Supplier",
        currencyCode: cc,
        source: "container_other_charge",
        rowId: oc.id,
        nativeAmount: amt,
      });
    }
  }
  for (const c of allContainersById.values()) {
    const chargeSupplierId = c.otherChargesSupplierId;
    if (!chargeSupplierId) continue;
    const amt = parseFloat(c.otherCharges || "0") || 0;
    if (!amt) continue;
    const cc = c.otherChargesCurrencyCode || "USD";
    const { fxRate, looksSet } = resolveStoredFxRate(cc, c.fxRateToUsd, c.fxRateConfirmed);
    addGross(chargeSupplierId, cc, amt, cc === "USD" ? amt : looksSet ? amt * fxRate : null);
    if (cc !== "USD" && !looksSet) {
      unresolvedFxRows.push({
        supplierId: chargeSupplierId,
        supplierName: supplierNameById.get(chargeSupplierId) || "Unknown Supplier",
        currencyCode: cc,
        source: "container_other_charge",
        rowId: c.id,
        nativeAmount: amt,
      });
    }
  }

  // Commissions — same supplier-recipient rule as the container loop above:
  // owed to whichever supplier is the actual commission recipient.
  const allCommissions = await db
    .select()
    .from(factoryContainerCommissions)
    .where(eq(factoryContainerCommissions.companyId, companyId));
  for (const cm of allCommissions) {
    const container = allContainersById.get(cm.containerId);
    // NOTE — behaviour preserved verbatim: factoryContainerCommissions has no
    // commissionSupplierId column, so this read resolves to undefined and the
    // recipient is always the container's supplier. Reading the container's
    // commissionSupplierId instead would move commission balances and needs
    // its own reviewed change.
    const recipientId =
      (cm as { commissionSupplierId?: number | null }).commissionSupplierId ?? container?.supplierId ?? null;
    if (!recipientId) continue;
    const cc = cm.currencyCode || "USD";
    const amt = parseFloat(cm.commissionTotal || "0") || 0;
    if (!amt) continue;
    const { fxRate, looksSet } = resolveStoredFxRate(cc, cm.fxRateToUsd, cm.fxRateConfirmed);
    addGross(recipientId, cc, amt, cc === "USD" ? amt : looksSet ? amt * fxRate : null);
    if (cc !== "USD" && !looksSet) {
      unresolvedFxRows.push({
        supplierId: recipientId,
        supplierName: supplierNameById.get(recipientId) || "Unknown Supplier",
        currencyCode: cc,
        source: "commission",
        rowId: cm.id,
        nativeAmount: amt,
      });
    }
  }

  // Supplier payments — amountUsd is already stored at write time, so USD is
  // always resolved here regardless of the payment's native currency.
  const allSupplierPayments = await db
    .select()
    .from(factorySupplierPayments)
    .where(eq(factorySupplierPayments.companyId, companyId));
  for (const p of allSupplierPayments) {
    const cc = p.currencyCode || "USD";
    const amt = parseFloat(p.amount || "0") || 0;
    const amtUsd = parseFloat(p.amountUsd || "0") || 0;
    addPayment(p.supplierId, cc, amt, amtUsd);
  }

  // Voucher-linked supplier payments (general accounting), skipping optional
  // (informational-only) vouchers. Uses the voucher's stored exchangeRate; a
  // non-USD voucher with no exchangeRate is flagged unresolved rather than
  // assumed to be 1.
  const supplierIds = suppliers.map((s) => s.id);
  const allVoucherPayments =
    supplierIds.length > 0
      ? await db
          .select({
            id: voucherEntries.id,
            debitAmount: voucherEntries.debitAmount,
            supplierId: voucherEntries.factorySupplierId,
            currency: vouchers.currency,
            exchangeRate: vouchers.exchangeRate,
            optional: vouchers.optional,
            voucherNumber: vouchers.voucherNumber,
          })
          .from(voucherEntries)
          .innerJoin(vouchers, eq(voucherEntries.voucherId, vouchers.id))
          .where(
            and(
              inArray(voucherEntries.factorySupplierId, supplierIds),
              sql`${voucherEntries.debitAmount}::numeric > 0`,
              sql`${vouchers.voucherNumber} NOT LIKE 'FACTORY-PAY-%'`
            )
          )
      : [];
  for (const p of allVoucherPayments) {
    if (p.optional || !p.supplierId) continue;
    const cc = p.currency || "USD";
    const amt = parseFloat(p.debitAmount || "0") || 0;
    if (!amt) continue;
    const rate =
      p.exchangeRate !== null && p.exchangeRate !== undefined ? parseFloat(p.exchangeRate) : cc === "USD" ? 1 : null;
    const resolved = cc === "USD" ? true : rate !== null && rate > 0;
    addPayment(p.supplierId, cc, amt, resolved ? amt * (rate ?? 1) : null);
    if (!resolved) {
      unresolvedFxRows.push({
        supplierId: p.supplierId,
        supplierName: supplierNameById.get(p.supplierId) || "Unknown Supplier",
        currencyCode: cc,
        source: "voucher_payment",
        rowId: p.id,
        nativeAmount: amt,
      });
    }
  }

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
    const fromAmt = parseFloat(t.fromAmount || "0") || 0;
    const toAmountUsd = parseFloat(t.toAmountUsd || "0") || 0;
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
        netBalanceByCurrency[cc] = gross - paid;
      }
      return {
        supplierId,
        supplierName: supplierNameById.get(supplierId) || "Unknown Supplier",
        grossExposureByCurrency,
        paymentsByCurrency,
        netBalanceByCurrency,
        netBalanceUsd: acc.usdGrossResolved - acc.usdPayments,
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
    const rec = parseFloat(r.receivedKg as string) || 0;
    const used = parseFloat(r.usedKg as string) || 0;
    receivedByContainer.set(r.containerId, (receivedByContainer.get(r.containerId) || 0) + rec);
    usedByContainer.set(r.containerId, (usedByContainer.get(r.containerId) || 0) + used);
    remainingByContainer.set(r.containerId, (remainingByContainer.get(r.containerId) || 0) + (rec - used));
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
    const reserved = parseFloat(r.reservedKg as string) || 0;
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
    kgSummary,
    lockedRateDiagnostics,
    lockedRateDriftCount,
    supplierCurrencyExposure: Array.from(exposureBySupplier.values()),
    supplierBalanceByCurrency,
    unresolvedFxRows,
    crossCompanyContamination: scopedContamination,
    doubleReservedDeductions,
    negativeStockCount: negativeStockRows.length,
  };
}

export interface DoubleReservedCheckResult {
  expectedFreeKg: number;
  discrepancyKg: number;
  provenDoubleSubtraction: boolean;
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
