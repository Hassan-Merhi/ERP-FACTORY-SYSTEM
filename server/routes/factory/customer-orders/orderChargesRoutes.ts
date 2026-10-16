import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { parseId } from "../../../lib/parseId";
import { getClientDate } from "../../../lib/dateUtils";
import type { Express, Request, Response } from "express";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { getOrCreateLedgerAccount, recalculateOrderTotals } from "../_helpers";
import { customerOrderCharges, customerOrders, customers, ledgerAccounts, vouchers } from "@shared/schema";
import { eq, and, sql, isNull } from "drizzle-orm";
import { moneyString, parseMoneyInput, toMoney } from "../../../lib/money";
import { FactoryInvoiceRateRefusalError } from "../../../services/accounting/perpetualInventory/factoryInvoice";
import { retireVouchersTx, sessionRetirementActor } from "../../../services/accounting/voucherRetirement";
import { PostingValidationError } from "../../../services/accounting/centralPostingEngine";
import { sendVoucherCorrectionRefusal } from "../../../services/factory/factoryVoucherCorrection";
import { closedPeriodErrorResponse } from "../../../lib/closedPeriodError";
import {
  finalizedChargeVoucherNumber,
  lockCustomerOrderTx,
  postOrderChargeVoucherTx,
  preChargeVoucherNumber,
  setChargeVoucherAmountTx,
  syncOrderTotalsTx,
} from "./orderChargeLedger";

/**
 * Phase 22 (C): every charge route runs in one transaction — the order row is
 * locked first (DI7), the charge, the order totals, the charge voucher (engine,
 * charge posting identity), the customer balance, the daybook and the invoice
 * journal commit together or not at all (F13; the invoice journal used to be
 * synced in a second transaction after the commit).
 */
class OrderChargeHttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

function chargeErrorResponse(res: Response, error: unknown, label: string) {
  if (error instanceof OrderChargeHttpError) return res.status(error.status).json({ message: error.message });
  if (sendVoucherCorrectionRefusal(res, error)) return;
  if (error instanceof FactoryInvoiceRateRefusalError) return res.status(409).json(error.body);
  const closed = closedPeriodErrorResponse(error);
  if (closed) return res.status(closed.status).json(closed.body);
  if (error instanceof PostingValidationError)
    return res.status(400).json({ message: error.message, code: error.code });
  logger.error(label, { error: error });
  return res.status(500).json({ message: getErrorMessage(error) });
}

/** The customer's ledger account, created and linked when the customer has none. */
async function customerLedgerAccountId(companyId: number, customerId: number): Promise<number> {
  const [customer] = await db
    .select({ ledgerAccountId: customers.ledgerAccountId, legalName: customers.legalName })
    .from(customers)
    .where(eq(customers.id, customerId));
  if (customer?.ledgerAccountId) return customer.ledgerAccountId;
  const customerName = customer?.legalName || `Customer ${customerId}`;
  const accountId = await getOrCreateLedgerAccount(companyId, `CUST-${customerId}`, customerName, "Asset");
  await db.update(customers).set({ ledgerAccountId: accountId }).where(eq(customers.id, customerId));
  return accountId;
}

async function existingCustomerLedgerAccountId(customerId: number): Promise<number | null> {
  const [customer] = await db
    .select({ ledgerAccountId: customers.ledgerAccountId })
    .from(customers)
    .where(eq(customers.id, customerId));
  return customer?.ledgerAccountId ?? null;
}

const editActor = (req: Request) => ({ userId: req.session.userId, username: req.session.username });

