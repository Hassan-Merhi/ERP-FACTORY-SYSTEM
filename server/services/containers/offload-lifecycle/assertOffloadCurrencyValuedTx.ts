// Extracted from ./execute.ts to keep that module under the source-size cap.
import { inArray } from "drizzle-orm";
import type { DbTransaction } from "../../../db";
import * as schema from "@shared/schema";
import { createDatabaseStockMovementAdapter } from "../../inventory/databaseStockMovementAdapter";
import { ContainerOffloadLifecycleError } from "./types";
import { MoneyDecimal, toMoney } from "../../../lib/money";
import { isPerpetualInventoryActive } from "../../accounting/perpetualInventory/cutover";
import { isSupplierPartnerCompany } from "../../accounting/perpetualInventory/linkedJournal";

/** The inventory row an offload locks FOR UPDATE before rewriting its cost. */
export type InventoryLockRow = { id: number; quantity: string; total_value: string };

export const canonicalStockMovementAdapter = createDatabaseStockMovementAdapter();

export const OFFLOAD_CURRENCY_UNCONFIRMED_CODE = "CONTAINER_OFFLOAD_CURRENCY_RATE_UNCONFIRMED" as const;

export const OFFLOAD_CURRENCY_UNCONFIRMED_MESSAGE =
  "This container's purchase orders are in a currency other than USD with no confirmed exchange rate: under perpetual inventory the stock cannot be valued, so the offload is refused. Record the purchase orders in USD first.";

/**
 * Under perpetual inventory (wave 11, owner decision) an offload values the
 * stock it receives, and the INVENTORY account takes that value, in USD. An
 * ERP purchase order's line rates are in the order's currency and the order
 * carries no exchange rate, so a non-USD order has no confirmed rate to value
 * its stock at: the offload (create, replace or edit) is refused rather than
 * book native amounts as dollars. Before the company's cut-over (or for a
 * supplier partner, which carries no perpetual INVENTORY) the offload keeps its
 * behaviour.
 */
/**
 * Native ZMW POs are safe to offload only when *both* original Kwacha and
 * historical USD cost lines reconcile to the same posted-date rate. The stock
 * ledger still receives USD. Unvalued legacy CFA/other foreign POs remain
 * blocked by the original policy after perpetual-inventory cut-over.
 */
export async function assertOffloadCurrencyValuedTx(
  tx: DbTransaction,
  companyId: number,
  offloadDate: string,
  purchaseOrders: ReadonlyArray<typeof schema.purchaseOrders.$inferSelect>
): Promise<void> {
  const foreign = purchaseOrders.filter((po) => {
    const code = String(po.currency ?? "")
      .trim()
      .toUpperCase();
    return code !== "" && code !== "USD";
  });
  if (foreign.length === 0) return;
  if (!(await isPerpetualInventoryActive(tx, companyId, offloadDate))) return;
  if (await isSupplierPartnerCompany(tx, companyId)) return;

  const legacyOrUnstamped = foreign.some(
    (po) =>
      String(po.currency).toUpperCase() !== "ZMW" ||
      !po.historicalExchangeRate ||
      !po.historicalRateDate ||
      !po.nativeItemsTotal ||
      !po.nativeLineCount ||
      Number(po.nativeLineCount) <= 0
  );
  if (legacyOrUnstamped) {
    throw new ContainerOffloadLifecycleError(
      OFFLOAD_CURRENCY_UNCONFIRMED_MESSAGE,
      409,
      OFFLOAD_CURRENCY_UNCONFIRMED_CODE
    );
  }

  const rows = await tx
    .select({
      poId: schema.poLineItems.poId,
      quantity: schema.poLineItems.quantity,
      rate: schema.poLineItems.rate,
      lineTotal: schema.poLineItems.lineTotal,
      nativeRate: schema.poLineItems.nativeRate,
      nativeLineTotal: schema.poLineItems.nativeLineTotal,
    })
    .from(schema.poLineItems)
    .where(
      inArray(
        schema.poLineItems.poId,
        foreign.map((po) => po.id)
      )
    );
  for (const po of foreign) {
    const purchaseLines = rows.filter((row) => row.poId === po.id);
    const rate = toMoney(po.historicalExchangeRate);
    if (!rate.gt(0) || purchaseLines.length !== po.nativeLineCount) {
      throw new ContainerOffloadLifecycleError(
        "Native ZMW purchase line count or historical FX is unresolved; offload refused.",
        409,
        OFFLOAD_CURRENCY_UNCONFIRMED_CODE
      );
    }
    let nativeTotal = new MoneyDecimal(0);
    let usdTotal = new MoneyDecimal(0);
    for (const row of purchaseLines) {
      if (
        row.nativeRate == null ||
        row.nativeLineTotal == null ||
        toMoney(row.quantity).lte(0) ||
        !toMoney(row.nativeRate).div(rate).toDecimalPlaces(2).eq(toMoney(row.rate)) ||
        !toMoney(row.nativeLineTotal).div(rate).toDecimalPlaces(2).eq(toMoney(row.lineTotal)) ||
        !toMoney(row.quantity).times(toMoney(row.nativeRate)).toDecimalPlaces(2).eq(toMoney(row.nativeLineTotal))
      ) {
        throw new ContainerOffloadLifecycleError(
          "Native ZMW purchase line does not reconcile to the original USD inventory valuation.",
          409,
          OFFLOAD_CURRENCY_UNCONFIRMED_CODE
        );
      }
      nativeTotal = nativeTotal.plus(row.nativeLineTotal);
      usdTotal = usdTotal.plus(row.lineTotal);
    }
    if (!nativeTotal.eq(toMoney(po.nativeItemsTotal)) || !usdTotal.eq(toMoney(po.itemsTotal))) {
      throw new ContainerOffloadLifecycleError(
        "ZMW purchase totals do not reconcile to original item-level historical cost.",
        409,
        OFFLOAD_CURRENCY_UNCONFIRMED_CODE
      );
    }
  }
}

export const OFFLOAD_BEFORE_CUTOVER_CODE = "CONTAINER_OFFLOAD_BEFORE_CUTOVER" as const;

export const OFFLOAD_BEFORE_CUTOVER_MESSAGE =
  "The perpetual inventory cut-over is applied: an offload cannot be dated before the cut-over date unless it edits an offload already dated before it. Date the offload on or after the cut-over date.";

/** The date an existing offload is booked at: the container's offload date, else the offload's own. */
export function offloadBookedDate(
  container: { offloadDate: string | null },
  offload: { offloadedAt: Date | string | null } | null
): string | null {
  if (container.offloadDate) return container.offloadDate;
  if (!offload?.offloadedAt) return null;
  return new Date(offload.offloadedAt).toISOString().slice(0, 10);
}

/**
 * Wave 15 (M10): an inventory cost correction rewrites the cost of stock
 * already on hand (a revaluation), so only Admin or Owner (Developer passes,
 * as with requireRole) may send one; the offload itself keeps its own access.
 * The route passes the session's company role.
 */
export const OFFLOAD_COST_CORRECTION_FORBIDDEN_CODE = "CONTAINER_OFFLOAD_COST_CORRECTION_FORBIDDEN" as const;

export const OFFLOAD_COST_CORRECTION_FORBIDDEN_MESSAGE =
  "Only an Admin or Owner can correct the cost of stock already on hand during an offload.";

export const OFFLOAD_COST_CORRECTION_ROLES = new Set(["Admin", "Owner", "Developer"]);

export interface OffloadCostCorrectionApprover {
  /** The caller's company role; cost corrections need Admin or Owner. */
  actorRole?: string | null;
}
