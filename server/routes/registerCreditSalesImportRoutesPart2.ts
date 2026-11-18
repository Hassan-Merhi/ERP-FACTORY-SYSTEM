// Extracted from ./creditSalesImportRoutes.ts to keep that module under the source-size cap.
import type { Express } from "express";
import { getErrorMessage } from "../lib/httpHandlers";
import { assertZmwImportPrices, PosZmwRateError, resolveLockedZmwPosCurrency } from "../services/pos/posZmwRatePolicy";
import { logger } from "../lib/logger";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../db";
import { storage } from "../storage";
import { requireAuth } from "../auth";
import { adjustInventory } from "../inventoryHelper";
import { postStockMovementTx } from "../services/inventory/stockMovementIntegrityService";
import { getClientDate } from "../lib/dateUtils";
import { MoneyDecimal, moneyString, sumMoney, toMoney } from "../lib/money";
import { postErpVoucherTx, sessionPostingActor } from "../services/accounting/erpVoucherPosting";
import { InvalidExchangeRateError, validateHistoricalRate } from "../services/accounting/currencyAmounts";
import { generateInvoicePdf } from "../helpers/generateInvoicePdf";
import { generateStockPdf } from "../helpers/generateStockPdf";
import { getErpExportVisibility } from "../helpers/exportVisibility";
import { sendWhatsAppFileByUploadPos, sendWhatsAppFileToChatIdPos } from "../services/whatsappService";
import {
  companies,
  customerBalances,
  inventory,
  ledgerAccounts,
  salesItems,
  stockItemLocationPrices,
} from "@shared/schema";
import {
  financialOperationFingerprint,
  withDurableFinancialOperation,
} from "../services/accounting/durableFinancialOperation";
import {
  financialOperationRequestPayload,
  resolveFinancialOperationKey,
} from "../services/accounting/financialOperationRequest";
import { postSaleCogsTx, relievedValue } from "../services/accounting/perpetualInventory/saleCogs";
import {
  assertNoBaleMirrorMovementTx,
  sendBaleMirrorMovementRefusal,
} from "../services/accounting/perpetualInventory/cutoverRefusal";
import { canonicalStockMovementAdapter, importLineAmounts } from "./registerCreditSalesImportRoutesPart1";