export function registerOrderChargesRoutes(app: Express) {
  app.post("/api/factory/customer-orders/:id/charges", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const orderId = parseId(req.params.id);

      if (orderId === null) return res.status(400).json({ message: "Invalid id" });
      const { name, amount, chargeType, ledgerAccountId } = req.body;
      if (!name || !amount) return res.status(400).json({ message: "name and amount are required" });

      const [orderPreview] = await db
        .select({ customerId: customerOrders.customerId, status: customerOrders.status })
        .from(customerOrders)
        .where(and(eq(customerOrders.id, orderId), eq(customerOrders.companyId, companyId)));
      if (!orderPreview) return res.status(404).json({ message: "Order not found" });
      // Charge vouchers are only posted on FINALIZED invoices. Non-finalized
      // order charges remain operational amounts until the customer is billed.
      const chargeAmt = parseMoneyInput(String(amount)) ?? toMoney(0);
      const resolvedLedgerAccountId = ledgerAccountId ? parseInt(ledgerAccountId) : null;
      // Master data first (its own commit): the customer's ledger account.
      const customerAccountId =
        resolvedLedgerAccountId && chargeAmt.greaterThan(0) && orderPreview.status === "FINALIZED"
          ? await customerLedgerAccountId(companyId, orderPreview.customerId)
          : null;

      const result = await db.transaction(async (tx) => {
        const order = await lockCustomerOrderTx(tx, companyId, orderId);
        if (!order) throw new OrderChargeHttpError(404, "Order not found");

        const [newCharge] = await tx
          .insert(customerOrderCharges)
          .values({
            orderId,
            name,
            amount: String(amount),
            chargeType: chargeType || "OTHER",
            ledgerAccountId: resolvedLedgerAccountId,
          })
          .returning();

        await recalculateOrderTotals(tx, orderId);
        const status = order.status;

        let chargeWarning: string | undefined;
        if (status === "FINALIZED") {
          // Create charge voucher (FINALIZED path). Gate: a linked ledger account and
          // an amount > 0; the invoice number falls back to ORD-{id} for old orders.
          if (newCharge && resolvedLedgerAccountId && chargeAmt.greaterThan(0) && customerAccountId) {
            const voucherRef = order.invoiceNumber || `ORD-${orderId}`;
            await postOrderChargeVoucherTx(tx, {
              companyId,
              chargeId: newCharge.id,
              voucherNumber: finalizedChargeVoucherNumber(voucherRef, newCharge.id),
              voucherDate: order.orderDate || getClientDate(req),
              description: order.containerNumber
                ? `${name} for offloaded container - ${order.containerNumber}`
                : `${name} - ${voucherRef}`,
              customerId: order.customerId,
              customerLedgerAccountId: customerAccountId,
              chargeLedgerAccountId: resolvedLedgerAccountId,
              amount: chargeAmt,
            });
          } else if (newCharge && !resolvedLedgerAccountId && chargeAmt.greaterThan(0)) {
            chargeWarning =
              "Charge saved but no ledger entry was created — no ledger account was linked to this charge.";
          }
        }
        // Pending/Loading/Verified charges do not generate customer debt.
        // finalize-loading/finalize.ts creates their vouchers when the order
        // becomes FINALIZED, while preserving any historical linked PRE-vouchers.

        await syncOrderTotalsTx(tx, companyId, orderId);
        return { chargeWarning };
      });

      const [updatedOrder] = await db.select().from(customerOrders).where(eq(customerOrders.id, orderId));
      const updatedCharges = await db
        .select()
        .from(customerOrderCharges)
        .where(eq(customerOrderCharges.orderId, orderId));
      res.json({ ...updatedOrder, charges: updatedCharges, warning: result.chargeWarning });
    } catch (error: unknown) {
      chargeErrorResponse(res, error, "Error adding charge to order:");
    }
  });

  // Retroactively create missing ledger vouchers for charges that were saved without one
  app.post(
    "/api/factory/customer-orders/:id/charges/relink-vouchers",
    requireAuth,
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        const orderId = parseId(req.params.id);
        if (orderId === null) return res.status(400).json({ message: "Invalid id" });

        const [orderPreview] = await db
          .select()
          .from(customerOrders)
          .where(and(eq(customerOrders.id, orderId), eq(customerOrders.companyId, companyId)));
        if (!orderPreview) return res.status(404).json({ message: "Order not found" });
        if (orderPreview.status !== "FINALIZED") return res.status(400).json({ message: "Order is not finalized" });

        // Auto-create and link a ledger account for the customer if one doesn't exist yet
        const customerAccountId = await customerLedgerAccountId(companyId, orderPreview.customerId);
        const allLedgerAccounts = await db
          .select({ id: ledgerAccounts.id, name: ledgerAccounts.name })
          .from(ledgerAccounts)
          .where(eq(ledgerAccounts.companyId, companyId));

        const outcome = await db.transaction(async (tx) => {
          const order = await lockCustomerOrderTx(tx, companyId, orderId);
          if (!order) throw new OrderChargeHttpError(404, "Order not found");
          if (order.status !== "FINALIZED") throw new OrderChargeHttpError(400, "Order is not finalized");

          // Find all charges missing a voucher
          const unlinkedCharges = await tx
            .select()
            .from(customerOrderCharges)
            .where(and(eq(customerOrderCharges.orderId, orderId), isNull(customerOrderCharges.voucherId)));
          const actionableCharges = unlinkedCharges.filter((c) => toMoney(c.amount).greaterThan(0));
          if (actionableCharges.length === 0) return { linked: 0, skipped: [] as string[], nothing: true };

          // For charges without a ledgerAccountId, attempt to auto-match by name
          // (e.g. a charge named "Surcharge" matches a ledger account named "Surcharge")
          const skipped: string[] = [];
          let linked = 0;
          const voucherRef = order.invoiceNumber || `ORD-${orderId}`;
          for (const charge of actionableCharges) {
            let resolvedId = charge.ledgerAccountId ?? null;
            if (!resolvedId && charge.name) {
              const match = allLedgerAccounts.find(
                (a) => a.name.trim().toLowerCase() === charge.name!.trim().toLowerCase()
              );
              if (match) {
                resolvedId = match.id;
                // Persist the resolved account so future relinks don't need to re-match
                await tx
                  .update(customerOrderCharges)
                  .set({ ledgerAccountId: resolvedId })
                  .where(eq(customerOrderCharges.id, charge.id));
              }
            }
            if (!resolvedId) {
              skipped.push(charge.name || `#${charge.id}`);
              continue;
            }
            await postOrderChargeVoucherTx(tx, {
              companyId,
              chargeId: charge.id,
              voucherNumber: finalizedChargeVoucherNumber(voucherRef, charge.id),
              voucherDate: order.orderDate || getClientDate(req),
              description: order.containerNumber
                ? `${charge.name} for offloaded container - ${order.containerNumber}`
                : `${charge.name} - ${voucherRef}`,
              customerId: order.customerId,
              customerLedgerAccountId: customerAccountId,
              chargeLedgerAccountId: resolvedId,
              amount: charge.amount,
            });
            linked++;
          }
          if (linked > 0) await syncOrderTotalsTx(tx, companyId, orderId);
          return { linked, skipped, nothing: false };
        });

        if (outcome.nothing) {
          return res.json({ linked: 0, message: "All charges already have ledger entries — nothing to relink." });
        }
        const { linked } = outcome;
        if (linked === 0) {
          const skippedMsg = outcome.skipped.length
            ? ` Could not auto-match: ${outcome.skipped.join(", ")}. Link a ledger account to each charge first.`
            : "";
          return res.json({ linked: 0, message: `No charges could be linked.${skippedMsg}` });
        }
        const skippedMsg = outcome.skipped.length
          ? ` ${outcome.skipped.length} skipped (no matching account): ${outcome.skipped.join(", ")}.`
          : "";
        res.json({
          linked,
          message: `${linked} charge${linked !== 1 ? "s" : ""} successfully linked to the ledger.${skippedMsg}`,
        });
      } catch (error: unknown) {
        chargeErrorResponse(res, error, "Error relinking charge vouchers:");
      }
    }
  );

  app.patch("/api/factory/customer-orders/:id/charges/:chargeId", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const orderId = parseId(req.params.id);

      if (orderId === null) return res.status(400).json({ message: "Invalid id" });
      const chargeId = parseId(req.params.chargeId);
      if (chargeId === null) return res.status(400).json({ message: "Invalid id" });

      const { ledgerAccountId, amount, name } = req.body;
      const updateData: Record<string, unknown> = {};
      if (ledgerAccountId !== undefined)
        updateData.ledgerAccountId = ledgerAccountId ? parseInt(ledgerAccountId) : null;
      // The charge and its voucher get the same cents: the float toFixed(2)
      // stored 1.005 as 1.00 while the voucher's numeric(…, 2) kept 1.01.
      const newAmountCents = amount !== undefined ? parseMoneyInput(amount) : null;
      if (amount !== undefined && !newAmountCents) return res.status(400).json({ message: "Invalid amount" });
      if (newAmountCents) updateData.amount = moneyString(newAmountCents);
      if (name !== undefined) updateData.name = name;

      if (Object.keys(updateData).length === 0) return res.status(400).json({ message: "Nothing to update" });

      await db.transaction(async (tx) => {
        const order = await lockCustomerOrderTx(tx, companyId, orderId);
        if (!order) throw new OrderChargeHttpError(404, "Order not found");

        // Read the charge BEFORE update so we have the voucherId
        const [chargeBeforeUpdate] = await tx
          .select()
          .from(customerOrderCharges)
          .where(and(eq(customerOrderCharges.orderId, orderId), eq(customerOrderCharges.id, chargeId)));
        if (!chargeBeforeUpdate) throw new OrderChargeHttpError(404, "Charge not found");

        await tx
          .update(customerOrderCharges)
          .set(updateData)
          .where(and(eq(customerOrderCharges.orderId, orderId), eq(customerOrderCharges.id, chargeId)));

        await recalculateOrderTotals(tx, orderId);

        // An amount change on an order with a linked voucher (FINALIZED, or a
        // PRE-voucher on PENDING_VERIFICATION / VERIFIED) is an audited edit of
        // that posted voucher, refused (409) in a closed period.
        if (
          amount !== undefined &&
          newAmountCents &&
          ["FINALIZED", "PENDING_VERIFICATION", "VERIFIED"].includes(order.status) &&
          chargeBeforeUpdate.voucherId
        ) {
          await setChargeVoucherAmountTx(tx, {
            companyId,
            voucherId: chargeBeforeUpdate.voucherId,
            amount: newAmountCents,
            actor: editActor(req),
          });
        }

        // A newly linked ledger account can create a charge voucher only
        // AFTER finalization. Pending and verified charges stay outside the
        // customer's statement and ledger until the invoice is finalized.
        const newLedgerAccountId = ledgerAccountId ? parseInt(ledgerAccountId) : null;
        if (
          newLedgerAccountId &&
          !chargeBeforeUpdate.voucherId &&
          order.status === "FINALIZED"
        ) {
          const [updatedCharge] = await tx
            .select()
            .from(customerOrderCharges)
            .where(eq(customerOrderCharges.id, chargeId));
          const chargeAmt = updatedCharge?.amount
            ? toMoney(updatedCharge.amount)
            : (parseMoneyInput(String(amount)) ?? toMoney(0));
          const customerAccountId = chargeAmt.greaterThan(0)
            ? await existingCustomerLedgerAccountId(order.customerId)
            : null;
          if (customerAccountId) {
            await postOrderChargeVoucherTx(tx, {
              companyId,
              chargeId,
              voucherNumber: finalizedChargeVoucherNumber(order.invoiceNumber || `ORD-${orderId}`, chargeId),
              voucherDate: order.orderDate || getClientDate(req),
              description: order.containerNumber
                ? `${updatedCharge?.name || "Charge"} for container - ${order.containerNumber}`
                : `${updatedCharge?.name || "Charge"} - Order #${orderId}`,
              customerId: order.customerId,
              customerLedgerAccountId: customerAccountId,
              chargeLedgerAccountId: newLedgerAccountId,
              amount: chargeAmt,
            });
          }
        }

        await syncOrderTotalsTx(tx, companyId, orderId);
      });

      const [updatedOrder] = await db.select().from(customerOrders).where(eq(customerOrders.id, orderId));
      const updatedCharges = await db
        .select()
        .from(customerOrderCharges)
        .where(eq(customerOrderCharges.orderId, orderId));

      res.json({ ...updatedOrder, charges: updatedCharges });
    } catch (error: unknown) {
      chargeErrorResponse(res, error, "[PATCH charge]");
    }
  });

  app.delete("/api/factory/customer-orders/:id/charges/:chargeId", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const orderId = parseId(req.params.id);

      if (orderId === null) return res.status(400).json({ message: "Invalid id" });
      const chargeId = parseId(req.params.chargeId);
      if (chargeId === null) return res.status(400).json({ message: "Invalid id" });

      await db.transaction(async (tx) => {
        const order = await lockCustomerOrderTx(tx, companyId, orderId);
        if (!order) throw new OrderChargeHttpError(404, "Order not found");

        // Phase 6: read FK linkage BEFORE deleting the charge so we can drop the linked voucher precisely
        const [chargeRow] = await tx
          .select({ voucherId: customerOrderCharges.voucherId })
          .from(customerOrderCharges)
          .where(and(eq(customerOrderCharges.orderId, orderId), eq(customerOrderCharges.id, chargeId)));
        const linkedVoucherId = chargeRow?.voucherId ?? null;

        await tx
          .delete(customerOrderCharges)
          .where(and(eq(customerOrderCharges.orderId, orderId), eq(customerOrderCharges.id, chargeId)));

        await recalculateOrderTotals(tx, orderId);

        // Phase 6: prefer FK-based delete; fall back to voucherNumber pattern for legacy unbacked rows
        let chargeVoucherIdsToDelete: number[] = [];
        if (linkedVoucherId) {
          chargeVoucherIdsToDelete.push(linkedVoucherId);
        } else {
          // Legacy fallback: PRE-voucher pattern + invoice-number pattern
          const legacyPatterns: string[] = [preChargeVoucherNumber(orderId, chargeId)];
          if (order.invoiceNumber) legacyPatterns.push(`CHARGE-${order.invoiceNumber}-${chargeId}-%`);
          const legacyMatches = await tx
            .select({ id: vouchers.id, voucherNumber: vouchers.voucherNumber })
            .from(vouchers)
            .where(
              and(
                eq(vouchers.companyId, companyId),
                isNull(vouchers.deletedAt),
                sql`(${vouchers.voucherNumber} = ${legacyPatterns[0]}${
                  legacyPatterns.length > 1 ? sql` OR ${vouchers.voucherNumber} LIKE ${legacyPatterns[1]}` : sql``
                })`
              )
            );
          chargeVoucherIdsToDelete = legacyMatches.map((v) => v.id);
        }

        if (chargeVoucherIdsToDelete.length > 0) {
          // Wave 16 (A): retired with their lines (they used to be stripped), audited.
          await retireVouchersTx(tx, {
            companyId,
            voucherIds: chargeVoucherIdsToDelete,
            reason: "customer-order-charge-delete",
            actor: sessionRetirementActor(req),
          });
        }

        await syncOrderTotalsTx(tx, companyId, orderId);
      });

      const [updatedOrder] = await db.select().from(customerOrders).where(eq(customerOrders.id, orderId));
      const updatedCharges = await db
        .select()
        .from(customerOrderCharges)
        .where(eq(customerOrderCharges.orderId, orderId));

      res.json({ ...updatedOrder, charges: updatedCharges });
    } catch (error: unknown) {
      chargeErrorResponse(res, error, "Error removing charge from order:");
    }
  });

  // Link a proforma to an existing unlinked LOADING order (V5 backfill support).
  // V5 guard: sets proforma_id_used and backfills customer_order_expected_lines.
  // Rules: order must be LOADING and currently unlinked (proforma_id_used IS NULL).
  //        proforma must be active and belong to the same company.
  //        customer must match if both order and proforma have a customer_id.
}
