import { db } from "../../db";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { AUTO_FILL_REF_TABLE } from "../../services/factory/daybookSourceIntegrity";
import {
  factoryFxRates,
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
import { eq, and, desc } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { createHash, timingSafeEqual } from "node:crypto";
import {
  resolveStoredFxRate,
  applyFxRate,
  UnresolvedExchangeRateError,
} from "../../services/factory/currencyConversion";
import type { DbTransaction, DatabaseOrTransaction } from "../../db";

function buildValidatedUrl(baseUrl: string, dateISO: string, currencyCode: string): string {
  try {
    const url = new URL(baseUrl);
    const allowedDomains = ["api.frankfurter.app"];
    if (!allowedDomains.includes(url.hostname)) throw new Error("Invalid host");
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("Invalid protocol");
    if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(dateISO)) throw new Error("Invalid parameter");
    if (!/^[A-Z]{3}$/.test(currencyCode)) throw new Error("Invalid parameter");
    url.pathname = `/${dateISO}`;
    url.searchParams.set("from", currencyCode);
    url.searchParams.set("to", "USD");
    return url.href;
  } catch {
    throw new Error("Invalid URL");
  }
}

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
  const { looksSet: daybookFxLooksSet } = resolveStoredFxRate(currency, opts.fxRateToUsd ?? null);
  if (!daybookFxLooksSet && currency !== "USD") {
    logger.warn(
      `[writeDaybookEntry] Unresolved exchange rate for ${currency} on txType=${opts.txType} companyId=${opts.companyId} — amountUsd may be inaccurate`
    );
  }
  const fxRate = opts.fxRateToUsd || 1;
  const amtUsd =
    opts.amountUsd !== undefined ? opts.amountUsd : currency === "USD" ? amtCurrency : amtCurrency * fxRate;
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
      amountUsd: String(amtUsd),
      createdBy: opts.createdBy || null,
      effectiveDate: opts.effectiveDate || null,
    })
    .returning({ id: factoryDaybookEntries.id });
  return inserted; // { id: number } — callers that ignore the return value continue to work
}

export async function getOrFetchFxRateToUsd(companyId: number, currencyCode: string, dateISO: string): Promise<string> {
  if (currencyCode === "USD") return "1";

  // Manual rates always take priority — use the most recent one for this currency.
  const [manualRate] = await db
    .select()
    .from(factoryFxRates)
    .where(
      and(
        eq(factoryFxRates.companyId, companyId),
        eq(factoryFxRates.currencyCode, currencyCode.toUpperCase()),
        eq(factoryFxRates.source, "manual")
      )
    )
    .orderBy(desc(factoryFxRates.effectiveDate))
    .limit(1);

  if (manualRate) return manualRate.rateToUsd;

  // No manual rate — check for an auto-cached row for this exact date.
  const [existing] = await db
    .select()
    .from(factoryFxRates)
    .where(
      and(
        eq(factoryFxRates.companyId, companyId),
        eq(factoryFxRates.currencyCode, currencyCode.toUpperCase()),
        eq(factoryFxRates.effectiveDate, dateISO),
        eq(factoryFxRates.source, "auto")
      )
    )
    .limit(1);

  if (existing) return existing.rateToUsd;

  try {
    const response = await fetch(buildValidatedUrl("https://api.frankfurter.app", dateISO, currencyCode.toUpperCase()));
    if (!response.ok) throw new Error(`FX API returned ${response.status}`);
    const data = await response.json();
    const rate = data?.rates?.USD;
    if (!rate || isNaN(rate)) throw new Error("Invalid rate from FX API");

    const rateStr = String(rate);
    await db.insert(factoryFxRates).values({
      companyId,
      currencyCode: currencyCode.toUpperCase(),
      rateToUsd: rateStr,
      effectiveDate: dateISO,
      source: "auto",
    });

    return rateStr;
  } catch (err: unknown) {
    const [fallback] = await db
      .select()
      .from(factoryFxRates)
      .where(and(eq(factoryFxRates.companyId, companyId), eq(factoryFxRates.currencyCode, currencyCode.toUpperCase())))
      .orderBy(desc(factoryFxRates.effectiveDate))
      .limit(1);

    if (fallback) return fallback.rateToUsd;
    throw new Error(
      `No FX rate available for ${dateISO}/${currencyCode}. External API error: ${getErrorMessage(err)}`,
      { cause: err }
    );
  }
}