export function registerCreditSalesImportRoutesPart2(app: Express) {
  // Credit Sales Import - Import credit sales transactions
  app.post("/api/credit-sales-import/import", requireAuth, async (req, res) => {
    try {
      if (!req.session.currentCompanyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const { locationId, saleDate, items, customerId, currency, exchangeRate } = req.body;

      if (!locationId || !saleDate || !items || !Array.isArray(items) || !customerId) {
        return res.status(400).json({ message: "Missing required fields" });
      }

      // Verify the company's effective-dated rate and every USD/native sheet
      // price BEFORE any customer, voucher, inventory, or financial-operation
      // write. This applies to imported credit sales as well as cash sales.
      const lockedPosCurrency = await resolveLockedZmwPosCurrency(
        req.session.currentCompanyId,
        saleDate,
        currency,
        exchangeRate
      );
      assertZmwImportPrices(items, lockedPosCurrency);
      // The central voucher poster requires ORIGINAL-currency debit/credit fields
      // for every non-USD sale. CFA was previously omitted here (only ZMW was
      // included), so every Mali credit import failed before writing a voucher.
      const nativeRate =
        lockedPosCurrency.currency === "USD"
          ? null
          : validateHistoricalRate(
              lockedPosCurrency.exchangeRate,
              `${lockedPosCurrency.currency} credit sales import exchange rate`
            );
      const nativeTransaction = (total: string) =>
        nativeRate
          ? {
              currency: lockedPosCurrency.currency,
              amount: toMoney(total)
                .times(nativeRate)
                .toFixed(lockedPosCurrency.currency === "ZMW" ? 6 : 2),
              rate: nativeRate.toFixed(),
            }
          : null;

      const location = await storage.getLocationById(locationId);
      if (!location || location.companyId !== req.session.currentCompanyId) {
        return res.status(400).json({ message: "Location not found" });
      }
      const lineAmounts = items.map((item) => importLineAmounts(item.quantity, item.rate));
      if (lineAmounts.some((amounts) => !amounts)) {
        return res.status(400).json({ message: "Invalid amount" });
      }

      let customer = await storage.getCustomerById(customerId);
      if (!customer || customer.companyId !== req.session.currentCompanyId) {
        return res.status(400).json({ message: "Invalid customer" });
      }
      if (customer.ledgerAccountId) {
        const [linkedLedger] = await db
          .select({ id: ledgerAccounts.id })
          .from(ledgerAccounts)
          .where(
            and(
              eq(ledgerAccounts.id, customer.ledgerAccountId),
              eq(ledgerAccounts.companyId, req.session.currentCompanyId)
            )
          )
          .limit(1);
        if (!linkedLedger) {
          return res.status(400).json({ message: "Customer ledger account must belong to the customer company" });
        }
      }

      // Get or create "Sales Revenue" ledger account (safe: handles soft-deleted rows)
      const salesRevenueAccount = await storage.getOrCreateLedgerAccount({
        companyId: req.session.currentCompanyId!,
        code: "SALES_REV",
        name: "Sales Revenue",
        accountType: "Income",
        subType: "Direct Income",
        openingBalance: "0",
        openingBalanceSide: "Cr",
        active: true,
      });

      // Get or create the customer's linked ledger account for receivables
      let customerLedgerAccountId = customer.ledgerAccountId;
      if (!customerLedgerAccountId) {
        const customerLedgerCode = `CUST_${customer.code}`;
        // Safe: reactivates a soft-deleted row instead of crashing on unique constraint
        const customerLedgerAccount = await storage.getOrCreateLedgerAccount({
          companyId: req.session.currentCompanyId!,
          code: customerLedgerCode,
          name: `${customer.legalName} - Receivable`,
          accountType: "Asset",
          subType: "Sundry Debtors",
          openingBalance: "0",
          openingBalanceSide: "Dr",
          active: true,
        });
        const updatedCustomer = await storage.updateCustomer(customer.id, {
          ledgerAccountId: customerLedgerAccount.id,
        });
        if (updatedCustomer) customer = updatedCustomer;
        customerLedgerAccountId = customerLedgerAccount.id;
      }

      let createdVoucher = null;

      const operationKey = resolveFinancialOperationKey(req);
      const operation = await withDurableFinancialOperation(
        {
          companyId: req.session.currentCompanyId!,
          operationName: "credit-sales-import.create",
          idempotencyKey: operationKey,
          requestFingerprint: financialOperationFingerprint({
            method: req.method,
            path: req.path,
            companyId: req.session.currentCompanyId!,
            body: financialOperationRequestPayload(req.body),
          }),
        },
        async (tx) => {
          // Phase 22 (B): the credit sale posts through the central engine first
          // (number allocated there; identity = the durable operation key). Its
          // lines are the sale value, each line at cents as the sale items store it.
          const totalSales = sumMoney(
            lineAmounts.map((amounts) => moneyString(amounts!.quantity.times(amounts!.rate)))
          ).toFixed(2);
          let relieved = new MoneyDecimal(0);
          const { voucher } = await postErpVoucherTx(tx, {
            companyId: req.session.currentCompanyId!,
            locationId,
            voucherType: "Sales",
            voucherDate: saleDate,
            description: `Credit Sale Import - ${items.length} items - Customer: ${customer.legalName}`,
            currency: lockedPosCurrency.currency,
            exchangeRate: lockedPosCurrency.exchangeRate,
            lines: [
              {
                ledgerAccountId: customerLedgerAccountId!,
                debit: totalSales,
                transaction: nativeTransaction(totalSales),
                narration: `Credit Sale to ${customer.legalName} - ${items.length} items`,
              },
              {
                ledgerAccountId: salesRevenueAccount.id,
                credit: totalSales,
                transaction: nativeTransaction(totalSales),
                narration: `Credit Sale Revenue - ${items.length} items`,
              },
            ],
            source: { type: "credit-sales-import", id: `${req.session.currentCompanyId}:${operationKey}` },
            actor: sessionPostingActor(req, "Credit sales import"),
            metadata: { locationName: location.name, isCreditSale: true },
          });
          const voucherNumber = voucher.voucherNumber;

          for (const [index, item] of items.entries()) {
            const { quantity, rate } = lineAmounts[index]!;
            const stockItem = await storage.getStockItemByCodeOrAlias(item.barcode, req.session.currentCompanyId!);
            if (!stockItem) {
              throw new Error(`Stock item not found for barcode: ${item.barcode}`);
            }
            // Wave 11: a factory bale-mirror item is sold in the factory after the cut-over.
            await assertNoBaleMirrorMovementTx(
              tx,
              req.session.currentCompanyId!,
              [stockItem.id],
              "credit-sales-import"
            );

            const [inventoryRecord] = await tx
              .select()
              .from(inventory)
              .where(and(eq(inventory.stockItemId, stockItem.id), eq(inventory.locationId, locationId)))
              .limit(1);

            const costPrice = inventoryRecord ? toMoney(inventoryRecord.averageRate) : new MoneyDecimal(0);

            // Each line is stored at cents; the voucher total is the sum of the stored lines.
            const itemSales = moneyString(quantity.times(rate));
            const itemCost = moneyString(quantity.times(costPrice));
            const profit = toMoney(itemSales).minus(itemCost).toFixed(2);

            // Look up configured price for this item/location
            const [importCreditLocPrice] = await tx
              .select()
              .from(stockItemLocationPrices)
              .where(
                and(
                  eq(stockItemLocationPrices.stockItemId, stockItem.id),
                  eq(stockItemLocationPrices.locationId, locationId)
                )
              )
              .limit(1);
            const importCreditConfiguredPrice = toMoney(
              importCreditLocPrice?.sellingPrice || stockItem.sellingPrice || "0"
            );

            const issued = await adjustInventory(
              tx,
              locationId,
              stockItem.id,
              -quantity.toNumber(),
              req.session.currentCompanyId!
            );
            const [saleItem] = await tx
              .insert(salesItems)
              .values({
                voucherId: voucher.id,
                stockItemId: stockItem.id,
                quantity: quantity.toString(),
                sellingPrice: rate.toString(),
                costPrice: costPrice.toString(),
                totalSales: itemSales,
                totalCost: itemCost,
                profit,
                configuredPrice: importCreditConfiguredPrice.gt(0) ? importCreditConfiguredPrice.toFixed(6) : null,
                // Wave 11: the exact value the issue relieved, what a reversal restores.
                valueMoved: relievedValue(issued).toFixed(2),
              })
              .returning({ id: salesItems.id });

            relieved = relieved.plus(relievedValue(issued));
            await postStockMovementTx(
              tx,
              {
                companyId: req.session.currentCompanyId!,
                stockItemId: stockItem.id,
                kind: "issue",
                quantity: quantity.abs().toString(),
                unitCost: MoneyDecimal.max(costPrice, 0).toString(),
                fromLocationId: locationId,
                occurredAt: new Date(`${saleDate}T00:00:00.000Z`).toISOString(),
                source: {
                  sourceType: "credit-sales-import",
                  sourceId: String(voucher.id),
                  idempotencyKey: `credit-sales-import:${voucher.id}:${saleItem.id}`,
                },
                actor: {
                  userId: req.session.userId,
                  username: req.session.username,
                  reason: `Credit sales import ${voucher.voucherNumber}`,
                },
                allowNegativeStock: true,
              },
              canonicalStockMovementAdapter
            );
          }

          createdVoucher = voucher;
          // Perpetual inventory (wave 8.1): the exact value the import took out of stock.
          await postSaleCogsTx(tx, {
            companyId: req.session.currentCompanyId!,
            saleVoucherId: voucher.id,
            saleVoucherNumber: voucherNumber,
            voucherDate: saleDate,
            locationId,
            relieved,
          });

          // Add customer balance transaction (credit sale = debit to customer = they owe us)
          // Get current running balance for this customer
          const [lastBalance] = await tx
            .select()
            .from(customerBalances)
            .where(
              and(
                eq(customerBalances.customerId, customerId),
                eq(customerBalances.companyId, req.session.currentCompanyId!)
              )
            )
            .orderBy(desc(customerBalances.id))
            .limit(1);

          const newBalance = toMoney(lastBalance?.balance).plus(totalSales);

          await tx.insert(customerBalances).values({
            customerId,
            companyId: req.session.currentCompanyId!,
            transactionDate: saleDate,
            transactionType: "Credit Sale",
            referenceId: voucher.id,
            referenceType: "voucher",
            debitAmount: totalSales,
            creditAmount: "0",
            balance: newBalance.toString(),
            currency: "USD",
            description: `Credit Sale Import - ${items.length} items`,
          });
          return {
            value: { voucher, totalSales },
            resultReference: voucher.id,
          };
        }
      );
      createdVoucher = operation.value.voucher;

      res.json({
        success: true,
        voucher: createdVoucher,
        itemsCount: items.length,
        totalSales: toMoney(operation.value.totalSales).toFixed(2),
        customerName: customer.legalName,
      });

      // Background: send invoice + stock report after response is already sent
      if (createdVoucher && location.whatsappGroupChatId) {
        const _companyId = req.session.currentCompanyId!;
        const _chatId = location.whatsappGroupChatId;
        const _locName = location.name;
        const _locId = locationId;
        const _saleDate = saleDate;
        const _voucherDate = createdVoucher.voucherDate;
        const _voucherId = createdVoucher.id;
        const _custName = customer.legalName ?? "";
        const _senderName = req.user?.username || "Import";
        const _dateStr = getClientDate(req);
        setImmediate(async () => {
          // 1. Invoice PDF
          try {
            const waVis = await getErpExportVisibility(req);
            // P/L cols auto-hide in the PDF generator when no configured price exists — don't gate on hideSalesProfitCost
            const hideProfitCols = waVis.hideSelling || waVis.hideCost;
            const pdfBuffer = await generateInvoicePdf(_voucherId, _companyId, _senderName, { hideProfitCols });
            const safeDate = (_voucherDate ?? _saleDate).replace(/[^0-9-]/g, "");
            const fileName =
              `${_custName} Invoice ${_locName} ${safeDate}`
                .replace(/[^\w\s.()-]/g, "_")
                .replace(/\s+/g, " ")
                .trim() + ".pdf";
            const invResult = await sendWhatsAppFileByUploadPos(_chatId, pdfBuffer, fileName, "");
            if (!invResult.success) logger.error(`[CreditImport-bg] Invoice send failed: ${invResult.error}`);
            else logger.info(`[CreditImport-bg] Invoice sent: ${fileName} → ${_chatId}`);
          } catch (e: unknown) {
            logger.error("[CreditImport-bg] Invoice send error:", { error: getErrorMessage(e) });
          }

          // 2. Stock report PDF
          try {
            const [co] = await db
              .select({ name: companies.name })
              .from(companies)
              .where(eq(companies.id, _companyId))
              .limit(1);
            const companyName = co?.name || "Company";
            const {
              buffer: stockBuf,
              pageCount,
              rowCount,
            } = await generateStockPdf(_companyId, companyName, _locId, _locName);
            const maxAllowedPages = Math.ceil(rowCount / 20) + 5;
            if (pageCount > maxAllowedPages) {
              logger.error(
                `[CreditImport-bg] Stock PDF safety guard: ${pageCount} pages for ${rowCount} rows — not sent`
              );
            } else {
              const stampStr = new Date().toLocaleString("en-GB", {
                day: "2-digit",
                month: "short",
                year: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              });
              const stockName = `${_locName} STK ${companyName} ${_dateStr}`.replace(/[^\w\s.()-]/g, "_").trim();
              const stockRes = await sendWhatsAppFileToChatIdPos(
                _chatId,
                stockBuf,
                `${stockName}.pdf`,
                `Stock Report — ${_locName}\n${stampStr}`
              );
              if (!stockRes.success) logger.error(`[CreditImport-bg] Stock send failed: ${stockRes.error}`);
              else logger.info(`[CreditImport-bg] Stock report sent: ${stockName}.pdf → ${_chatId}`);
            }
          } catch (e: unknown) {
            logger.error("[CreditImport-bg] Stock send error:", { error: getErrorMessage(e) });
          }
        });
      }
    } catch (error: unknown) {
      if (sendBaleMirrorMovementRefusal(res, error)) return;
      if (error instanceof PosZmwRateError) {
        return res.status(error.statusCode).json({ code: error.code, message: error.message });
      }
      if (error instanceof InvalidExchangeRateError) {
        return res.status(400).json({ code: "IMPORT_EXCHANGE_RATE_INVALID", message: error.message });
      }
      logger.error("Credit Sales Import error:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
