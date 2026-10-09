import { db } from "../../db";
import { logger } from "../../lib/logger";
import { AUTO_FILL_REF_TABLE } from "../../services/factory/daybookSourceIntegrity";
import {
  factoryDaybookEntries,
  ledgerAccounts,
  customerOrderBales,
  customerOrderLines,
  customerOrderCharges,
  customerOrders,
  customerProformaLines,
  factoryUserProfiles,
  factoryContainers,
  factoryRawStock,
  factoryMixBatchSources,
  factoryMixBatches,
  factoryContainerCommissions,
  factoryOffloadAdditionalCharges,
} from "@shared/schema";
import { eq, and } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { createHash, timingSafeEqual } from "node:crypto";
import { resolveStoredFxRate, UnresolvedExchangeRateError } from "../../services/factory/currencyConversion";
import type { DbTransaction, DatabaseOrTransaction } from "../../db";
import type Decimal from "decimal.js";
import { daybookAmountUsd, MoneyDecimal, sumMoney, toMoney } from "../../lib/money";
import { systemAccountDefinition } from "../../services/accounting/systemAccounts";
import { syncFactoryInvoiceTx } from "../../services/accounting/perpetualInventory/factoryInvoice";
import { withFactoryValuationEventTx } from "../../services/factory/factoryStockValueEvents";
import { resolveMixSourcePricingBasis } from "../../services/factory/mixSourcePricingBasis";
import { findFactoryFxRateOnOrBefore } from "../../services/factory/factoryFxRateOnDate";
import { resolveFactoryFxRateToUsd } from "../../services/factory/factoryFxRateReadOnly";

export async function writeDaybookEntry(
  dbOrTx: typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0],
  opts: {
    companyId: number;
    txDate: string;
    txType: string;
    referenceId?: number;
    referenceTable?: string;
    description: string;
    metaJson?: string;
    currencyCode?: string;
    amountCurrency?: number;
    fxRateToUsd?: number;
    amountUsd?: number;
    createdBy?: string | null;
    effectiveDate?: string | null;
  }
) {
  const currency = opts.currencyCode || "USD";
  const amtCurrency = opts.amountCurrency || 0;
  // This helper backs many non-raw-material daybook entries (payroll, sales, etc.)
  // as well as raw-material cost entries, so an unresolved rate here must not
  // block the write the way it does on the dedicated raw-material cost-recompute
  // paths (rawStockBalanceRoutes/rawStockContainerRoutes/recalculateContainerCosts)
  // — instead flag it loudly so it surfaces in logs/diagnostics rather than
  // silently mispricing.
  //
  // Wave 8.4 continuation: a non-USD entry written without a rate takes the
  // company's confirmed rate dated on or before its date; with none it is
  // stored with rate 0 and amount_usd 0 (unresolved, as resolveStoredFxRate
  // reads it), never at rate 1, which counted the native amount as USD.
  let fxRate = currency === "USD" ? 1 : opts.fxRateToUsd || 0;
  if (currency !== "USD" && !(fxRate > 0) && opts.amountUsd === undefined) {
    const dated = await findFactoryFxRateOnOrBefore(dbOrTx, opts.companyId, currency, opts.txDate);
    if (dated) fxRate = toMoney(dated.rate).toNumber();
  }
  const { looksSet: daybookFxLooksSet } = resolveStoredFxRate(currency, fxRate);
  if (!daybookFxLooksSet && currency !== "USD") {
    logger.warn(
      `[writeDaybookEntry] Unresolved exchange rate for ${currency} on txType=${opts.txType} companyId=${opts.companyId} — amountUsd may be inaccurate`
    );
  }
  const amtUsd =
    currency !== "USD" && !(fxRate > 0) && opts.amountUsd === undefined
      ? "0"
      : daybookAmountUsd(currency, amtCurrency, fxRate, opts.amountUsd);
  const [inserted] = await dbOrTx
    .insert(factoryDaybookEntries)
    .values({
      companyId: opts.companyId,
      txDate: opts.txDate,
      txType: opts.txType,
      referenceId: opts.referenceId ?? null,
      referenceTable:
        opts.referenceTable ?? (opts.referenceId != null ? (AUTO_FILL_REF_TABLE[opts.txType] ?? null) : null),
      description: opts.description,
      metaJson: opts.metaJson || null,
      currencyCode: currency,
      amountCurrency: String(amtCurrency),
      fxRateToUsd: String(fxRate),
      amountUsd: amtUsd,
      createdBy: opts.createdBy || null,
      effectiveDate: opts.effectiveDate || null,
    })
    .returning({ id: factoryDaybookEntries.id });
  return inserted; // { id: number } — callers that ignore the return value continue to work
}

