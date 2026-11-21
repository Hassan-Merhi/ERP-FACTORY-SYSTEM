import { db } from "../../db";
import { syncLoadingStartedDaybookTotal } from "./customer-orders/loadingDaybookAmount";
import {
  ledgerAccounts,
  customerOrderBales,
  customerOrderLines,
  customerOrderCharges,
  customerOrders,
  customerProformaLines,
} from "@shared/schema";
import { eq, and, sql } from "drizzle-orm";
import { resultRows } from "../../lib/queryResult";
import { verifyPasswordBcryptOnly } from "../helpers/passwordHelpers";
import type { DbTransaction, DatabaseOrTransaction } from "../../db";
import type Decimal from "decimal.js";
import { MoneyDecimal, sumMoney, toMoney } from "../../lib/money";
import { systemAccountDefinition } from "../../services/accounting/systemAccounts";
import { syncFactoryInvoiceTx } from "../../services/accounting/perpetualInventory/factoryInvoice";
import { withFactoryValuationEventTx } from "../../services/factory/factoryStockValueEvents";
import { resolveFactoryFxRateToUsd } from "../../services/factory/factoryFxRateReadOnly";
import { recalculateContainerCostsInner } from "./_helpersHelpers";
export { getUserHideAllCosts } from "./_helpersHelpers";

// Phase 19 C (M3): one shared daybook writer; a missing rate is stored unresolved (0), never 1.
export { writeDaybookEntry } from "../../services/factory/factoryDaybookWriter";

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
  // Shared bcrypt-only step-up; old SHA-256 accounts must first log in and migrate.
  return verifyPasswordBcryptOnly(password, hash);
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
    // Supplements are scoped to this order, and override per-kg pricing
    // only here. The master proforma stays untouched for sibling loadings.
    const extras = resultRows<{ article_code: string }>(
      await dbConn.execute(sql`
      SELECT article_code FROM customer_order_extra_expected_lines WHERE order_id = ${orderId}
    `)
    );
    for (const extra of extras) {
      proformaPricing.set(extra.article_code.trim().toLowerCase(), {
        pricingMode: "per_bale",
        pricePerKg: null,
      });
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

  // Scans removed, swapped or repriced use this same synchronized loading event.
  await syncLoadingStartedDaybookTotal(dbConn, orderId);

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
