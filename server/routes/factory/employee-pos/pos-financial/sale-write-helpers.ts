// Extracted from ./sale-write.ts
import type { Express, Request, Response } from "express";
import { logger } from "../../../../lib/logger";
import { db } from "../../../../db";
import { requireAuth } from "../../../../auth";
import {
  factoryBales,
  customerBalances,
  factoryDaybookEntries,
  factoryPosSales,
  factoryPosSaleItems,
} from "@shared/schema";
import { eq, and, desc, sql, inArray } from "drizzle-orm";
import { toMoney } from "../../../../lib/money";
import { postFactoryPosCogsTx } from "../../../../services/accounting/perpetualInventory/factoryPosCogs";
import {
  posSaleBalesCostTx,
  recordPosSaleBalesTx,
  releasePosSaleBalesTx,
} from "../../../../services/factory/factoryPosSaleBales";
import { postFactoryPosReceiptTx } from "../../../../services/accounting/factoryPosReceipt";
import { removeFactoryPosCustomerBalancesTx } from "./sale-financials";
import {
  postingInput,
  refusedSaleBodyId,
  saleAmounts,
  saleRateOrRefuse,
  sendSaleError,
  usdAtRate,
} from "./sale-writeSaleAmounts";

export function registerPosSaleWriteRoutesPart2(app: Express) {
  // PUT /api/factory/pos/sales/:id — edit an existing factory POS sale
  app.put("/api/factory/pos/sales/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const saleId = parseInt(req.params.id);

      const [existingSale] = await db
        .select()
        .from(factoryPosSales)
        .where(and(eq(factoryPosSales.id, saleId), eq(factoryPosSales.companyId, companyId)));
      if (!existingSale) return res.status(404).json({ message: "Sale not found" });
      if (existingSale.status === "VOIDED") return res.status(400).json({ message: "Cannot edit a voided sale" });

      const {
        locationId,
        customerName,
        customerId,
        notes,
        txDate,
        currencyCode,
        cashAccountId,
        paymentType,
        depositAmount,
        items,
        expenses,
      } = req.body;
      if (!items || !Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ message: "At least one item is required" });
      }

      const parsedCustomerId = customerId ? parseInt(customerId) : null;
      const amounts = saleAmounts({ paymentType, depositAmount, items, expenses });
      if (!amounts) return res.status(400).json({ message: "Invalid amount" });
      const { isCredit, depositAmt, lines, totalAmount, expenseRows, posting } = amounts;
      const refused = await refusedSaleBodyId(req.session, companyId, locationId, cashAccountId, expenseRows);
      if (refused) return res.status(400).json({ message: refused });
      const saleDate = String(txDate || existingSale.txDate);
      const rate = await saleRateOrRefuse(res, companyId, {
        customerId: parsedCustomerId,
        cashAccountId,
        currencyCode,
        saleDate,
        posting,
      });
      if (rate === null) return;

      const result = await db.transaction(async (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => {
        // Step 1: Restore the bales the sale took (wave 11: exactly those it
        // recorded; a sale from before the record falls back to the most recent
        // SOLD bales of each product at its location).
        const released = await releasePosSaleBalesTx(tx, companyId, saleId);
        const oldItems = await tx.select().from(factoryPosSaleItems).where(eq(factoryPosSaleItems.saleId, saleId));
        for (const oldItem of released.legacy ? oldItems : []) {
          if (oldItem.productId && existingSale.locationId) {
            const soldBales = await tx
              .select({ id: factoryBales.id })
              .from(factoryBales)
              .where(
                and(
                  eq(factoryBales.companyId, companyId),
                  eq(factoryBales.productId, oldItem.productId),
                  eq(factoryBales.erpLocationId, existingSale.locationId),
                  eq(factoryBales.status, "SOLD")
                )
              )
              .orderBy(desc(factoryBales.id))
              .limit(oldItem.quantity)
              .for("update");
            const baleIds = soldBales.map((b) => b.id);
            if (baleIds.length > 0) {
              await tx
                .update(factoryBales)
                .set({ status: "IN_STOCK", updatedAt: new Date() })
                .where(and(eq(factoryBales.companyId, companyId), inArray(factoryBales.id, baleIds)));
            }
          }
        }

        // Step 2: Delete old items
        await tx.delete(factoryPosSaleItems).where(eq(factoryPosSaleItems.saleId, saleId));

        // Step 3: Update sale record
        const [updatedSale] = await tx
          .update(factoryPosSales)
          .set({
            txDate: txDate || existingSale.txDate,
            locationId: locationId || null,
            customerName: customerName || null,
            customerId: parsedCustomerId,
            notes: notes || null,
            totalAmount: totalAmount.toFixed(2),
            currencyCode: currencyCode || "USD",
            cashAccountId: cashAccountId || null,
            paymentType: isCredit ? "CREDIT" : "CASH",
            depositAmount: isCredit ? depositAmt.toFixed(2) : "0",
            expensesJson: expenseRows.length > 0 ? JSON.stringify(expenseRows) : null,
          })
          .where(and(eq(factoryPosSales.id, saleId), eq(factoryPosSales.companyId, companyId)))
          .returning();

        const soldBaleIds: number[] = [];
        // Step 4: Insert new items and mark bales as SOLD
        for (const [index, item] of items.entries()) {
          const { qty, price } = lines[index];
          await tx.insert(factoryPosSaleItems).values({
            saleId,
            companyId,
            productId: item.productId || null,
            productName: item.productName,
            articleCode: item.articleCode || null,
            quantity: qty,
            unitPrice: price.toFixed(2),
            totalAmount: price.times(qty).toFixed(2),
            currencyCode: currencyCode || "USD",
          });

          if (item.productId && locationId) {
            const availableBales = await tx
              .select({ id: factoryBales.id })
              .from(factoryBales)
              .where(
                and(
                  eq(factoryBales.companyId, companyId),
                  eq(factoryBales.productId, item.productId),
                  eq(factoryBales.erpLocationId, locationId),
                  eq(factoryBales.status, "IN_STOCK")
                )
              )
              .orderBy(factoryBales.id)
              .limit(qty)
              .for("update");
            if (availableBales.length < qty) {
              throw new Error(
                `INSUFFICIENT_BALE_STOCK: requested ${qty} bale(s) of "${item.productName || item.articleCode || item.productId}" at this location, only ${availableBales.length} available`
              );
            }
            const baleIds = availableBales.map((b) => b.id);
            await tx
              .update(factoryBales)
              .set({ status: "SOLD", updatedAt: new Date() })
              .where(and(eq(factoryBales.companyId, companyId), inArray(factoryBales.id, baleIds)));
            soldBaleIds.push(...baleIds);
          }
        }

        // Step 5: Update factory daybook BALE_SALE entry and rebuild POS_EXPENSE entries
        await tx
          .update(factoryDaybookEntries)
          .set({
            currencyCode: currencyCode || "USD",
            amountCurrency: totalAmount.toFixed(2),
            fxRateToUsd: rate,
            amountUsd: usdAtRate(totalAmount, rate),
            txDate: txDate || existingSale.txDate,
            description: `Factory POS Sale ${existingSale.saleNumber}${customerName ? ` – ${customerName}` : ""}${isCredit ? " [CREDIT]" : ""}`,
          })
          .where(
            and(
              eq(factoryDaybookEntries.referenceTable, "factory_pos_sales"),
              eq(factoryDaybookEntries.referenceId, saleId),
              eq(factoryDaybookEntries.txType, "BALE_SALE")
            )
          );

        // Delete old expense daybook rows, then re-insert fresh ones
        await tx
          .delete(factoryDaybookEntries)
          .where(
            and(
              eq(factoryDaybookEntries.referenceTable, "factory_pos_sales"),
              eq(factoryDaybookEntries.referenceId, saleId),
              eq(factoryDaybookEntries.txType, "POS_EXPENSE")
            )
          );
        for (const exp of expenseRows) {
          await tx.insert(factoryDaybookEntries).values({
            companyId,
            txDate: txDate || existingSale.txDate,
            txType: "POS_EXPENSE",
            referenceId: saleId,
            referenceTable: "factory_pos_sales",
            description: `${exp.description || "Deduction"} – POS ${existingSale.saleNumber}${customerName ? ` (${customerName})` : ""}`,
            currencyCode: currencyCode || "USD",
            amountCurrency: exp.amount.toFixed(2),
            fxRateToUsd: rate,
            amountUsd: usdAtRate(exp.amount, rate),
          });
        }

        // Step 6: Replace customer balance entries. The old ones always go, so an
        // edit from credit to cash (or to another customer) leaves no stale debt.
        await removeFactoryPosCustomerBalancesTx(tx, companyId, saleId);
        if (isCredit && parsedCustomerId) {
          // Re-compute running balance and re-insert
          const [balRow] = await tx
            .select({ net: sql<string>`COALESCE(SUM(debit_amount::numeric - credit_amount::numeric), 0)` })
            .from(customerBalances)
            .where(and(eq(customerBalances.customerId, parsedCustomerId), eq(customerBalances.companyId, companyId)));
          const runningBefore = toMoney(balRow?.net);
          const balAfterSale = runningBefore.plus(totalAmount);
          await tx.insert(customerBalances).values({
            companyId,
            customerId: parsedCustomerId,
            transactionDate: txDate || existingSale.txDate,
            transactionType: "SALE",
            referenceId: saleId,
            referenceType: "FACTORY_POS_SALE",
            debitAmount: totalAmount.toFixed(2),
            creditAmount: "0",
            balance: balAfterSale.toFixed(2),
            currency: currencyCode || "USD",
            description: `POS Sale ${existingSale.saleNumber} (edited)`,
          });
          if (depositAmt > 0) {
            const balAfterDeposit = balAfterSale.minus(depositAmt);
            await tx.insert(customerBalances).values({
              companyId,
              customerId: parsedCustomerId,
              transactionDate: txDate || existingSale.txDate,
              transactionType: "PAYMENT",
              referenceId: saleId,
              referenceType: "FACTORY_POS_DEPOSIT",
              debitAmount: "0",
              creditAmount: depositAmt.toFixed(2),
              balance: balAfterDeposit.toFixed(2),
              currency: currencyCode || "USD",
              description: `Deposit on POS Sale ${existingSale.saleNumber} (edited)`,
            });
          }
        }

        // Step 7: Replace the sale's ledger voucher whole (the legacy
        // FPOS-{sale}-{timestamp} one included) with FPOS-RCPT-{sale}.
        await postFactoryPosReceiptTx(
          tx,
          postingInput(
            companyId,
            { id: saleId, saleNumber: existingSale.saleNumber, txDate: updatedSale.txDate },
            { customerName, currencyCode, cashAccountId },
            parsedCustomerId,
            rate,
            posting
          )
        );

        // The edited sale records the bales it now takes; its cost of sales is
        // their cost (perpetual inventory, wave 8.4).
        await recordPosSaleBalesTx(tx, companyId, saleId, soldBaleIds);
        await postFactoryPosCogsTx(tx, {
          companyId,
          saleId,
          voucherDate: String(updatedSale.txDate),
          cost: await posSaleBalesCostTx(tx, companyId, saleId),
        });

        return updatedSale;
      });

      res.json(result);
    } catch (error: unknown) {
      logger.error("Error editing factory POS sale:", { error: error });
      sendSaleError(res, error);
    }
  });
}
