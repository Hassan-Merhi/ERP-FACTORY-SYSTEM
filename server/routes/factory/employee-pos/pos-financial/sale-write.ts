/**
 * employeePosFinancialRoutes: PosSaleWrite endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getClientDate } from "../../../../lib/dateUtils";
import { getErrorMessage } from "../../../../lib/httpHandlers";
import { logger } from "../../../../lib/logger";
import { db } from "../../../../db";
import { requireAuth } from "../../../../auth";
import { getOrCreateLedgerAccount } from "../../_helpers";
import {
  financialOperationFingerprint,
  withDurableFinancialOperation,
} from "../../../../services/accounting/durableFinancialOperation";
import {
  financialOperationRequestPayload,
  resolveFinancialOperationKey,
} from "../../../../services/accounting/financialOperationRequest";
import {
  factoryBales,
  customerBalances,
  voucherEntries,
  factoryDaybookEntries,
  vouchers,
  factoryPosSales,
  factoryPosSaleItems,
} from "@shared/schema";
import { eq, and, or, desc, sql, inArray } from "drizzle-orm";

export function registerPosSaleWriteRoutes(app: Express) {
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

      const isCredit = (paymentType || "CASH") === "CREDIT";
      const parsedCustomerId = customerId ? parseInt(customerId) : null;
      const depositAmt = isCredit ? Math.max(0, parseFloat(depositAmount || "0")) : 0;

      const totalAmount = items.reduce(
        (s: number, it) => s + parseFloat(it.unitPrice || "0") * parseInt(it.quantity || "1"),
        0
      );

      // Expense deductions (optional array of {accountId, description, amount})
      const expenseRows: Array<{ accountId: number; description: string; amount: number }> = [];
      if (Array.isArray(expenses)) {
        for (const exp of expenses) {
          const amt = parseFloat(exp.amount || "0");
          if (amt > 0 && exp.accountId) {
            expenseRows.push({ accountId: parseInt(exp.accountId), description: exp.description || "", amount: amt });
          }
        }
      }
      const totalExpenses = expenseRows.reduce((s, e) => s + e.amount, 0);
      // For cash: netCash = total - expenses. For credit: deposit may come in as cash.
      const netCash = isCredit ? depositAmt - totalExpenses : totalAmount - totalExpenses;

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
          // 1. Create sale record
          const [sale] = await tx
            .insert(factoryPosSales)
            .values({
              companyId,
              saleNumber,
              txDate: txDate || getClientDate(req),
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
          for (const item of items) {
            const qty = parseInt(item.quantity || "1");
            const price = parseFloat(item.unitPrice || "0");
            await tx.insert(factoryPosSaleItems).values({
              saleId: sale.id,
              companyId,
              productId: item.productId || null,
              productName: item.productName,
              articleCode: item.articleCode || null,
              quantity: qty,
              unitPrice: price.toFixed(2),
              totalAmount: (price * qty).toFixed(2),
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
            }
          }

          // 4. Create daybook entry for the sale
          await tx.insert(factoryDaybookEntries).values({
            companyId,
            txDate: txDate || getClientDate(req),
            txType: "BALE_SALE",
            referenceId: sale.id,
            referenceTable: "factory_pos_sales",
            description: `Factory POS Sale ${saleNumber}${customerName ? ` – ${customerName}` : ""}${isCredit ? " [CREDIT]" : ""}`,
            currencyCode: currencyCode || "USD",
            amountCurrency: totalAmount.toFixed(2),
            fxRateToUsd: "1",
            amountUsd: totalAmount.toFixed(2),
            // factory_daybook_entries.created_by is a varchar column.
            createdBy: userId === null ? null : String(userId),
          });

          // 4b. Create daybook entries for each expense/deduction
          for (const exp of expenseRows) {
            await tx.insert(factoryDaybookEntries).values({
              companyId,
              txDate: txDate || getClientDate(req),
              txType: "POS_EXPENSE",
              referenceId: sale.id,
              referenceTable: "factory_pos_sales",
              description: `${exp.description || "Deduction"} – POS ${saleNumber}${customerName ? ` (${customerName})` : ""}`,
              currencyCode: currencyCode || "USD",
              amountCurrency: exp.amount.toFixed(2),
              fxRateToUsd: "1",
              amountUsd: exp.amount.toFixed(2),
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
            const runningBefore = parseFloat(balRow?.net || "0");

            // DR customer for full sale amount
            const balAfterSale = runningBefore + totalAmount;
            await tx.insert(customerBalances).values({
              companyId,
              customerId: parsedCustomerId,
              transactionDate: txDate || getClientDate(req),
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
              const balAfterDeposit = balAfterSale - depositAmt;
              await tx.insert(customerBalances).values({
                companyId,
                customerId: parsedCustomerId,
                transactionDate: txDate || getClientDate(req),
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

          // 5b. Cash receipt ERP voucher
          // For cash sales: full amount. For credit sales with deposit: deposit only.
          const voucherCashAmt = isCredit ? depositAmt : totalAmount;
          if (cashAccountId && voucherCashAmt > 0) {
            const voucherNum = `FPOS-${sale.id}-${Date.now()}`;
            const [vch] = await tx
              .insert(vouchers)
              .values({
                companyId,
                voucherType: "Receipt",
                voucherNumber: voucherNum,
                voucherDate: txDate || getClientDate(req),
                description: `Factory POS Sale ${saleNumber}${customerName ? ` – ${customerName}` : ""}`,
                totalAmount: voucherCashAmt.toFixed(2),
                currency: currencyCode || "USD",
                exchangeRate: "1",
                sourceModule: "FACTORY_POS",
              })
              .returning();
            // DR Cash (net of deposit after expense deductions)
            const netDeposit = Math.max(0, netCash);
            if (netDeposit > 0) {
              await tx.insert(voucherEntries).values({
                voucherId: vch.id,
                ledgerAccountId: cashAccountId,
                debitAmount: netDeposit.toFixed(2),
                creditAmount: "0",
                narration: isCredit
                  ? `Deposit on credit sale – ${saleNumber}`
                  : `Factory POS cash receipt – ${saleNumber}`,
              });
            }
            // DR each expense account
            for (const exp of expenseRows) {
              await tx.insert(voucherEntries).values({
                voucherId: vch.id,
                ledgerAccountId: exp.accountId,
                debitAmount: exp.amount.toFixed(2),
                creditAmount: "0",
                narration: exp.description || `POS deduction – ${saleNumber}`,
              });
            }
            // CR Factory Sales Income (gross amount entering cash)
            const salesIncomeAccId = await getOrCreateLedgerAccount(
              companyId,
              "FACTORY_BALE_SALES_INCOME",
              "Factory Bale Sales Income",
              "Revenue"
            );
            await tx.insert(voucherEntries).values({
              voucherId: vch.id,
              ledgerAccountId: salesIncomeAccId,
              debitAmount: "0",
              creditAmount: voucherCashAmt.toFixed(2),
              narration: `Factory POS sales income – ${saleNumber}`,
            });
          }

          return { value: sale, resultReference: sale.id };
        }
      );

      res.json(operation.value);
    } catch (error: unknown) {
      logger.error("Error creating factory POS sale:", { error: error });
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

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

      const isCredit = (paymentType || "CASH") === "CREDIT";
      const parsedCustomerId = customerId ? parseInt(customerId) : null;
      const depositAmt = isCredit ? Math.max(0, parseFloat(depositAmount || "0")) : 0;
      const totalAmount = items.reduce(
        (s: number, it) => s + parseFloat(it.unitPrice || "0") * parseInt(it.quantity || "1"),
        0
      );

      const expenseRows: Array<{ accountId: number; description: string; amount: number }> = [];
      if (Array.isArray(expenses)) {
        for (const exp of expenses) {
          const amt = parseFloat(exp.amount || "0");
          if (amt > 0 && exp.accountId) {
            expenseRows.push({ accountId: parseInt(exp.accountId), description: exp.description || "", amount: amt });
          }
        }
      }
      const totalExpenses = expenseRows.reduce((s, e) => s + e.amount, 0);
      const netCash = isCredit ? depositAmt - totalExpenses : totalAmount - totalExpenses;

      const result = await db.transaction(async (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => {
        // Step 1: Restore bales for old items
        const oldItems = await tx.select().from(factoryPosSaleItems).where(eq(factoryPosSaleItems.saleId, saleId));
        for (const oldItem of oldItems) {
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

        // Step 4: Insert new items and mark bales as SOLD
        for (const item of items) {
          const qty = parseInt(item.quantity || "1");
          const price = parseFloat(item.unitPrice || "0");
          await tx.insert(factoryPosSaleItems).values({
            saleId,
            companyId,
            productId: item.productId || null,
            productName: item.productName,
            articleCode: item.articleCode || null,
            quantity: qty,
            unitPrice: price.toFixed(2),
            totalAmount: (price * qty).toFixed(2),
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
          }
        }

        // Step 5: Update factory daybook BALE_SALE entry and rebuild POS_EXPENSE entries
        await tx
          .update(factoryDaybookEntries)
          .set({
            amountCurrency: totalAmount.toFixed(2),
            amountUsd: totalAmount.toFixed(2),
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
            fxRateToUsd: "1",
            amountUsd: exp.amount.toFixed(2),
          });
        }

        // Step 6: Update customer balance entries if applicable
        if (isCredit && parsedCustomerId) {
          // Remove old SALE and DEPOSIT balance entries for this sale
          await tx
            .delete(customerBalances)
            .where(
              and(
                eq(customerBalances.referenceId, saleId),
                eq(customerBalances.companyId, companyId),
                or(
                  eq(customerBalances.referenceType, "FACTORY_POS_SALE"),
                  eq(customerBalances.referenceType, "FACTORY_POS_DEPOSIT")
                )
              )
            );

          // Re-compute running balance and re-insert
          const [balRow] = await tx
            .select({ net: sql<string>`COALESCE(SUM(debit_amount::numeric - credit_amount::numeric), 0)` })
            .from(customerBalances)
            .where(and(eq(customerBalances.customerId, parsedCustomerId), eq(customerBalances.companyId, companyId)));
          const runningBefore = parseFloat(balRow?.net || "0");
          const balAfterSale = runningBefore + totalAmount;
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
            const balAfterDeposit = balAfterSale - depositAmt;
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

        // Step 7: Update the ERP receipt voucher if it exists
        const existingVouchers = await tx
          .select()
          .from(vouchers)
          .where(
            and(
              eq(vouchers.companyId, companyId),
              eq(vouchers.sourceModule, "FACTORY_POS"),
              sql`voucher_number LIKE ${"FPOS-" + saleId + "-%"}`
            )
          );
        if (existingVouchers.length > 0) {
          const vchId = existingVouchers[0].id;
          const voucherCashAmt = isCredit ? depositAmt : totalAmount;
          if (cashAccountId && voucherCashAmt > 0) {
            await tx
              .update(vouchers)
              .set({
                voucherDate: txDate || existingSale.txDate,
                description: `Factory POS Sale ${existingSale.saleNumber}${customerName ? ` – ${customerName}` : ""}`,
                totalAmount: voucherCashAmt.toFixed(2),
                currency: currencyCode || "USD",
              })
              .where(eq(vouchers.id, vchId));

            // Replace voucher entries
            await tx.delete(voucherEntries).where(eq(voucherEntries.voucherId, vchId));
            const netDeposit = Math.max(0, netCash);
            if (netDeposit > 0) {
              await tx.insert(voucherEntries).values({
                voucherId: vchId,
                ledgerAccountId: parseInt(cashAccountId),
                debitAmount: netDeposit.toFixed(2),
                creditAmount: "0",
                narration: isCredit
                  ? `Deposit on credit sale – ${existingSale.saleNumber}`
                  : `Factory POS cash receipt – ${existingSale.saleNumber}`,
              });
            }
            for (const exp of expenseRows) {
              await tx.insert(voucherEntries).values({
                voucherId: vchId,
                ledgerAccountId: exp.accountId,
                debitAmount: exp.amount.toFixed(2),
                creditAmount: "0",
                narration: exp.description || `POS deduction – ${existingSale.saleNumber}`,
              });
            }
            const salesIncomeAccId = await getOrCreateLedgerAccount(
              companyId,
              "FACTORY_BALE_SALES_INCOME",
              "Factory Bale Sales Income",
              "Revenue"
            );
            await tx.insert(voucherEntries).values({
              voucherId: vchId,
              ledgerAccountId: salesIncomeAccId,
              debitAmount: "0",
              creditAmount: voucherCashAmt.toFixed(2),
              narration: `Factory POS sales income – ${existingSale.saleNumber}`,
            });
          }
        }

        return updatedSale;
      });

      res.json(result);
    } catch (error: unknown) {
      logger.error("Error editing factory POS sale:", { error: error });
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });
}
