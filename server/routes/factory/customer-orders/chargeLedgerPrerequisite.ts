import type { Express, NextFunction, Request, Response } from "express";
import { and, eq } from "drizzle-orm";
import { customers, customerOrders } from "@shared/schema";
import { requireAuth } from "../../../auth";
import { db } from "../../../db";
import { logger } from "../../../lib/logger";
import { parseId } from "../../../lib/parseId";
import { getOrCreateLedgerAccount } from "../_helpers";

const POSTING_STATUSES = new Set(["PENDING_VERIFICATION", "VERIFIED", "FINALIZED"]);

async function ensureCustomerLedgerForChargeWrite(req: Request, res: Response, next: NextFunction) {
  try {
    const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
    const orderId = parseId(req.params.id);

    // Preserve the existing route's validation/error messages when the request
    // itself is incomplete; this middleware only supplies the accounting prerequisite.
    if (!companyId || orderId === null) return next();

    const [order] = await db
      .select({
        customerId: customerOrders.customerId,
        status: customerOrders.status,
      })
      .from(customerOrders)
      .where(and(eq(customerOrders.id, orderId), eq(customerOrders.companyId, companyId)));

    if (!order || !POSTING_STATUSES.has(order.status)) return next();

    const [customer] = await db
      .select({
        ledgerAccountId: customers.ledgerAccountId,
        legalName: customers.legalName,
      })
      .from(customers)
      .where(eq(customers.id, order.customerId));

    if (!customer || customer.ledgerAccountId) return next();

    const customerLedgerAccountId = await getOrCreateLedgerAccount(
      companyId,
      `CUST-${order.customerId}`,
      customer.legalName || `Customer ${order.customerId}`,
      "Asset"
    );

    await db
      .update(customers)
      .set({ ledgerAccountId: customerLedgerAccountId })
      .where(and(eq(customers.id, order.customerId), eq(customers.companyId, companyId)));

    next();
  } catch (error) {
    logger.error("Failed to ensure customer ledger before factory charge write", { error });
    next(error);
  }
}

/**
 * Charge POST/PATCH handlers create accounting vouchers only when the customer
 * already owns a ledger account. Register this prerequisite before the legacy
 * handlers so VERIFIED/PENDING charges can never be saved without their voucher.
 */
export function registerChargeLedgerPrerequisite(app: Express) {
  app.post(
    "/api/factory/customer-orders/:id/charges",
    requireAuth,
    ensureCustomerLedgerForChargeWrite
  );
  app.patch(
    "/api/factory/customer-orders/:id/charges/:chargeId",
    requireAuth,
    ensureCustomerLedgerForChargeWrite
  );
}