export async function getOrCreateLedgerAccount(
  companyId: number,
  code: string,
  name: string,
  accountType: string = "EXPENSE"
): Promise<number> {
  const safeCode = code.slice(0, 50);
  const [existing] = await db
    .select({ id: ledgerAccounts.id })
    .from(ledgerAccounts)
    .where(and(eq(ledgerAccounts.companyId, companyId), eq(ledgerAccounts.code, safeCode)))
    .limit(1);
  if (existing) return existing.id;
  const [created] = await db
    .insert(ledgerAccounts)
    .values({
      companyId,
      code: safeCode,
      name,
      accountType,
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
    { articleCode: string; baleName: string; qty: number; totalWeight: number; totalPrice: number }
  > = {};
  for (const b of bales) {
    const key = b.articleCode || "UNKNOWN";
    if (!grouped[key]) {
      grouped[key] = { articleCode: key, baleName: b.baleName || key, qty: 0, totalWeight: 0, totalPrice: 0 };
    }
    grouped[key].qty += 1;
    grouped[key].totalWeight += parseFloat(b.weight);
    grouped[key].totalPrice += parseFloat(b.priceUsed);
  }

  for (const line of Object.values(grouped)) {
    const pricing = proformaPricing.get(line.articleCode.toLowerCase());
    const pricingMode = pricing?.pricingMode ?? "per_bale";
    const pricePerKg = pricing?.pricePerKg ?? null;
    const pkgRateInsert = pricePerKg ? parseFloat(pricePerKg) : 0;
    // For per_kg lines: totalPrice = totalWeight × pricePerKg (authoritative).
    // For per_bale lines: totalPrice = sum of priceUsed on bales.
    const lineTotalPrice =
      pricingMode === "per_kg" && pkgRateInsert > 0 && line.totalWeight > 0
        ? line.totalWeight * pkgRateInsert
        : line.totalPrice;
    const pricePerBaleEffective = line.qty > 0 ? lineTotalPrice / line.qty : 0;
    await dbConn.insert(customerOrderLines).values({
      orderId,
      articleCode: line.articleCode,
      baleName: line.baleName,
      qty: line.qty,
      weightPerBale: String(line.qty > 0 ? line.totalWeight / line.qty : 0),
      totalWeight: String(line.totalWeight),
      pricePerBale: String(pricePerBaleEffective),
      totalPrice: String(lineTotalPrice),
      pricingMode,
      pricePerKg: pricePerKg ?? null,
    });
  }

  const charges = await dbConn.select().from(customerOrderCharges).where(eq(customerOrderCharges.orderId, orderId));
  const freightAmount = charges
    .filter((c) => c.chargeType === "FREIGHT")
    .reduce((sum: number, c) => sum + parseFloat(c.amount), 0);
  const otherChargesTotal = charges
    .filter((c) => c.chargeType === "OTHER")
    .reduce((sum: number, c) => sum + parseFloat(c.amount), 0);

  // For per_kg articles: always use proformaRate × totalWeight as the authoritative price.
  // This matches the totalPrice stored in the order lines above and the verify-page display.
  let subtotalBales = 0;
  for (const line of Object.values(grouped)) {
    const pricing = proformaPricing.get(line.articleCode.toLowerCase());
    const pricingMode = pricing?.pricingMode ?? "per_bale";
    const pkgRate = pricing?.pricePerKg ? parseFloat(pricing.pricePerKg) : 0;
    if (pricingMode === "per_kg" && pkgRate > 0 && line.totalWeight > 0) {
      subtotalBales += pkgRate * line.totalWeight;
    } else {
      subtotalBales += line.totalPrice;
    }
  }

  const grandTotal = subtotalBales + freightAmount + otherChargesTotal;

  await dbConn
    .update(customerOrders)
    .set({
      subtotalBales: String(subtotalBales),
      freightAmount: String(freightAmount),
      otherChargesTotal: String(otherChargesTotal),
      grandTotal: String(grandTotal),
      totalQtyBales: bales.length,
      updatedAt: new Date(),
    })
    .where(eq(customerOrders.id, orderId));
}

/**
 * Recomputes all cost fields for an offloaded container and cascades the new
 * inclusive cost/kg down to rawStock → mixBatchSources → mixBatches.
 *
 * Call this inside a db.transaction() after mutating any single cost component
 * (freight, duty, commission, otherCharges, ratePerKg, or an additional charge).
 *
 * Returns the new { totalCost, inclusiveCostPerKg, costPerKgUsd, rawStockId }.
 */
export async function recalculateContainerCosts(
  tx: DbTransaction,
  companyId: number,
  containerId: number
): Promise<{ totalCost: number; inclusiveCostPerKg: number; costPerKgUsd: number; rawStockId: number | null }> {
  const [container] = await tx
    .select()
    .from(factoryContainers)
    .where(and(eq(factoryContainers.id, containerId), eq(factoryContainers.companyId, companyId)));
  if (!container) throw new Error(`Container ${containerId} not found`);

  const actualKg = parseFloat(container.actualReceivedKg || "0");
  if (actualKg <= 0) throw new Error("Container has no received weight");

  const containerCcy = container.currencyCode || "USD";
  const { fxRate, looksSet: containerFxLooksSet } = resolveStoredFxRate(containerCcy, container.fxRateToUsd);
  if (!containerFxLooksSet) {
    throw new UnresolvedExchangeRateError(containerCcy);
  }

  // Base material cost
  const baseRate = parseFloat(container.ratePerKg || "0");
  const basePayable = actualKg * baseRate;

  // Freight — may be in a different currency; normalise to container currency
  const freightVal = parseFloat(container.freight || "0");
  const freightCcy = container.freightCurrencyCode || containerCcy;
  // `container.freightFxRate` is not a column on factory_containers (the stored
  // freight rate is `freightFxRateToUsd`), so this branch has always been
  // undefined; kept as-is so the computed freight is unchanged.
  const freightFx = parseFloat(container.fxRateToUsdOffload || String(fxRate));
  const freightUsd = freightCcy === "USD" ? freightVal : freightVal * freightFx;
  const freightInCcy = freightCcy === containerCcy ? freightVal : fxRate > 0 ? freightUsd / fxRate : freightVal;

  // Other charges (bulk field)
  const ocVal = parseFloat(container.otherCharges || "0");
  const ocCcy = container.otherChargesCurrencyCode || containerCcy;
  // factory_containers has no other-charges FX column, so this has always
  // resolved to the container rate.
  const ocFx = fxRate;
  const ocUsd = ocCcy === "USD" ? ocVal : ocVal * ocFx;
  const ocInCcy = ocCcy === containerCcy ? ocVal : fxRate > 0 ? ocUsd / fxRate : ocVal;

  // Commission
  const [commission] = await tx
    .select()
    .from(factoryContainerCommissions)
    .where(eq(factoryContainerCommissions.containerId, containerId));
  const commVal = commission
    ? parseFloat(commission.commissionTotal || "0")
    : parseFloat(container.commissionAmount || "0");
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
  const commUsdAmt = commCcy === "USD" ? commVal : commVal * commFx;
  const commInCcy = commCcy === containerCcy ? commVal : fxRate > 0 ? commUsdAmt / fxRate : commVal;

  // Duty (only included when CONFIRMED)
  const dutyVal = container.dutyStatus === "CONFIRMED" ? parseFloat(container.dutyAmount || "0") : 0;

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
  const additionalTotal = additionalCharges.reduce((sum: number, c) => {
    const amt = parseFloat(c.amount || "0");
    const ccy = c.currencyCode || containerCcy;
    const cfx = parseFloat(c.fxRateToUsd || String(fxRate));
    const amtUsd = ccy === "USD" ? amt : amt * cfx;
    return sum + (ccy === containerCcy ? amt : fxRate > 0 ? amtUsd / fxRate : amtUsd);
  }, 0);

  const totalCost = basePayable + freightInCcy + ocInCcy + commInCcy + dutyVal + additionalTotal;
  const inclusiveCostPerKg = totalCost / actualKg;
  const costPerKgUsd = applyFxRate(inclusiveCostPerKg, containerCcy, fxRate);
  const finalPayableAmountUsd = actualKg * costPerKgUsd;

  // 1. Update container summary fields
  await tx
    .update(factoryContainers)
    .set({
      finalPayableAmount: String(totalCost.toFixed(4)),
      ratePerKgUsd: String(costPerKgUsd.toFixed(6)),
      finalPayableAmountUsd: String(finalPayableAmountUsd.toFixed(4)),
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
      .set({ costPerKg: String(inclusiveCostPerKg), costPerKgUsd: String(costPerKgUsd) })
      .where(eq(factoryRawStock.id, rawStockRow.id));
  }

  // 3. Update mix batch sources from this container
  const mixSources = await tx
    .select()
    .from(factoryMixBatchSources)
    .where(eq(factoryMixBatchSources.containerId, containerId));

  if (mixSources.length > 0) {
    for (const src of mixSources) {
      const newSrcCost = parseFloat(src.weightKg) * inclusiveCostPerKg;
      await tx
        .update(factoryMixBatchSources)
        .set({ costPerKg: String(inclusiveCostPerKg), totalCost: String(newSrcCost.toFixed(2)) })
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
      const batchTotalCost = allSrc.reduce((s: number, r) => s + parseFloat(r.totalCost || "0"), 0);
      const batchTotalWeight = allSrc.reduce((s: number, r) => s + parseFloat(r.weightKg || "0"), 0);
      const batchCostPerKg = batchTotalWeight > 0 ? batchTotalCost / batchTotalWeight : 0;
      await tx
        .update(factoryMixBatches)
        .set({
          costPerKg: String(batchCostPerKg.toFixed(4)),
          totalCost: String(batchTotalCost.toFixed(2)),
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
  if (["Admin", "Owner", "Developer"].includes(role || "")) return true;
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