/**
 * The factory rate (USD per unit) for a currency on a date, for posting flows.
 * Precedence (resolveFactoryFxRateToUsd): the latest manual rate dated on or
 * before `dateISO`; the rate recorded (auto) for exactly that date; the
 * external historical rate for that date; when the external source fails, the
 * latest recorded rate dated on or before `dateISO`. A rate dated after the
 * transaction is never used; with none of the above it throws.
 *
 * Wave 17 C (owner decision 1): it never writes. A fetched external rate used
 * to be recorded as an `auto` row by this lookup (and by the GET routes that
 * call it); the posting now carries the rate it used on its own document, and
 * a fetched rate becomes a recorded rate only through the audited Admin/Owner
 * action (POST /api/factory/fx-rates/fetched, saveFetchedFactoryFxRate).
 */
export async function getOrFetchFxRateToUsd(companyId: number, currencyCode: string, dateISO: string): Promise<string> {
  if (currencyCode === "USD") return "1";
  return (await resolveFactoryFxRateToUsd(companyId, currencyCode, dateISO)).rate;
}

export async function getOrCreateLedgerAccount(
  companyId: number,
  code: string,
  name: string,
  accountType?: string
): Promise<number> {
  const safeCode = code.slice(0, 50);
  // A registry account is created with its registry type; anything else defaults
  // to "Expense". The old default, "EXPENSE", is a type no report recognises, and
  // it made FACTORY_CHARGES_PAYABLE (a payable) an expense.
  const resolvedType = systemAccountDefinition(safeCode)?.accountType ?? accountType ?? "Expense";
  const [existing] = await db
    .select({ id: ledgerAccounts.id, deletedAt: ledgerAccounts.deletedAt })
    .from(ledgerAccounts)
    .where(and(eq(ledgerAccounts.companyId, companyId), eq(ledgerAccounts.code, safeCode)))
    .limit(1);
  if (existing) {
    // A system account the posting needs is restored rather than posted to
    // while deleted: the ledger integrity guard refuses lines on deleted
    // accounts, and reports hide them.
    if (existing.deletedAt) {
      await db.update(ledgerAccounts).set({ deletedAt: null, active: true }).where(eq(ledgerAccounts.id, existing.id));
    }
    return existing.id;
  }
  const [created] = await db
    .insert(ledgerAccounts)
    .values({
      companyId,
      code: safeCode,
      name,
      accountType: resolvedType,
      active: true,
      isHidden: false,
    })
    .returning({ id: ledgerAccounts.id });
  return created.id;
}

export function isLegacySHA256Hash(hash: string): boolean {
  return /^[a-f0-9]{64}$/i.test(hash);
}

export async function verifySupervisorPassword(password: string, hash: string): Promise<boolean> {
  if (isLegacySHA256Hash(hash)) {
    const actual = createHash("sha256").update(password, "utf8").digest();
    const expected = Buffer.from(hash, "hex");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }
  return bcrypt.compare(password, hash);
}

