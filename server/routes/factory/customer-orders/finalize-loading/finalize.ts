/**
 * orderFinalizeLoadingRoutes: OrderFinalize endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../../lib/httpHandlers";
import { logger } from "../../../../lib/logger";
import { parseId } from "../../../../lib/parseId";
import { dispatchNotification } from "../../../../lib/notificationService";
import { getClientDate } from "../../../../lib/dateUtils";
import { db } from "../../../../db";
import { requireAuth } from "../../../../auth";
import { writeDaybookEntry, recalculateOrderTotals } from "../../_helpers";
import {
  factoryBales,
  customerOrders,
  customerOrderLines,
  customerOrderBales,
  customerOrderCharges,
  customerInvoiceSequences,
  customerBalances,
  customers,
  voucherEntries,
  locations,
  factoryDaybookEntries,
  vouchers,
} from "@shared/schema";
import { eq, and, sql, inArray } from "drizzle-orm";
import { firstRow } from "../../../../lib/queryResult";

export function registerOrderFinalizeRoutes(app: Express) {
  app.post("/api/factory/customer-orders/:id/finalize", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const orderId = parseId(req.params.id);

      if (orderId === null) return res.status(400).json({ message: "Invalid id" });

      const result = await db.transaction(async (tx) => {
        const [order] = await tx
          .select()
          .from(customerOrders)
          .where(and(eq(customerOrders.id, orderId), eq(customerOrders.companyId, companyId)));
        if (!order) throw new Error("Order not found");
        if (!["DRAFT", "VERIFIED"].includes(order.status))
          throw new Error("Only DRAFT or VERIFIED orders can be finalized");

        const bales = await tx.select().from(customerOrderBales).where(eq(customerOrderBales.orderId, orderId));
        if (bales.length === 0) throw new Error("Order has no bales");

        // Validate every linked bale with one set-based read instead of one query
        // per bale. Preserve the existing rule: only missing/DELETED bales block
        // finalization; other statuses are accepted here.
        const baleIds: number[] = [
          ...new Set<number>(
            bales
              .map((b: { baleId: number | null }) => Number(b.baleId))
              .filter((id: number) => Number.isSafeInteger(id) && id > 0)
          ),
        ];
        const factoryBaleRows =
          baleIds.length > 0
            ? await tx
                .select({ id: factoryBales.id, status: factoryBales.status })
                .from(factoryBales)
                .where(and(eq(factoryBales.companyId, companyId), inArray(factoryBales.id, baleIds)))
            : [];
        const factoryBaleById = new Map<number, { id: number; status: string | null }>(
          factoryBaleRows.map((b: { id: number; status: string | null }) => [
            Number(b.id),
            { id: Number(b.id), status: b.status ?? null },
          ])
        );

        for (const b of bales) {
          const factoryBale = factoryBaleById.get(Number(b.baleId));
          if (!factoryBale || factoryBale.status === "DELETED") {
            throw new Error(`Bale ${b.baleReference} is no longer available`);
          }
        }

        const seqRows = await tx.execute(
          sql`SELECT * FROM customer_invoice_sequences WHERE company_id = ${companyId} FOR UPDATE`
        );
        // The raw row is snake_case; the insert fallback returns the camelCase column.
        let seqRow = firstRow<{ next_number: number }>(seqRows) as
          { next_number: number; nextNumber?: number } | undefined;
        if (!seqRow) {
          const [inserted] = await tx.insert(customerInvoiceSequences).values({ companyId, nextNumber: 1 }).returning();
          seqRow = { next_number: inserted.nextNumber, nextNumber: inserted.nextNumber };
        }
        const invoiceNum = seqRow.nextNumber || seqRow.next_number;
        await tx
          .update(customerInvoiceSequences)
          .set({ nextNumber: invoiceNum + 1 })
          .where(eq(customerInvoiceSequences.companyId, companyId));
        const invoiceNumber = `INV-${String(invoiceNum).padStart(6, "0")}`;

        // One set-based status write replaces the previous per-bale UPDATE loop.
        if (baleIds.length > 0) {
          await tx
            .update(factoryBales)
            .set({ status: "SOLD", updatedAt: new Date() })
            .where(and(eq(factoryBales.companyId, companyId), inArray(factoryBales.id, baleIds)));
        }

        await recalculateOrderTotals(tx, orderId);

        const [recalcOrder] = await tx.select().from(customerOrders).where(eq(customerOrders.id, orderId));

        const finalizedAt = new Date();

        await tx
          .update(customerOrders)
          .set({
            invoiceNumber,
            status: "FINALIZED",
            finalizedAt,
            updatedAt: finalizedAt,
          })
          .where(eq(customerOrders.id, orderId));

        const grandTotal = parseFloat(recalcOrder.grandTotal || "0");
        // Use the client's current date (finalization date) as the statement date,
        // not the orderDate (which is the loading/shipment date).
        const today = getClientDate(req);

        await tx.insert(customerBalances).values({
          companyId,
          customerId: order.customerId,
          transactionDate: today,
          transactionType: "SALE",
          debitAmount: String(grandTotal),
          creditAmount: "0",
          balance: String(grandTotal),
          referenceType: "INVOICE",
          referenceId: order.id,
          description: `Invoice ${invoiceNumber}`,
          currency: "USD",
        });

        // Create journal entries for charges that have a ledgerAccountId.
        // If a PRE-voucher was already created when the charge was added in PENDING/VERIFIED
        // state, rename it to the invoice-based number and update its description.
        // Otherwise create a new voucher. This prevents double-counting.
        const chargesForJournal = await tx
          .select()
          .from(customerOrderCharges)
          .where(
            and(eq(customerOrderCharges.orderId, orderId), sql`${customerOrderCharges.ledgerAccountId} IS NOT NULL`)
          );

        if (chargesForJournal.length > 0) {
          const [customer] = await tx.select().from(customers).where(eq(customers.id, order.customerId));
          if (customer?.ledgerAccountId) {
            for (const charge of chargesForJournal) {
              const chargeAmount = parseFloat(charge.amount || "0");
              if (chargeAmount <= 0) continue;

              const invoiceVoucherNumber = `CHARGE-${invoiceNumber}-${charge.id}-${Date.now()}`;
              const chargeDesc = order.containerNumber
                ? `${charge.name} for offloaded container - ${order.containerNumber}`
                : `${charge.name} - ${invoiceNumber}`;

              // Check for a PRE-voucher created when the charge was saved in pending/verified state
              const preVoucherNumber = `CHARGE-PRE-${orderId}-${charge.id}`;
              const [preVoucher] = await tx
                .select({ id: vouchers.id })
                .from(vouchers)
                .where(and(eq(vouchers.companyId, companyId), eq(vouchers.voucherNumber, preVoucherNumber)));

              if (preVoucher) {
                // Rename the PRE-voucher — same entries already exist, just update the reference
                await tx
                  .update(vouchers)
                  .set({ voucherNumber: invoiceVoucherNumber, voucherDate: today, description: chargeDesc })
                  .where(eq(vouchers.id, preVoucher.id));
                await tx
                  .update(voucherEntries)
                  .set({ narration: chargeDesc })
                  .where(eq(voucherEntries.voucherId, preVoucher.id));
                // Phase 6: ensure the charge.voucherId FK points at the renamed voucher
                // (it should already, from the PRE-create stamp, but stay defensive for legacy data)
                await tx
                  .update(customerOrderCharges)
                  .set({ voucherId: preVoucher.id })
                  .where(eq(customerOrderCharges.id, charge.id));
              } else {
                // No PRE-voucher — charge was added before this feature or on a DRAFT order
                const [chargeVoucher] = await tx
                  .insert(vouchers)
                  .values({
                    companyId,
                    voucherType: "Journal",
                    voucherNumber: invoiceVoucherNumber,
                    voucherDate: today,
                    description: chargeDesc,
                    totalAmount: String(chargeAmount),
                    sourceModule: "FACTORY",
                  })
                  .returning();
                // Dr Customer Account (charge billed to customer)
                await tx.insert(voucherEntries).values({
                  voucherId: chargeVoucher.id,
                  ledgerAccountId: customer.ledgerAccountId,
                  customerId: order.customerId,
                  debitAmount: String(chargeAmount),
                  creditAmount: "0",
                  narration: chargeDesc,
                });
                // Cr Charge Account (freight/other charges income account)
                await tx.insert(voucherEntries).values({
                  voucherId: chargeVoucher.id,
                  ledgerAccountId: charge.ledgerAccountId!,
                  debitAmount: "0",
                  creditAmount: String(chargeAmount),
                  narration: chargeDesc,
                });
                // Phase 6: stamp FK
                await tx
                  .update(customerOrderCharges)
                  .set({ voucherId: chargeVoucher.id })
                  .where(eq(customerOrderCharges.id, charge.id));
              }
            }
          }
        }

        const [finalOrder] = await tx
          .select({
            id: customerOrders.id,
            companyId: customerOrders.companyId,
            customerId: customerOrders.customerId,
            invoiceNumber: customerOrders.invoiceNumber,
            orderDate: customerOrders.orderDate,
            proformaIdUsed: customerOrders.proformaIdUsed,
            status: customerOrders.status,
            subtotalBales: customerOrders.subtotalBales,
            freightAmount: customerOrders.freightAmount,
            otherChargesTotal: customerOrders.otherChargesTotal,
            grandTotal: customerOrders.grandTotal,
            totalQtyBales: customerOrders.totalQtyBales,
            createdAt: customerOrders.createdAt,
            updatedAt: customerOrders.updatedAt,
            customerName: customers.legalName,
          })
          .from(customerOrders)
          .leftJoin(customers, eq(customerOrders.customerId, customers.id))
          .where(eq(customerOrders.id, orderId));

        const finalLines = await tx.select().from(customerOrderLines).where(eq(customerOrderLines.orderId, orderId));
        const finalBales = await tx.select().from(customerOrderBales).where(eq(customerOrderBales.orderId, orderId));
        const finalCharges = await tx
          .select()
          .from(customerOrderCharges)
          .where(eq(customerOrderCharges.orderId, orderId));

        return { ...finalOrder, lines: finalLines, bales: finalBales, charges: finalCharges };
      });

      const today = req.body.txDate || req.body.invoiceDate || getClientDate(req);
      // The transaction result spreads a customer_orders row, which keys the order
      // by `id`; the old `result.orderId` lookup was always undefined.
      const invoiceRefId = orderId;
      // Remove any previous INVOICE and INVOICE_REVERTED rows so only this approval shows
      await db
        .delete(factoryDaybookEntries)
        .where(
          and(
            eq(factoryDaybookEntries.companyId, companyId),
            sql`${factoryDaybookEntries.txType} IN ('INVOICE','INVOICE_REVERTED')`,
            eq(factoryDaybookEntries.referenceId, invoiceRefId)
          )
        );
      await writeDaybookEntry(db, {
        companyId,
        txDate: today,
        txType: "INVOICE",
        referenceId: invoiceRefId,
        referenceTable: "customer_orders",
        description: `Invoice ${result.invoiceNumber} – ${result.customerName || "Customer"}`,
        amountCurrency: parseFloat(result.grandTotal || "0"),
        amountUsd: parseFloat(result.grandTotal || "0"),
      });

      dispatchNotification({
        eventType: "INVOICE_FINALIZED",
        title: "Invoice Finalized",
        message: `Invoice ${result.invoiceNumber} finalized for ${result.customerName || "customer"}`,
        entityType: "customer_order",
        entityId: result.id,
        triggeredByUserId: req.session?.userId ?? null,
        companyId: result.companyId ?? companyId,
      }).catch(() => {});

      res.json(result);
    } catch (error: unknown) {
      logger.error("Error finalizing order:", { error: error });
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/factory/customer-orders/:id/finalize-preview", requireAuth, async (req: Request, res: Response) => {
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

      const orderBales = await db.select().from(customerOrderBales).where(eq(customerOrderBales.orderId, orderId));
      if (orderBales.length === 0) return res.json({ baleCount: 0, bales: [] });

      const baleIds = orderBales.map((b) => b.baleId);
      const baleRows = await db
        .select({
          id: factoryBales.id,
          referenceNumber: factoryBales.referenceNumber,
          productName: factoryBales.productName,
          weightKg: factoryBales.weightKg,
          status: factoryBales.status,
          erpLocationId: factoryBales.erpLocationId,
        })
        .from(factoryBales)
        .where(inArray(factoryBales.id, baleIds));

      const locIds = [...new Set(baleRows.map((b) => b.erpLocationId).filter(Boolean))];
      const locationRecords =
        locIds.length > 0
          ? await db
              .select()
              .from(locations)
              .where(inArray(locations.id, locIds as number[]))
          : [];
      const locationMap = new Map(locationRecords.map((l) => [l.id, l.name]));

      const availableBales = baleRows.filter((b: { status: string }) =>
        ["IN_STOCK", "RESERVED_FOR_ORDER"].includes(b.status)
      );

      res.json({
        baleCount: availableBales.length,
        totalBalesInOrder: orderBales.length,
        bales: availableBales.map(
          (b: {
            id: number;
            referenceNumber: string;
            productName: string | null;
            weightKg: string;
            status: string;
            erpLocationId: number | null;
          }) => ({
            id: b.id,
            baleReference: b.referenceNumber,
            productName: b.productName,
            weightKg: parseFloat(b.weightKg || "0"),
            locationName: (b.erpLocationId != null ? locationMap.get(b.erpLocationId) : undefined) || "Unknown",
            status: b.status,
          })
        ),
      });
    } catch (error: unknown) {
      logger.error("Error fetching finalize preview:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
