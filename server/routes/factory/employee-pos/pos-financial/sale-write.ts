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
  factoryDaybookEntries,
  factoryPosSales,
  factoryPosSaleItems,
} from "@shared/schema";
import { eq, and, or, desc, sql, inArray } from "drizzle-orm";
import { MoneyDecimal, parseMoneyInput, sumMoney, toMoney } from "../../../../lib/money";
import { postFactoryPosCogsTx } from "../../../../services/accounting/perpetualInventory/factoryPosCogs";
import {
  posSaleBalesCostTx,
  recordPosSaleBalesTx,
  releasePosSaleBalesTx,
} from "../../../../services/factory/factoryPosSaleBales";
import {
  allLedgerAccountsOwned,
  isCompanyCustomerOrAbsent,
  isFactorySessionLocation,
} from "../../../helpers/companyOwnership";
import {
  FactoryPosSaleRefusalError,
  factoryPosSaleRate,
  factoryPosSaleRefusal,
  postFactoryPosReceiptTx,
  type FactoryPosSaleAmounts,
} from "../../../../services/accounting/factoryPosReceipt";

/** A request amount at cents, read as parseFloat reads it; blank is zero, anything else unparsable is null. */
function requestCents(value: unknown) {
  if (value === undefined || value === null || value === "") return new MoneyDecimal(0);
  return parseMoneyInput(value)?.toDecimalPlaces(2) ?? null;
}

/**
 * A POS sale's amounts at cents. Unit prices, the deposit and each expense are
 * rounded first and everything else is derived from them, so the stored lines
 * add up to the sale total and the receipt voucher's legs balance. Null when
 * an amount does not parse (it used to be written as NaN).
 */
function saleAmounts(body: {
  paymentType?: string;
  depositAmount?: unknown;
  items: Array<{ unitPrice?: unknown; quantity?: unknown }>;
  expenses?: unknown;
}) {
  const isCredit = (body.paymentType || "CASH") === "CREDIT";
  const deposit = isCredit ? requestCents(body.depositAmount) : new MoneyDecimal(0);
  if (!deposit) return null;
  const lines = [];
  for (const item of body.items) {
    const price = requestCents(item.unitPrice);
    if (!price) return null;
    lines.push({ qty: parseInt(String(item.quantity || "1")), price });
  }
  const expenseRows: Array<{ accountId: number; description: string; amount: number }> = [];
  if (Array.isArray(body.expenses)) {
    for (const exp of body.expenses) {
      const amt = requestCents(exp.amount);
      if (!amt) return null;
      if (amt.gt(0) && exp.accountId) {
        expenseRows.push({
          accountId: parseInt(exp.accountId),
          description: exp.description || "",
          amount: amt.toNumber(),
        });
      }
    }
  }
  const depositAmt = MoneyDecimal.max(0, deposit);
  const totalAmount = sumMoney(lines.map((line) => line.price.times(line.qty)));
  // What the ledger voucher posts (services/accounting/factoryPosReceipt.ts).
  const posting: FactoryPosSaleAmounts = {
    isCredit,
    total: totalAmount,
    deposit: depositAmt,
    deductions: expenseRows.map((row) => ({ ...row, amount: toMoney(row.amount) })),
  };
  return {
    isCredit,
    depositAmt: depositAmt.toNumber(),
    lines,
    totalAmount: totalAmount.toNumber(),
    expenseRows,
    posting,
  };
}

/** A native amount in USD at the sale's factory rate, at cents (the daybook's amount_usd). */
function usdAtRate(amount: number, rate: string): string {
  return toMoney(amount).times(toMoney(rate)).toFixed(2);
}

/**
 * Wave 8.4 continuation: a sale the ledger cannot carry is refused before any
 * write — a customer of another company, a cash leg with no cash account, an
 * unpaid credit sale with no customer, a non-USD sale with no confirmed rate
 * on or before its date (409). Returns the sale's rate, or sends the refusal.
 */
async function saleRateOrRefuse(
  res: Response,
  companyId: number,
  sale: {
    customerId: number | null;
    cashAccountId: unknown;
    currencyCode: unknown;
    saleDate: string;
    posting: FactoryPosSaleAmounts;
  }
): Promise<string | null> {
  if (!(await isCompanyCustomerOrAbsent(companyId, sale.customerId))) {
    res.status(400).json({ message: "Customer not found" });
    return null;
  }
  const refusal = factoryPosSaleRefusal(sale.posting, {
    cashAccountId: sale.cashAccountId ? Number(sale.cashAccountId) : null,
    customerId: sale.customerId,
  });
  if (refusal) {
    res.status(refusal.statusCode).json(refusal.body);
    return null;
  }
  try {
    return await factoryPosSaleRate(db, companyId, String(sale.currencyCode || "USD"), sale.saleDate);
  } catch (error: unknown) {
    if (!(error instanceof FactoryPosSaleRefusalError)) throw error;
    res.status(error.statusCode).json(error.body);
    return null;
  }
}

/** The route's error response: a posting refusal keeps its status and code. */
function sendSaleError(res: Response, error: unknown) {
  if (error instanceof FactoryPosSaleRefusalError) return res.status(error.statusCode).json(error.body);
  return res.status(400).json({ message: getErrorMessage(error) });
}

function postingInput(
  companyId: number,
  sale: { id: number; saleNumber: string; txDate: string | Date },
  body: { customerName?: string | null; currencyCode?: unknown; cashAccountId?: unknown },
  customerId: number | null,
  rate: string,
  posting: FactoryPosSaleAmounts
) {
  return {
    ...posting,
    companyId,
    saleId: sale.id,
    saleNumber: sale.saleNumber,
    voucherDate: String(sale.txDate),
    currency: String(body.currencyCode || "USD"),
    rate,
    customerName: body.customerName ?? null,
    customerId,
    cashAccountId: body.cashAccountId ? Number(body.cashAccountId) : null,
  };
}

/**
 * The sale's location, cash account and expense accounts are body ids the
 * path-based company scope never sees: each must be the user's own.
 */
async function refusedSaleBodyId(
  session: Request["session"],
  companyId: number,
  locationId: unknown,
  cashAccountId: unknown,
  expenseRows: readonly { accountId: number }[]
): Promise<string | null> {
  if (locationId && !(await isFactorySessionLocation(session, locationId))) return "Location not found";
  const accountIds = [cashAccountId, ...expenseRows.map((row) => row.accountId)];
  if (!(await allLedgerAccountsOwned(companyId, accountIds))) return "Account not found";
  return null;
}

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

        // Step 6: Update customer balance entries. The old SALE and DEPOSIT rows
        // are removed on every edit (they used to stay when an edit turned the
        // sale into a cash sale or dropped its customer), then re-written for a
        // credit sale with a customer.
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