export async function recalculateOrderTotals(dbConn: DatabaseOrTransaction, orderId: number) {
  const bales = await dbConn.select().from(customerOrderBales).where(eq(customerOrderBales.orderId, orderId));

  // Fetch proforma pricing mode and per-kg rate for this order (if proforma-linked)
  const [order] = await dbConn
    .select({ proformaIdUsed: customerOrders.proformaIdUsed })
    .from(customerOrders)
    .where(eq(customerOrders.id, orderId));
  const proformaPricing = new Map<string, { pricingMode: string; pricePerKg: string | null }>();
  if (order?.proformaIdUsed) {
    const pLines = await dbConn
      .select({
        articleCode: customerProformaLines.articleCode,
        pricingMode: customerProformaLines.pricingMode,
        pricePerKg: customerProformaLines.pricePerKg,
      })
      .from(customerProformaLines)
      .where(eq(customerProformaLines.proformaId, order.proformaIdUsed));
    for (const pl of pLines) {
      if (pl.articleCode) {
        proformaPricing.set(pl.articleCode.toLowerCase(), {
          pricingMode: pl.pricingMode ?? "per_bale",
          pricePerKg: pl.pricePerKg ?? null,
        });
      }
    }
  }

  await dbConn.delete(customerOrderLines).where(eq(customerOrderLines.orderId, orderId));

  const grouped: Record<
    string,
    { articleCode: string; baleName: string; qty: number; totalWeight: Decimal; totalPrice: Decimal }
  > = {};
  for (const b of bales) {
    const key = b.articleCode || "UNKNOWN";
    if (!grouped[key]) {
      grouped[key] = {
        articleCode: key,
        baleName: b.baleName || key,
        qty: 0,
        totalWeight: new MoneyDecimal(0),
        totalPrice: new MoneyDecimal(0),
      };
    }
    grouped[key].qty += 1;
    grouped[key].totalWeight = grouped[key].totalWeight.plus(toMoney(b.weight));
    grouped[key].totalPrice = grouped[key].totalPrice.plus(toMoney(b.priceUsed));
  }

  // For per_kg lines: totalPrice = totalWeight × pricePerKg (authoritative).
  // For per_bale lines: totalPrice = sum of priceUsed on bales.
  const lineTotalPriceOf = (line: (typeof grouped)[string]) => {
    const pricing = proformaPricing.get(line.articleCode.toLowerCase());
    const pkgRate = toMoney(pricing?.pricePerKg);
    return (pricing?.pricingMode ?? "per_bale") === "per_kg" &&
      pkgRate.greaterThan(0) &&
      line.totalWeight.greaterThan(0)
      ? line.totalWeight.times(pkgRate)
      : line.totalPrice;
  };

  // Amounts are written at their columns' scales (weights 3, money 2), rounded
  // half away from zero as Postgres rounds them.
  for (const line of Object.values(grouped)) {
    const pricing = proformaPricing.get(line.articleCode.toLowerCase());
    const pricingMode = pricing?.pricingMode ?? "per_bale";
    const pricePerKg = pricing?.pricePerKg ?? null;
    const lineTotalPrice = lineTotalPriceOf(line);
    const pricePerBaleEffective = line.qty > 0 ? lineTotalPrice.dividedBy(line.qty) : new MoneyDecimal(0);
    await dbConn.insert(customerOrderLines).values({
      orderId,
      articleCode: line.articleCode,
      baleName: line.baleName,
      qty: line.qty,
      weightPerBale: (line.qty > 0 ? line.totalWeight.dividedBy(line.qty) : new MoneyDecimal(0)).toFixed(3),
      totalWeight: line.totalWeight.toFixed(3),
      pricePerBale: pricePerBaleEffective.toFixed(2),
      totalPrice: lineTotalPrice.toFixed(2),
      pricingMode,
      pricePerKg: pricePerKg ?? null,
    });
  }

  const charges = await dbConn.select().from(customerOrderCharges).where(eq(customerOrderCharges.orderId, orderId));
  const freightAmount = sumMoney(charges.filter((c) => c.chargeType === "FREIGHT").map((c) => c.amount));
  const otherChargesTotal = sumMoney(charges.filter((c) => c.chargeType === "OTHER").map((c) => c.amount));

  // For per_kg articles: always use proformaRate × totalWeight as the authoritative price.
  // This matches the totalPrice stored in the order lines above and the verify-page display.
  const subtotalBales = sumMoney(Object.values(grouped).map(lineTotalPriceOf));

  const grandTotal = subtotalBales.plus(freightAmount).plus(otherChargesTotal);

  await dbConn
    .update(customerOrders)
    .set({
      subtotalBales: subtotalBales.toFixed(2),
      freightAmount: freightAmount.toFixed(2),
      otherChargesTotal: otherChargesTotal.toFixed(2),
      grandTotal: grandTotal.toFixed(2),
      totalQtyBales: bales.length,
      updatedAt: new Date(),
    })
    .where(eq(customerOrders.id, orderId));

  // Perpetual inventory (wave 8.4): a finalized order's invoice journal follows its new totals.
  const [owner] = await dbConn
    .select({ companyId: customerOrders.companyId, status: customerOrders.status })
    .from(customerOrders)
    .where(eq(customerOrders.id, orderId));
  if (owner?.status === "FINALIZED") {
    const sync = (tx: DbTransaction) => syncFactoryInvoiceTx(tx, owner.companyId, orderId);
    await ("rollback" in dbConn ? sync(dbConn as DbTransaction) : db.transaction(sync));
  }
}

