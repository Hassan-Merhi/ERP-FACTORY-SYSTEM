import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { parseId } from "../../../lib/parseId";
import { getClientDate } from "../../../lib/dateUtils";
import type { Express, Request, Response } from "express";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { getOrCreateLedgerAccount, recalculateOrderTotals } from "../_helpers";
import {
  customerOrders,
  customerOrderCharges,
  customerBalances,
  customers,
  ledgerAccounts,
  voucherEntries,
  factoryDaybookEntries,
  vouchers,
} from "@shared/schema";
import { eq, and, sql, isNull } from "drizzle-orm";
import { moneyString, parseMoneyInput, toMoney } from "../../../lib/money";
import { syncFactoryInvoiceTx } from "../../../services/accounting/perpetualInventory/factoryInvoice";
import { retireVouchersTx, sessionRetirementActor } from "../../../services/accounting/voucherRetirement";

export function registerOrderChargesRoutes(app: Express) {
  app.post("/api/factory/customer-orders/:id/charges", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const orderId = parseId(req.params.id);

      if (orderId === null) return res.status(400).json({ message: "Invalid id" });
      const { name, amount, chargeType, ledgerAccountId } = req.body;
      if (!name || !amount) return res.status(400).json({ message: "name and amount are required" });

      const [order] = await db
        .select()
        .from(customerOrders)
        .where(and(eq(customerOrders.id, orderId), eq(customerOrders.companyId, companyId)));
      if (!order) return res.status(404).json({ message: "Order not found" });

      const [newCharge] = await db
        .insert(customerOrderCharges)
        .values({
          orderId,
          name,
          amount: String(amount),
          chargeType: chargeType || "OTHER",
          ledgerAccountId: ledgerAccountId ? parseInt(ledgerAccountId) : null,
        })
        .returning();

      await recalculateOrderTotals(db, orderId);

      const [updatedOrder] = await db.select().from(customerOrders).where(eq(customerOrders.id, orderId));
      const updatedCharges = await db
        .select()
        .from(customerOrderCharges)
        .where(eq(customerOrderCharges.orderId, orderId));

      const resolvedLedgerAccountId = newCharge?.ledgerAccountId;
      // Read as parseFloat read it; one that does not parse posts no voucher.
      const chargeAmt = parseMoneyInput(String(amount)) ?? toMoney(0);

      // Sync customerBalances ledger entry if the order is already finalized
      let chargeWarning: string | undefined;
      if (updatedOrder.status === "FINALIZED") {
        const newGrandTotal = moneyString(updatedOrder.grandTotal);
        const [existingLedgerEntry] = await db
          .select({ id: customerBalances.id })
          .from(customerBalances)
          .where(
            and(
              eq(customerBalances.companyId, companyId),
              eq(customerBalances.referenceType, "INVOICE"),
              eq(customerBalances.referenceId, orderId)
            )
          );
        if (existingLedgerEntry) {
          await db
            .update(customerBalances)
            .set({ debitAmount: newGrandTotal, balance: newGrandTotal })
            .where(eq(customerBalances.id, existingLedgerEntry.id));
        }

        // Create charge voucher (FINALIZED path)
        // Gate: charge must have a ledger account linked + charge amount > 0
        // invoiceNumber is optional — fall back to ORD-{id} so old orders aren't silently skipped
        if (newCharge && resolvedLedgerAccountId && chargeAmt.greaterThan(0)) {
          const [customer] = await db
            .select({ ledgerAccountId: customers.ledgerAccountId, legalName: customers.legalName })
            .from(customers)
            .where(eq(customers.id, order.customerId));
          // Auto-create and link a ledger account for the customer if one doesn't exist
          let customerLedgerAccountId = customer?.ledgerAccountId;
          if (!customerLedgerAccountId) {
            const customerName = customer?.legalName || `Customer ${order.customerId}`;
            customerLedgerAccountId = await getOrCreateLedgerAccount(
              companyId,
              `CUST-${order.customerId}`,
              customerName,
              "Asset"
            );
            await db
              .update(customers)
              .set({ ledgerAccountId: customerLedgerAccountId })
              .where(eq(customers.id, order.customerId));
          }
          const voucherRef = updatedOrder.invoiceNumber || `ORD-${orderId}`;
          const chargeVoucherNumber = `CHARGE-${voucherRef}-${newCharge.id}-${Date.now()}`;
          const chargeDesc = order.containerNumber
            ? `${name} for offloaded container - ${order.containerNumber}`
            : `${name} - ${voucherRef}`;
          // Atomic: voucher + entries + FK stamp must all commit together
          await db.transaction(async (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => {
            const [chargeVoucher] = await tx
              .insert(vouchers)
              .values({
                companyId,
                voucherType: "Journal",
                voucherNumber: chargeVoucherNumber,
                voucherDate: updatedOrder.orderDate || getClientDate(req),
                description: chargeDesc,
                totalAmount: moneyString(chargeAmt),
                sourceModule: "FACTORY",
              })
              .returning();
            await tx.insert(voucherEntries).values({
              voucherId: chargeVoucher.id,
              ledgerAccountId: customerLedgerAccountId,
              customerId: order.customerId,
              debitAmount: moneyString(chargeAmt),
              creditAmount: "0",
              narration: chargeDesc,
            });
            await tx.insert(voucherEntries).values({
              voucherId: chargeVoucher.id,
              ledgerAccountId: resolvedLedgerAccountId,
              debitAmount: "0",
              creditAmount: moneyString(chargeAmt),
              narration: chargeDesc,
            });
            await tx
              .update(customerOrderCharges)
              .set({ voucherId: chargeVoucher.id })
              .where(eq(customerOrderCharges.id, newCharge.id));
          });
        } else if (newCharge && !resolvedLedgerAccountId && chargeAmt.greaterThan(0)) {
          chargeWarning = "Charge saved but no ledger entry was created — no ledger account was linked to this charge.";
        }
      }

      // Sync daybook INVOICE row with new grand total (FINALIZED path)
      if (updatedOrder.status === "FINALIZED") {
        const newGrandTotal = moneyString(updatedOrder.grandTotal);
        const [daybookEntry] = await db
          .select({ id: factoryDaybookEntries.id })
          .from(factoryDaybookEntries)
          .where(
            and(
              eq(factoryDaybookEntries.companyId, companyId),
              eq(factoryDaybookEntries.txType, "INVOICE"),
              eq(factoryDaybookEntries.referenceId, orderId)
            )
          );
        if (daybookEntry) {
          await db
            .update(factoryDaybookEntries)
            .set({ amountCurrency: newGrandTotal, amountUsd: newGrandTotal })
            .where(eq(factoryDaybookEntries.id, daybookEntry.id));
        }
      }

      // Sync daybook ORDER_VERIFIED row with new grand total (VERIFIED path)
      if (updatedOrder.status === "VERIFIED") {
        const newGrandTotal = moneyString(updatedOrder.grandTotal);
        const [verifiedDaybookEntry] = await db
          .select({ id: factoryDaybookEntries.id })
          .from(factoryDaybookEntries)
          .where(
            and(
              eq(factoryDaybookEntries.companyId, companyId),
              eq(factoryDaybookEntries.txType, "ORDER_VERIFIED"),
              eq(factoryDaybookEntries.referenceId, orderId)
            )
          );
        if (verifiedDaybookEntry) {
          await db
            .update(factoryDaybookEntries)
            .set({ amountCurrency: newGrandTotal, amountUsd: newGrandTotal })
            .where(eq(factoryDaybookEntries.id, verifiedDaybookEntry.id));
        }
      }

      // Create PRE-voucher when order is PENDING or VERIFIED (before finalization)
      // Uses naming CHARGE-PRE-{orderId}-{chargeId} — finalization will rename it to the
      // invoice-based name, so it is never double-counted.
      if (
        ["PENDING_VERIFICATION", "VERIFIED"].includes(updatedOrder.status) &&
        newCharge &&
        resolvedLedgerAccountId &&
        chargeAmt.greaterThan(0)
      ) {
        const [customer] = await db
          .select({ ledgerAccountId: customers.ledgerAccountId })
          .from(customers)
          .where(eq(customers.id, order.customerId));
        if (customer?.ledgerAccountId) {
          const preVoucherNumber = `CHARGE-PRE-${orderId}-${newCharge.id}`;
          const chargeDesc = order.containerNumber
            ? `${name} for container - ${order.containerNumber}`
            : `${name} - Order #${orderId}`;
          // Phase 6: atomic — voucher + entries + FK stamp must all commit together
          // to avoid orphaned (unlinked) vouchers on mid-flight failure.
          await db.transaction(async (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => {
            const [chargeVoucher] = await tx
              .insert(vouchers)
              .values({
                companyId,
                voucherType: "Journal",
                voucherNumber: preVoucherNumber,
                voucherDate: order.orderDate || getClientDate(req),
                description: chargeDesc,
                totalAmount: moneyString(chargeAmt),
                sourceModule: "FACTORY",
              })
              .returning();
            await tx.insert(voucherEntries).values({
              voucherId: chargeVoucher.id,
              ledgerAccountId: customer.ledgerAccountId,
              customerId: order.customerId,
              debitAmount: moneyString(chargeAmt),
              creditAmount: "0",
              narration: chargeDesc,
            });
            await tx.insert(voucherEntries).values({
              voucherId: chargeVoucher.id,
              ledgerAccountId: resolvedLedgerAccountId,
              debitAmount: "0",
              creditAmount: moneyString(chargeAmt),
              narration: chargeDesc,
            });
            await tx
              .update(customerOrderCharges)
              .set({ voucherId: chargeVoucher.id })
              .where(eq(customerOrderCharges.id, newCharge.id));
          });
        }
      }

      // Perpetual inventory (wave 8.4): the invoice journal follows the order.
      await db.transaction((tx) => syncFactoryInvoiceTx(tx, companyId, orderId));

      res.json({ ...updatedOrder, charges: updatedCharges, warning: chargeWarning });
    } catch (error: unknown) {
      logger.error("Error adding charge to order:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
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

        const [order] = await db
          .select()
          .from(customerOrders)
          .where(and(eq(customerOrders.id, orderId), eq(customerOrders.companyId, companyId)));
        if (!order) return res.status(404).json({ message: "Order not found" });
        if (order.status !== "FINALIZED") return res.status(400).json({ message: "Order is not finalized" });

        const [customer] = await db
          .select({ ledgerAccountId: customers.ledgerAccountId, legalName: customers.legalName })
          .from(customers)
          .where(eq(customers.id, order.customerId));

        // Auto-create and link a ledger account for the customer if one doesn't exist yet
        let customerLedgerAccountId = customer?.ledgerAccountId;
        if (!customerLedgerAccountId) {
          const customerName = customer?.legalName || `Customer ${order.customerId}`;
          customerLedgerAccountId = await getOrCreateLedgerAccount(
            companyId,
            `CUST-${order.customerId}`,
            customerName,
            "Asset"
          );
          await db
            .update(customers)
            .set({ ledgerAccountId: customerLedgerAccountId })
            .where(eq(customers.id, order.customerId));
        }

        // Find all charges missing a voucher
        const unlinkedCharges = await db
          .select()
          .from(customerOrderCharges)
          .where(and(eq(customerOrderCharges.orderId, orderId), isNull(customerOrderCharges.voucherId)));

        const actionableCharges = unlinkedCharges.filter((c) => toMoney(c.amount).greaterThan(0));
        if (actionableCharges.length === 0) {
          return res.json({ linked: 0, message: "All charges already have ledger entries — nothing to relink." });
        }

        // For charges without a ledgerAccountId, attempt to auto-match by name
        // (e.g. a charge named "Surcharge" matches a ledger account named "Surcharge")
        const allLedgerAccounts = await db
          .select({ id: ledgerAccounts.id, name: ledgerAccounts.name })
          .from(ledgerAccounts)
          .where(eq(ledgerAccounts.companyId, companyId));

        const resolvedCharges: Array<(typeof actionableCharges)[0] & { resolvedLedgerAccountId: number }> = [];
        const skipped: string[] = [];

        for (const charge of actionableCharges) {
          let resolvedId = charge.ledgerAccountId ?? null;
          if (!resolvedId && charge.name) {
            const match = allLedgerAccounts.find(
              (a) => a.name.trim().toLowerCase() === charge.name!.trim().toLowerCase()
            );
            if (match) {
              resolvedId = match.id;
              // Persist the resolved account so future relinks don't need to re-match
              await db
                .update(customerOrderCharges)
                .set({ ledgerAccountId: resolvedId })
                .where(eq(customerOrderCharges.id, charge.id));
            }
          }
          if (resolvedId) {
            resolvedCharges.push({ ...charge, resolvedLedgerAccountId: resolvedId });
          } else {
            skipped.push(charge.name || `#${charge.id}`);
          }
        }

        if (resolvedCharges.length === 0) {
          const skippedMsg = skipped.length
            ? ` Could not auto-match: ${skipped.join(", ")}. Link a ledger account to each charge first.`
            : "";
          return res.json({ linked: 0, message: `No charges could be linked.${skippedMsg}` });
        }

        const voucherRef = order.invoiceNumber || `ORD-${orderId}`;
        let linked = 0;

        for (const charge of resolvedCharges) {
          const chargeAmt = toMoney(charge.amount);
          const chargeVoucherNumber = `CHARGE-${voucherRef}-${charge.id}-${Date.now()}`;
          const chargeDesc = order.containerNumber
            ? `${charge.name} for offloaded container - ${order.containerNumber}`
            : `${charge.name} - ${voucherRef}`;

          await db.transaction(async (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => {
            const [chargeVoucher] = await tx
              .insert(vouchers)
              .values({
                companyId,
                voucherType: "Journal",
                voucherNumber: chargeVoucherNumber,
                voucherDate: order.orderDate || getClientDate(req),
                description: chargeDesc,
                totalAmount: moneyString(chargeAmt),
                sourceModule: "FACTORY",
              })
              .returning();
            await tx.insert(voucherEntries).values({
              voucherId: chargeVoucher.id,
              ledgerAccountId: customerLedgerAccountId,
              customerId: order.customerId,
              debitAmount: moneyString(chargeAmt),
              creditAmount: "0",
              narration: chargeDesc,
            });
            await tx.insert(voucherEntries).values({
              voucherId: chargeVoucher.id,
              ledgerAccountId: charge.resolvedLedgerAccountId,
              debitAmount: "0",
              creditAmount: moneyString(chargeAmt),
              narration: chargeDesc,
            });
            await tx
              .update(customerOrderCharges)
              .set({ voucherId: chargeVoucher.id })
              .where(eq(customerOrderCharges.id, charge.id));
          });
          linked++;
        }

        const skippedMsg = skipped.length
          ? ` ${skipped.length} skipped (no matching account): ${skipped.join(", ")}.`
          : "";
        res.json({
          linked,
          message: `${linked} charge${linked !== 1 ? "s" : ""} successfully linked to the ledger.${skippedMsg}`,
        });
      } catch (error: unknown) {
        logger.error("Error relinking charge vouchers:", { error: error });
        res.status(500).json({ message: getErrorMessage(error) });
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

      const [order] = await db
        .select()
        .from(customerOrders)
        .where(and(eq(customerOrders.id, orderId), eq(customerOrders.companyId, companyId)));
      if (!order) return res.status(404).json({ message: "Order not found" });

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

      // Read the charge BEFORE update so we have the voucherId
      const [chargeBeforeUpdate] = await db
        .select()
        .from(customerOrderCharges)
        .where(and(eq(customerOrderCharges.orderId, orderId), eq(customerOrderCharges.id, chargeId)));
      if (!chargeBeforeUpdate) return res.status(404).json({ message: "Charge not found" });

      await db.transaction(async (tx) => {
        await tx
          .update(customerOrderCharges)
          .set(updateData)
          .where(and(eq(customerOrderCharges.orderId, orderId), eq(customerOrderCharges.id, chargeId)));

        await recalculateOrderTotals(tx, orderId);

        // If amount is changing on a FINALIZED invoice with a linked voucher, sync the voucher entries
        if (amount !== undefined && order.status === "FINALIZED" && chargeBeforeUpdate.voucherId) {
          const newAmt = moneyString(newAmountCents);
          const linkedVoucherId = chargeBeforeUpdate.voucherId;

          // Update voucher header total
          await tx.update(vouchers).set({ totalAmount: newAmt }).where(eq(vouchers.id, linkedVoucherId));

          // Update the debit-side entry (customer account)
          await tx
            .update(voucherEntries)
            .set({ debitAmount: newAmt })
            .where(
              and(
                eq(voucherEntries.voucherId, linkedVoucherId),
                sql`cast(${voucherEntries.debitAmount} as numeric) > 0`
              )
            );

          // Update the credit-side entry (charge ledger account)
          await tx
            .update(voucherEntries)
            .set({ creditAmount: newAmt })
            .where(
              and(
                eq(voucherEntries.voucherId, linkedVoucherId),
                sql`cast(${voucherEntries.creditAmount} as numeric) > 0`
              )
            );
        }

        // PENDING_VERIFICATION / VERIFIED — update existing PRE-voucher amount on edit
        if (
          amount !== undefined &&
          ["PENDING_VERIFICATION", "VERIFIED"].includes(order.status) &&
          chargeBeforeUpdate.voucherId
        ) {
          const newAmt = moneyString(newAmountCents);
          const linkedVoucherId = chargeBeforeUpdate.voucherId;
          await tx.update(vouchers).set({ totalAmount: newAmt }).where(eq(vouchers.id, linkedVoucherId));
          await tx
            .update(voucherEntries)
            .set({ debitAmount: newAmt })
            .where(
              and(
                eq(voucherEntries.voucherId, linkedVoucherId),
                sql`cast(${voucherEntries.debitAmount} as numeric) > 0`
              )
            );
          await tx
            .update(voucherEntries)
            .set({ creditAmount: newAmt })
            .where(
              and(
                eq(voucherEntries.voucherId, linkedVoucherId),
                sql`cast(${voucherEntries.creditAmount} as numeric) > 0`
              )
            );
        }

        // If a ledger account is being assigned to a charge that has NO voucher yet,
        // create the accounting voucher retroactively now (handles old/legacy charges).
        const newLedgerAccountId = ledgerAccountId ? parseInt(ledgerAccountId) : null;
        if (
          newLedgerAccountId &&
          !chargeBeforeUpdate.voucherId &&
          ["PENDING_VERIFICATION", "VERIFIED", "FINALIZED"].includes(order.status)
        ) {
          const [updatedCharge] = await tx
            .select()
            .from(customerOrderCharges)
            .where(eq(customerOrderCharges.id, chargeId));
          const chargeAmt = updatedCharge?.amount
            ? toMoney(updatedCharge.amount)
            : (parseMoneyInput(String(amount)) ?? toMoney(0));
          if (chargeAmt.greaterThan(0)) {
            const [customer] = await tx
              .select({ ledgerAccountId: customers.ledgerAccountId })
              .from(customers)
              .where(eq(customers.id, order.customerId));
            if (customer?.ledgerAccountId) {
              const isFinalized = order.status === "FINALIZED";
              const voucherNum =
                isFinalized && order.invoiceNumber
                  ? `CHARGE-${order.invoiceNumber}-${chargeId}-${Date.now()}`
                  : `CHARGE-PRE-${orderId}-${chargeId}`;
              const chargeDesc = order.containerNumber
                ? `${updatedCharge?.name || "Charge"} for container - ${order.containerNumber}`
                : `${updatedCharge?.name || "Charge"} - Order #${orderId}`;
              const [chargeVoucher] = await tx
                .insert(vouchers)
                .values({
                  companyId,
                  voucherType: "Journal",
                  voucherNumber: voucherNum,
                  voucherDate: order.orderDate || getClientDate(req),
                  description: chargeDesc,
                  totalAmount: moneyString(chargeAmt),
                  sourceModule: "FACTORY",
                })
                .returning();
              await tx.insert(voucherEntries).values({
                voucherId: chargeVoucher.id,
                ledgerAccountId: customer.ledgerAccountId,
                customerId: order.customerId,
                debitAmount: moneyString(chargeAmt),
                creditAmount: "0",
                narration: chargeDesc,
              });
              await tx.insert(voucherEntries).values({
                voucherId: chargeVoucher.id,
                ledgerAccountId: newLedgerAccountId,
                debitAmount: "0",
                creditAmount: moneyString(chargeAmt),
                narration: chargeDesc,
              });
              await tx
                .update(customerOrderCharges)
                .set({ voucherId: chargeVoucher.id })
                .where(eq(customerOrderCharges.id, chargeId));
            }
          }
        }

        // If order is FINALIZED, sync customerBalances and daybook with new grand total
        if (order.status === "FINALIZED" && amount !== undefined) {
          const [recalcOrder] = await tx
            .select({ grandTotal: customerOrders.grandTotal })
            .from(customerOrders)
            .where(eq(customerOrders.id, orderId));
          const newGrandTotal = moneyString(recalcOrder?.grandTotal);

          const [existingLedgerEntry] = await tx
            .select({ id: customerBalances.id })
            .from(customerBalances)
            .where(
              and(
                eq(customerBalances.companyId, companyId),
                eq(customerBalances.referenceType, "INVOICE"),
                eq(customerBalances.referenceId, orderId)
              )
            );
          if (existingLedgerEntry) {
            await tx
              .update(customerBalances)
              .set({ debitAmount: newGrandTotal, balance: newGrandTotal })
              .where(eq(customerBalances.id, existingLedgerEntry.id));
          }

          const [daybookEntry] = await tx
            .select({ id: factoryDaybookEntries.id })
            .from(factoryDaybookEntries)
            .where(
              and(
                eq(factoryDaybookEntries.companyId, companyId),
                eq(factoryDaybookEntries.txType, "INVOICE"),
                eq(factoryDaybookEntries.referenceId, orderId)
              )
            );
          if (daybookEntry) {
            await tx
              .update(factoryDaybookEntries)
              .set({ amountCurrency: newGrandTotal, amountUsd: newGrandTotal })
              .where(eq(factoryDaybookEntries.id, daybookEntry.id));
          }
        }

        // Sync daybook ORDER_VERIFIED entry when charge amount edited on a VERIFIED order
        if (order.status === "VERIFIED" && amount !== undefined) {
          const [recalcOrder] = await tx
            .select({ grandTotal: customerOrders.grandTotal })
            .from(customerOrders)
            .where(eq(customerOrders.id, orderId));
          const newGrandTotal = moneyString(recalcOrder?.grandTotal);
          const [verifiedDaybookEntry] = await tx
            .select({ id: factoryDaybookEntries.id })
            .from(factoryDaybookEntries)
            .where(
              and(
                eq(factoryDaybookEntries.companyId, companyId),
                eq(factoryDaybookEntries.txType, "ORDER_VERIFIED"),
                eq(factoryDaybookEntries.referenceId, orderId)
              )
            );
          if (verifiedDaybookEntry) {
            await tx
              .update(factoryDaybookEntries)
              .set({ amountCurrency: newGrandTotal, amountUsd: newGrandTotal })
              .where(eq(factoryDaybookEntries.id, verifiedDaybookEntry.id));
          }
        }
      });

      const [updatedOrder] = await db.select().from(customerOrders).where(eq(customerOrders.id, orderId));
      const updatedCharges = await db
        .select()
        .from(customerOrderCharges)
        .where(eq(customerOrderCharges.orderId, orderId));

      // Perpetual inventory (wave 8.4): the invoice journal follows the order.
      await db.transaction((tx) => syncFactoryInvoiceTx(tx, companyId, orderId));

      res.json({ ...updatedOrder, charges: updatedCharges });
    } catch (error: unknown) {
      logger.error("[PATCH charge]", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
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

      const [order] = await db
        .select()
        .from(customerOrders)
        .where(and(eq(customerOrders.id, orderId), eq(customerOrders.companyId, companyId)));
      if (!order) return res.status(404).json({ message: "Order not found" });

      // Phase 6: read FK linkage BEFORE deleting the charge so we can drop the linked voucher precisely
      const [chargeRow] = await db
        .select({ voucherId: customerOrderCharges.voucherId })
        .from(customerOrderCharges)
        .where(and(eq(customerOrderCharges.orderId, orderId), eq(customerOrderCharges.id, chargeId)));
      const linkedVoucherId = chargeRow?.voucherId ?? null;

      await db
        .delete(customerOrderCharges)
        .where(and(eq(customerOrderCharges.orderId, orderId), eq(customerOrderCharges.id, chargeId)));

      await recalculateOrderTotals(db, orderId);

      const [updatedOrder] = await db.select().from(customerOrders).where(eq(customerOrders.id, orderId));
      const updatedCharges = await db
        .select()
        .from(customerOrderCharges)
        .where(eq(customerOrderCharges.orderId, orderId));

      // Phase 6: prefer FK-based delete; fall back to voucherNumber pattern for legacy unbacked rows
      let chargeVoucherIdsToDelete: number[] = [];
      if (linkedVoucherId) {
        chargeVoucherIdsToDelete.push(linkedVoucherId);
      } else {
        // Legacy fallback: PRE-voucher pattern + invoice-number pattern
        const legacyPatterns: string[] = [`CHARGE-PRE-${orderId}-${chargeId}`];
        if (order.invoiceNumber) legacyPatterns.push(`CHARGE-${order.invoiceNumber}-${chargeId}-%`);
        const legacyMatches = await db
          .select({ id: vouchers.id, voucherNumber: vouchers.voucherNumber })
          .from(vouchers)
          .where(
            and(
              eq(vouchers.companyId, companyId),
              sql`(${vouchers.voucherNumber} = ${legacyPatterns[0]}${
                legacyPatterns.length > 1 ? sql` OR ${vouchers.voucherNumber} LIKE ${legacyPatterns[1]}` : sql``
              })`
            )
          );
        chargeVoucherIdsToDelete = legacyMatches.map((v) => v.id);
      }

      if (chargeVoucherIdsToDelete.length > 0) {
        // Wave 16 (A): retired with their lines (they used to be stripped), audited.
        await db.transaction((tx) =>
          retireVouchersTx(tx, {
            companyId,
            voucherIds: chargeVoucherIdsToDelete,
            reason: "customer-order-charge-delete",
            actor: sessionRetirementActor(req),
          })
        );
      }

      // Sync customerBalances ledger entry if the order is already finalized
      if (updatedOrder.status === "FINALIZED") {
        const newGrandTotal = moneyString(updatedOrder.grandTotal);
        const [existingLedgerEntry] = await db
          .select({ id: customerBalances.id })
          .from(customerBalances)
          .where(
            and(
              eq(customerBalances.companyId, companyId),
              eq(customerBalances.referenceType, "INVOICE"),
              eq(customerBalances.referenceId, orderId)
            )
          );
        if (existingLedgerEntry) {
          await db
            .update(customerBalances)
            .set({ debitAmount: newGrandTotal, balance: newGrandTotal })
            .where(eq(customerBalances.id, existingLedgerEntry.id));
        }
      }

      // Sync daybook ORDER_VERIFIED entry when a charge is deleted from a VERIFIED order
      if (updatedOrder.status === "VERIFIED") {
        const newGrandTotal = moneyString(updatedOrder.grandTotal);
        const [verifiedDaybookEntry] = await db
          .select({ id: factoryDaybookEntries.id })
          .from(factoryDaybookEntries)
          .where(
            and(
              eq(factoryDaybookEntries.companyId, companyId),
              eq(factoryDaybookEntries.txType, "ORDER_VERIFIED"),
              eq(factoryDaybookEntries.referenceId, orderId)
            )
          );
        if (verifiedDaybookEntry) {
          await db
            .update(factoryDaybookEntries)
            .set({ amountCurrency: newGrandTotal, amountUsd: newGrandTotal })
            .where(eq(factoryDaybookEntries.id, verifiedDaybookEntry.id));
        }
      }

      // Perpetual inventory (wave 8.4): the invoice journal follows the order.
      await db.transaction((tx) => syncFactoryInvoiceTx(tx, companyId, orderId));

      res.json({ ...updatedOrder, charges: updatedCharges });
    } catch (error: unknown) {
      logger.error("Error removing charge from order:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Link a proforma to an existing unlinked LOADING order (V5 backfill support).
  // V5 guard: sets proforma_id_used and backfills customer_order_expected_lines.
  // Rules: order must be LOADING and currently unlinked (proforma_id_used IS NULL).
  //        proforma must be active and belong to the same company.
  //        customer must match if both order and proforma have a customer_id.
}
