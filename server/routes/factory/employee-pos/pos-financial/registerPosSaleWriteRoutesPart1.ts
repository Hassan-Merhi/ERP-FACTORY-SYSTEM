// Extracted from ./sale-write.ts to keep that module under the source-size cap.
import type { Express, Request, Response } from "express";
import { getClientDate } from "../../../../lib/dateUtils";
import { logger } from "../../../../lib/logger";
import { db } from "../../../../db";
import { requireAuth } from "../../../../auth";
import {
  financialOperationFingerprint,
  withDurableFinancialOperation,
} from "../../../../services/accounting/durableFinancialOperation";
import {
  financialOperationRequestPayload,
  resolveFinancialOperationKey,
} from "../../../../services/accounting/financialOperationRequest";
import {
  customerBalances,
  factoryBales,
  factoryDaybookEntries,
  factoryPosSaleItems,
  factoryPosSales,
} from "@shared/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import { toMoney } from "../../../../lib/money";
import { postFactoryPosCogsTx } from "../../../../services/accounting/perpetualInventory/factoryPosCogs";
import { posSaleBalesCostTx, recordPosSaleBalesTx } from "../../../../services/factory/factoryPosSaleBales";
import { postFactoryPosReceiptTx } from "../../../../services/accounting/factoryPosReceipt";
import {
  postingInput,
  refusedSaleBodyId,
  saleAmounts,
  saleRateOrRefuse,
  sendSaleError,
  usdAtRate,
} from "./sale-writeSaleAmounts";