/**
 * Recomputes all cost fields for an offloaded container and cascades the new
 * inclusive cost/kg down to rawStock → mixBatchSources → mixBatches.
 *
 * Call this inside a db.transaction() after mutating any single cost component
 * (freight, duty, commission, otherCharges, ratePerKg, or an additional charge).
 *
 * Wave 11: mix sources and batches are held in USD. A source priced from this
 * container alone (CONTAINER_DIRECT) takes the container's USD cost per kg; a
 * source priced at its supplier's locked rate keeps it. The change this makes
 * to the factory valuation is recorded as a REVALUATION event for the daily
 * factory stock journal.
 *
 * Returns the new { totalCost, inclusiveCostPerKg, costPerKgUsd, rawStockId }.
 */
export async function recalculateContainerCosts(
  tx: DbTransaction,
  companyId: number,
  containerId: number
): Promise<{ totalCost: number; inclusiveCostPerKg: number; costPerKgUsd: number; rawStockId: number | null }> {
  return withFactoryValuationEventTx(
    tx,
    companyId,
    "REVALUATION",
    { sourceType: "factory-container-cost-recalculation", sourceId: containerId },
    () => recalculateContainerCostsInner(tx, companyId, containerId)
  );
}

async function recalculateContainerCostsInner(
  tx: DbTransaction,
  companyId: number,
  containerId: number
): Promise<{ totalCost: number; inclusiveCostPerKg: number; costPerKgUsd: number; rawStockId: number | null }> {
  const [container] = await tx
    .select()
    .from(factoryContainers)
    .where(and(eq(factoryContainers.id, containerId), eq(factoryContainers.companyId, companyId)));
  if (!container) throw new Error(`Container ${containerId} not found`);

  const actualKg = toMoney(container.actualReceivedKg);
  if (actualKg.lessThanOrEqualTo(0)) throw new Error("Container has no received weight");

  const containerCcy = container.currencyCode || "USD";
  const { fxRate, looksSet: containerFxLooksSet } = resolveStoredFxRate(containerCcy, container.fxRateToUsd);
  if (!containerFxLooksSet) {
    throw new UnresolvedExchangeRateError(containerCcy);
  }
  const containerFx = toMoney(fxRate);
  // An amount in `ccy`, its USD value (`usd`) given, expressed in the container currency.
  const inContainerCcy = (amount: Decimal, ccy: string, usd: Decimal) =>
    ccy === containerCcy ? amount : containerFx.greaterThan(0) ? usd.dividedBy(containerFx) : amount;

  // Base material cost
  const basePayable = actualKg.times(toMoney(container.ratePerKg));

  // Freight — may be in a different currency; normalise to container currency
  const freightVal = toMoney(container.freight);
  const freightCcy = container.freightCurrencyCode || containerCcy;
  // `container.freightFxRate` is not a column on factory_containers (the stored
  // freight rate is `freightFxRateToUsd`), so this branch has always been
  // undefined; kept as-is so the computed freight is unchanged.
  const freightFx = toMoney(container.fxRateToUsdOffload || String(fxRate));
  const freightUsd = freightCcy === "USD" ? freightVal : freightVal.times(freightFx);
  const freightInCcy = inContainerCcy(freightVal, freightCcy, freightUsd);

  // Other charges (bulk field)
  const ocVal = toMoney(container.otherCharges);
  const ocCcy = container.otherChargesCurrencyCode || containerCcy;
  // factory_containers has no other-charges FX column, so this has always
  // resolved to the container rate.
  const ocUsd = ocCcy === "USD" ? ocVal : ocVal.times(containerFx);
  const ocInCcy = inContainerCcy(ocVal, ocCcy, ocUsd);

  // Commission
  const [commission] = await tx
    .select()
    .from(factoryContainerCommissions)
    .where(eq(factoryContainerCommissions.containerId, containerId));
  const commVal = commission ? toMoney(commission.commissionTotal) : toMoney(container.commissionAmount);
  const commCcy = commission ? commission.currencyCode || "USD" : containerCcy;
  let commFx = fxRate;
  if (commission && commCcy !== "USD") {
    if (commCcy === containerCcy) {
      commFx = fxRate; // same currency as container — reuse the already-validated container rate
    } else {
      const { fxRate: resolvedCommFx, looksSet: commFxLooksSet } = resolveStoredFxRate(
        commCcy,
        commission.fxRateToUsd,
        commission.fxRateConfirmed
      );
      if (!commFxLooksSet) throw new UnresolvedExchangeRateError(commCcy);
      commFx = resolvedCommFx;
    }
  }
  const commUsdAmt = commCcy === "USD" ? commVal : commVal.times(toMoney(commFx));
  const commInCcy = inContainerCcy(commVal, commCcy, commUsdAmt);

  // Duty (only included when CONFIRMED)
  const dutyVal = container.dutyStatus === "CONFIRMED" ? toMoney(container.dutyAmount) : new MoneyDecimal(0);

  // Additional offload charges
  const additionalCharges = await tx
    .select()
    .from(factoryOffloadAdditionalCharges)
    .where(
      and(
        eq(factoryOffloadAdditionalCharges.containerId, containerId),
        eq(factoryOffloadAdditionalCharges.companyId, companyId)
      )
    );
  const additionalTotal = sumMoney(
    additionalCharges.map((c) => {
      const amt = toMoney(c.amount);
      const ccy = c.currencyCode || containerCcy;
      const amtUsd = ccy === "USD" ? amt : amt.times(toMoney(c.fxRateToUsd || String(fxRate)));
      // Unlike the charges above, a zero container rate leaves the USD amount.
      return ccy === containerCcy ? amt : containerFx.greaterThan(0) ? amtUsd.dividedBy(containerFx) : amtUsd;
    })
  );

  const totalCostExact = sumMoney([basePayable, freightInCcy, ocInCcy, commInCcy, dutyVal, additionalTotal]);
  const costPerKgExact = totalCostExact.dividedBy(actualKg);
  const costPerKgUsdExact = containerCcy === "USD" ? costPerKgExact : costPerKgExact.times(containerFx);
  const finalPayableAmountUsd = actualKg.times(costPerKgUsdExact);
  const totalCost = totalCostExact.toNumber();
  const inclusiveCostPerKg = costPerKgExact.toNumber();
  const costPerKgUsd = costPerKgUsdExact.toNumber();

  // Values are written at their columns' scales, rounded half away from zero
  // as Postgres rounds them.
  // 1. Update container summary fields
  await tx
    .update(factoryContainers)
    .set({
      finalPayableAmount: totalCostExact.toFixed(4),
      ratePerKgUsd: costPerKgUsdExact.toFixed(6),
      finalPayableAmountUsd: finalPayableAmountUsd.toFixed(4),
      updatedAt: new Date(),
    })
    .where(eq(factoryContainers.id, containerId));

  // 2. Update rawStock
  const [rawStockRow] = await tx
    .select()
    .from(factoryRawStock)
    .where(and(eq(factoryRawStock.companyId, companyId), eq(factoryRawStock.containerId, containerId)));

  let rawStockId: number | null = null;
  if (rawStockRow) {
    rawStockId = rawStockRow.id;
    await tx
      .update(factoryRawStock)
      .set({ costPerKg: costPerKgExact.toFixed(7), costPerKgUsd: costPerKgUsdExact.toFixed(7) })
      .where(eq(factoryRawStock.id, rawStockRow.id));
  }

  // 3. Update mix batch sources from this container
  const mixSources = await tx
    .select()
    .from(factoryMixBatchSources)
    .where(eq(factoryMixBatchSources.containerId, containerId));

  if (mixSources.length > 0) {
    for (const src of mixSources) {
      // Only a source priced from this container alone follows its cost; a
      // supplier-priced source keeps the supplier's locked rate (USD).
      if (resolveMixSourcePricingBasis(src) !== "CONTAINER_DIRECT") continue;
      const newSrcCost = toMoney(src.weightKg).times(costPerKgUsdExact);
      await tx
        .update(factoryMixBatchSources)
        .set({ costPerKg: costPerKgUsdExact.toFixed(7), totalCost: newSrcCost.toFixed(7) })
        .where(eq(factoryMixBatchSources.id, src.id));
    }

    // 4. Recalculate weighted-average costPerKg on affected mix batches
    const affectedBatchIds = Array.from(
      new Set<number>(mixSources.map((s: (typeof mixSources)[number]) => s.mixBatchId))
    );
    for (const batchId of affectedBatchIds) {
      const allSrc = await tx
        .select()
        .from(factoryMixBatchSources)
        .where(eq(factoryMixBatchSources.mixBatchId, batchId));
      const batchTotalCost = sumMoney(allSrc.map((r) => r.totalCost));
      const batchTotalWeight = sumMoney(allSrc.map((r) => r.weightKg));
      const batchCostPerKg = batchTotalWeight.greaterThan(0)
        ? batchTotalCost.dividedBy(batchTotalWeight)
        : new MoneyDecimal(0);
      await tx
        .update(factoryMixBatches)
        .set({
          costPerKg: batchCostPerKg.toFixed(7),
          totalCost: batchTotalCost.toFixed(7),
          updatedAt: new Date(),
        })
        .where(eq(factoryMixBatches.id, batchId));
    }
  }

  return { totalCost, inclusiveCostPerKg, costPerKgUsd, rawStockId };
}

