// Extracted from ./orderPricingRoutes.ts to keep that module under the source-size cap.
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { parseId } from "../../../lib/parseId";
import type { Request, Response } from "express";
import type Decimal from "decimal.js";
import { db, type DbTransaction } from "../../../db";
import { recalculateOrderTotals } from "../_helpers";
import { customerOrderBales, customerOrderCharges, customerOrderLines, customerOrders } from "@shared/schema";
import { eq } from "drizzle-orm";
import { moneyString, toMoney } from "../../../lib/money";
import { FactoryInvoiceRateRefusalError } from "../../../services/accounting/perpetualInventory/factoryInvoice";
import { PostingValidationError } from "../../../services/accounting/centralPostingEngine";
import { closedPeriodErrorResponse } from "../../../lib/closedPeriodError";
import { lockCustomerOrderTx, syncOrderTotalsTx } from "./orderChargeLedger";

/**
 * Phase 22 (C), F13/PE10 and DI7: every re-pricing runs in one transaction —
 * the order row is locked FOR UPDATE before it is read, the bale prices, the
 * order totals, the invoice's customer balance (locked) and the invoice
 * journal commit together. The invoice journal used to be synced in a second
 * transaction after the commit, so a refused sync (e.g. no factory rate) left
 * the order re-priced with the old journal; the balance row was read and
 * rewritten with no lock.
 */
export class PricingHttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

type OrderRow = typeof customerOrders.$inferSelect;

type OrderBaleRow = typeof customerOrderBales.$inferSelect;

export type PriceUpdate = { baleRowId: number; price: Decimal };

export function pricingErrorResponse(res: Response, error: unknown, label: string) {
  if (error instanceof PricingHttpError) return res.status(error.status).json({ message: error.message });
  if (error instanceof FactoryInvoiceRateRefusalError) return res.status(409).json(error.body);
  const closed = closedPeriodErrorResponse(error);
  if (closed) return res.status(closed.status).json(closed.body);
  if (error instanceof PostingValidationError)
    return res.status(400).json({ message: error.message, code: error.code });
  logger.error(label, { error: error });
  return res.status(500).json({ message: getErrorMessage(error) });
}

/** A new price for a bale when it is positive and differs from the current one. */
export function changedPrice(raw: string | null | undefined, current: string | null | undefined): Decimal | null {
  if (raw == null) return null;
  const next = toMoney(raw);
  if (next.lessThanOrEqualTo(0)) return null;
  if (next.minus(toMoney(current)).abs().lessThan(0.001)) return null;
  return next;
}

/**
 * Lock the order, compute the bale price changes from its current bales, write
 * them, recalculate and sync the invoice side — one transaction. Returns the
 * number of bales re-priced.
 */
export async function repriceOrderTx(
  tx: DbTransaction,
  companyId: number,
  orderId: number,
  check: (order: OrderRow) => string | null,
  plan: (order: OrderRow, bales: OrderBaleRow[]) => Promise<PriceUpdate[]>,
  emptyMessage = "Order has no bales to reprice"
): Promise<number> {
  const order = await lockCustomerOrderTx(tx, companyId, orderId);
  if (!order) throw new PricingHttpError(404, "Order not found");
  const refusal = check(order);
  if (refusal) throw new PricingHttpError(400, refusal);
  const orderBales = await tx.select().from(customerOrderBales).where(eq(customerOrderBales.orderId, orderId));
  if (orderBales.length === 0) throw new PricingHttpError(400, emptyMessage);
  const updates = await plan(order, orderBales);
  for (const update of updates) {
    await tx
      .update(customerOrderBales)
      .set({ priceUsed: moneyString(update.price) })
      .where(eq(customerOrderBales.id, update.baleRowId));
  }
  await recalculateOrderTotals(tx, orderId);
  await syncOrderTotalsTx(tx, companyId, orderId, { daybook: false });
  return updates.length;
}

export async function orderWithDetails(orderId: number, repriced: number) {
  const [updatedOrder] = await db.select().from(customerOrders).where(eq(customerOrders.id, orderId));
  const updatedBales = await db.select().from(customerOrderBales).where(eq(customerOrderBales.orderId, orderId));
  const updatedLines = await db.select().from(customerOrderLines).where(eq(customerOrderLines.orderId, orderId));
  const updatedCharges = await db.select().from(customerOrderCharges).where(eq(customerOrderCharges.orderId, orderId));
  return { ...updatedOrder, bales: updatedBales, lines: updatedLines, charges: updatedCharges, repriced };
}

export function orderIdOf(req: Request, res: Response): { companyId: number; orderId: number } | null {
  const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
  if (!companyId) {
    res.status(400).json({ message: "No company selected" });
    return null;
  }
  const orderId = parseId(req.params.id);
  if (orderId === null) {
    res.status(400).json({ message: "Invalid id" });
    return null;
  }
  return { companyId, orderId };
}

export const notCancelled = (order: OrderRow) =>
  order.status === "CANCELLED" ? "Cannot reprice a cancelled order" : null;