export function registerPosSaleWriteRoutesPart1(app: Express) {
  // POST /api/factory/pos/sale — create a factory POS sale
  app.post("/api/factory/pos/sale", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      const rawUserId = req.session.userId;
      const userId: number | null = rawUserId && !isNaN(Number(rawUserId)) ? Number(rawUserId) : null;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

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

      // Validate item quantities against available stock
      for (const item of items) {
        if (!item.productId && !item.productName) return res.status(400).json({ message: "Each item needs a product" });
        if (!item.quantity || item.quantity <= 0) return res.status(400).json({ message: "Quantity must be positive" });
      }

      const parsedCustomerId = customerId ? parseInt(customerId) : null;
      // Expense deductions (optional array of {accountId, description, amount})
      const amounts = saleAmounts({ paymentType, depositAmount, items, expenses });
      if (!amounts) return res.status(400).json({ message: "Invalid amount" });
      const { isCredit, depositAmt, lines, totalAmount, expenseRows, posting } = amounts;
      const refused = await refusedSaleBodyId(req.session, companyId, locationId, cashAccountId, expenseRows);
      if (refused) return res.status(400).json({ message: refused });
      const saleDate = txDate || getClientDate(req);
      const rate = await saleRateOrRefuse(res, companyId, {
        customerId: parsedCustomerId,
        cashAccountId,
        currencyCode,
        saleDate,
        posting,
      });
      if (rate === null) return;

      // Generate sale number
      const [seqRow] = await db
        .select({ count: sql<number>`count(*)` })
        .from(factoryPosSales)
        .where(eq(factoryPosSales.companyId, companyId));
      const nextNum = (Number(seqRow?.count || 0) + 1).toString().padStart(4, "0");
      const saleNumber = `FPOS-${nextNum}`;

      const operationKey = resolveFinancialOperationKey(req);
      const operation = await withDurableFinancialOperation(
        {
          companyId: Number(companyId),
          operationName: "factory.pos-sale.create",
          idempotencyKey: operationKey,
          requestFingerprint: financialOperationFingerprint({
            method: req.method,
            path: req.path,
            companyId: Number(companyId),
            body: financialOperationRequestPayload(req.body),
          }),
        },
        async (tx) => {
          const soldBaleIds: number[] = [];
          // 1. Create sale record
          const [sale] = await tx
            .insert(factoryPosSales)
            .values({
              companyId,
              saleNumber,
              txDate: saleDate,
              locationId: locationId || null,
              customerName: customerName || null,
              customerId: parsedCustomerId,
              notes: notes || null,
              totalAmount: totalAmount.toFixed(2),
              currencyCode: currencyCode || "USD",
              cashAccountId: cashAccountId || null,
              paymentType: isCredit ? "CREDIT" : "CASH",
              depositAmount: isCredit ? depositAmt.toFixed(2) : "0",
              status: "COMPLETED",
              createdBy: userId === null ? null : String(userId),
              expensesJson: expenseRows.length > 0 ? JSON.stringify(expenseRows) : null,
            })
            .returning();

          // 2. Create sale items
          for (const [index, item] of items.entries()) {
            const { qty, price } = lines[index];
            await tx.insert(factoryPosSaleItems).values({
              saleId: sale.id,
              companyId,
              productId: item.productId || null,
              productName: item.productName,
              articleCode: item.articleCode || null,
              quantity: qty,
              unitPrice: price.toFixed(2),
              totalAmount: price.times(qty).toFixed(2),
              currencyCode: currencyCode || "USD",
            });

            // 3. Mark N bales as SOLD (pick oldest available by id).
            // FOR UPDATE serializes concurrent POS sales: a second sale that
            // tries to grab the same rows will block on the locked rows, then
            // re-evaluate the WHERE after the first transaction commits and
            // correctly skip the now-SOLD rows. If we cannot find as many
            // physical bales as the line item claims, abort the entire sale
            // so the customer is never billed for inventory that doesn't exist.
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

          // 4. Create daybook entry for the sale (USD at the sale-date factory rate)
          await tx.insert(factoryDaybookEntries).values({
            companyId,
            txDate: saleDate,
            txType: "BALE_SALE",
            referenceId: sale.id,
            referenceTable: "factory_pos_sales",
            description: `Factory POS Sale ${saleNumber}${customerName ? ` – ${customerName}` : ""}${isCredit ? " [CREDIT]" : ""}`,
            currencyCode: currencyCode || "USD",
            amountCurrency: totalAmount.toFixed(2),
            fxRateToUsd: rate,
            amountUsd: usdAtRate(totalAmount, rate),
            // factory_daybook_entries.created_by is a varchar column.
            createdBy: userId === null ? null : String(userId),
          });

          // 4b. Create daybook entries for each expense/deduction
          for (const exp of expenseRows) {
            await tx.insert(factoryDaybookEntries).values({
              companyId,
              txDate: saleDate,
              txType: "POS_EXPENSE",
              referenceId: sale.id,
              referenceTable: "factory_pos_sales",
              description: `${exp.description || "Deduction"} – POS ${saleNumber}${customerName ? ` (${customerName})` : ""}`,
              currencyCode: currencyCode || "USD",
              amountCurrency: exp.amount.toFixed(2),
              fxRateToUsd: rate,
              amountUsd: usdAtRate(exp.amount, rate),
              createdBy: userId === null ? null : String(userId),
            });
          }

          // 5a. CREDIT sale — update customer balance
          if (isCredit && parsedCustomerId) {
            // Compute current running balance for this customer
            const [balRow] = await tx
              .select({ net: sql<string>`COALESCE(SUM(debit_amount::numeric - credit_amount::numeric), 0)` })
              .from(customerBalances)
              .where(and(eq(customerBalances.customerId, parsedCustomerId), eq(customerBalances.companyId, companyId)));
            const runningBefore = toMoney(balRow?.net);

            // DR customer for full sale amount
            const balAfterSale = runningBefore.plus(totalAmount);
            await tx.insert(customerBalances).values({
              companyId,
              customerId: parsedCustomerId,
              transactionDate: saleDate,
              transactionType: "SALE",
              referenceId: sale.id,
              referenceType: "FACTORY_POS_SALE",
              debitAmount: totalAmount.toFixed(2),
              creditAmount: "0",
              balance: balAfterSale.toFixed(2),
              currency: currencyCode || "USD",
              description: `POS Sale ${saleNumber}`,
            });

            // CR customer for any deposit received
            if (depositAmt > 0) {
              const balAfterDeposit = balAfterSale.minus(depositAmt);
              await tx.insert(customerBalances).values({
                companyId,
                customerId: parsedCustomerId,
                transactionDate: saleDate,
                transactionType: "PAYMENT",
                referenceId: sale.id,
                referenceType: "FACTORY_POS_DEPOSIT",
                debitAmount: "0",
                creditAmount: depositAmt.toFixed(2),
                balance: balAfterDeposit.toFixed(2),
                currency: currencyCode || "USD",
                description: `Deposit on POS Sale ${saleNumber}`,
              });
            }
          }

          // 5b. The sale's ledger voucher FPOS-RCPT-{sale} (wave 8.4 continuation):
          // Cr sales income for the full sale; Dr cash for what was received less
          // the deductions, Dr each deduction, Dr the customer's ledger for the
          // unpaid part of a credit sale; normalized at the sale-date rate.
          await postFactoryPosReceiptTx(
            tx,
            postingInput(
              companyId,
              sale,
              { customerName, currencyCode, cashAccountId },
              parsedCustomerId,
              rate,
              posting
            )
          );

          // Wave 11: the sale records the bales it took, so a void or an edit puts
          // back exactly those; its cost of sales is their cost (wave 8.4 journal).
          await recordPosSaleBalesTx(tx, companyId, sale.id, soldBaleIds);
          await postFactoryPosCogsTx(tx, {
            companyId,
            saleId: sale.id,
            voucherDate: String(sale.txDate),
            cost: await posSaleBalesCostTx(tx, companyId, sale.id),
          });

          return { value: sale, resultReference: sale.id };
        }
      );

      res.json(operation.value);
    } catch (error: unknown) {
      logger.error("Error creating factory POS sale:", { error: error });
      sendSaleError(res, error);
    }
  });
}