/**
 * Inline helper for destructive POST handlers that need admin access.
 * Returns true if the request is allowed; returns false and sends 403 if not.
 * Use in POST handlers that aren't covered by the global PUT/PATCH/DELETE guard:
 *   if (!checkFactoryAdmin(req, res)) return;
 */
export function checkFactoryAdmin(req: import("express").Request, res: import("express").Response): boolean {
  const role = req.session?.currentRole as string | undefined;
  if (["Admin", "Developer"].includes(role || "")) return true;
  const overrideUntil = req.session?.factoryAdminOverrideUntil;
  if (overrideUntil && Date.now() < overrideUntil) return true;
  res.status(403).json({
    message: "Admin authorization required for this action.",
    requiresAdminOverride: true,
  });
  return false;
}

/**
 * Returns true if the logged-in user has "hideAllCosts" enabled.
 * Admins and owners always return false (they always see costs).
 */
export async function getUserHideAllCosts(req: import("express").Request): Promise<boolean> {
  try {
    const userId = req.session?.userId;
    if (!userId) return false;
    const role = req.session?.currentRole?.toLowerCase?.();
    if (role === "admin" || role === "owner" || role === "developer") return false;
    const [profile] = await db
      .select({ hideAllCosts: factoryUserProfiles.hideAllCosts })
      .from(factoryUserProfiles)
      .where(eq(factoryUserProfiles.userId, userId))
      .limit(1);
    return profile?.hideAllCosts ?? false;
  } catch {
    return false;
  }
}
