/**
 * server/services/pos/createSaleService.ts
 *
 * POS sale creation, inventory and accounting posting.
 */
import { randomUUID } from "node:crypto";
import { logger } from "../../lib/logger";
import {
  inventoryMoney,
  inventoryQuantity,
  inventoryUnitCost,
  multiplyInventoryValues,
  subtractInventoryValues,
  toInventoryDecimal,
} from "../../lib/inventoryMath";
import { db } from "../../db";
import { storage } from "../../storage";
import { logAudit, runIntercompanyPosTransfer } from "../../routes/_helpers";
import { stockItems, stockItemLocationPrices, salesItems } from "@shared/schema";
import { eq, and } from "drizzle-orm";
import type { CreatePosSaleParams, CreatePosSaleResult, PosSaleResponseItem, PosSaleVoucher } from "./posSaleTypes";
import { checkIdempotentSale } from "./validateSaleRequest";
import { buildSaleAccountingLines } from "./postSaleAccounting";
import { postErpVoucherTx } from "../accounting/erpVoucherPosting";
import { lockAndDeductInventoryForSaleItem } from "./deductSaleInventory";
import { lockAndFindExistingPosSaleTx } from "./posSaleIdempotency";
import { isGoldenCoastPosCompany, postGoldenCoastPosAccountingTx } from "./goldenCoastPosAccounting";
import { postSaleCogsTx } from "../accounting/perpetualInventory/saleCogs";
import { MoneyDecimal } from "../../lib/money";
import { spDeductionAmount, spPayableAfterDeduction } from "./spDeduction";
import { allocatePhase9PosInvoiceTx, capturePhase9PosSaleTx } from "../../edge/posOutbox";
import { preparePosSale } from "./createSaleServicePrepare";

export async function createPosSale(
  params: CreatePosSaleParams,
  companyType: { isSpCompany: boolean; isGoldenCoast?: boolean }
): Promise<CreatePosSaleResult> {
  const css1 = await preparePosSale({ params, companyType });
  if (css1.done) return css1.value;
  const {
    isGoldenCoast,
    currentCompanyId,
    clientSaleId,
    location,
    grandTotal,
    nativeZmwTotal,
    isCreditSale,
    accountType,
    accountId,
    customerAccount,
    isSpCompany,
    salesAccount,
    spCtx,
    lockedPosCurrency,
    lanCapture,
    voucherDate,
    notes,
    parsedLocationId,
    userId,
    username,
    effectiveShiftId,
    inventoryValidation,
    canSellNegativeStock,
  } = css1;

  type PosSaleTxResult = { voucher: PosSaleVoucher; saleItems: PosSaleResponseItem[]; replayed: boolean };
  let goldenCoastSaleDetected = isGoldenCoast;
  let voucherNumber = "";
  let txResult: PosSaleTxResult;
  try {
    txResult = await db.transaction(async (tx): Promise<PosSaleTxResult> => {
      const existing = await lockAndFindExistingPosSaleTx({
        tx,
        companyId: currentCompanyId,
        clientSaleId,
      });
      if (existing) {
        return { voucher: existing.voucher, saleItems: existing.saleItems, replayed: true };
      }

      // Phase 22 (B): the sale voucher goes through the central engine, which
      // allocates its number (SV-<company>-YYYY-000001). Modern clients send
      // clientSaleId as the retry identity; older callers have none and get a
      // one-shot identity (the clientSaleId lock above stays the replay check).
      const saleLines = await buildSaleAccountingLines(tx, {
        voucherLabel: location.name,
        grandTotal,
        nativeZmwTotal,
        isCreditSale,
        accountType,
        accountId,
        location,
        customerAccount,
        companyId: currentCompanyId,
        isSpCompany,
        salesAccount,
        spCtx,
        currency: lockedPosCurrency.currency,
        exchangeRate: lockedPosCurrency.exchangeRate,
      });
      const lanInvoice = lanCapture ? await allocatePhase9PosInvoiceTx(tx) : null;
      const posted = await postErpVoucherTx(tx, {
        companyId: currentCompanyId,
        voucherType: "Sales",
        ...(lanInvoice ? { voucherNumber: lanInvoice.number } : {}),
        voucherDate,
        description:
          notes ||
          (isCreditSale
            ? `Credit Invoice Sale at ${location.name} - ${customerAccount ? customerAccount.name : undefined}`
            : `POS Sale at ${location.name}`),
        locationId: parsedLocationId,
        currency: lockedPosCurrency.currency,
        exchangeRate: lockedPosCurrency.exchangeRate,
        lines: saleLines,
        source: { type: "pos-sale", id: clientSaleId || `legacy-${randomUUID()}` },
        actor: { userId, username, reason: "POS sale" },
        metadata: {
          locationName: location.name,
          shiftId: effectiveShiftId,
          clientSaleId: clientSaleId || null,
          isCreditSale: !!isCreditSale,
        },
      });
      const txVoucher = posted.voucher;
      if (posted.replayed) {
        const replayedItems = await tx.select().from(salesItems).where(eq(salesItems.voucherId, txVoucher.id));
        return { voucher: txVoucher, saleItems: replayedItems, replayed: true };
      }
      voucherNumber = txVoucher.voucherNumber;

      const txSaleItems = [];
      const issueOrdinalByStockItem = new Map<number, number>();
      let relievedTotal = new MoneyDecimal(0);

      for (const validatedItem of inventoryValidation) {
        const { item } = validatedItem;
        const issueOrdinal = (issueOrdinalByStockItem.get(item.stockItemId) ?? 0) + 1;
        issueOrdinalByStockItem.set(item.stockItemId, issueOrdinal);

        const { costPrice, relieved } = await lockAndDeductInventoryForSaleItem(
          tx,
          parsedLocationId,
          parsedLocationId,
          validatedItem,
          canSellNegativeStock,
          currentCompanyId,
          {
            sourceId: String(txVoucher.id),
            idempotencyKey: `pos-sale:${txVoucher.id}:rev0:issue:${item.stockItemId}:line:${issueOrdinal}`,
          }
        );

        relievedTotal = relievedTotal.plus(relieved);
        const [stockItem] = await tx.select().from(stockItems).where(eq(stockItems.id, item.stockItemId));

        const qty = toInventoryDecimal(item.quantity);
        const sellingPrice = toInventoryDecimal(item.rate);
        const costPriceDecimal = toInventoryDecimal(costPrice);
        const totalSales = multiplyInventoryValues(qty, sellingPrice);
        const totalCost = multiplyInventoryValues(qty, costPriceDecimal);
        const profit = subtractInventoryValues(totalSales, totalCost);

        const [locPrice] = await tx
          .select()
          .from(stockItemLocationPrices)
          .where(
            and(
              eq(stockItemLocationPrices.stockItemId, item.stockItemId),
              eq(stockItemLocationPrices.locationId, parsedLocationId)
            )
          )
          .limit(1);
        const configuredPrice = toInventoryDecimal(locPrice?.sellingPrice || stockItem?.sellingPrice);

        await tx.insert(salesItems).values({
          voucherId: txVoucher.id,
          stockItemId: item.stockItemId,
          quantity: inventoryQuantity(qty),
          sellingPrice: inventoryUnitCost(sellingPrice),
          costPrice: inventoryUnitCost(costPriceDecimal),
          totalSales: inventoryMoney(totalSales),
          totalCost: inventoryMoney(totalCost),
          profit: inventoryMoney(profit),
          configuredPrice: inventoryUnitCost(configuredPrice),
          // Wave 11: the exact value the issue relieved (the COGS journal's
          // amount), what a reversal restores. cost_price / total_cost stay the
          // sale's costing at the pre-sale average rate, a display and profit
          // figure; the sub-ledger and the ledger move by value_moved.
          valueMoved: inventoryMoney(relieved),
        });

        const profitPerUnit = subtractInventoryValues(sellingPrice, configuredPrice);
        const totalProfitVsConfigured = multiplyInventoryValues(profitPerUnit, qty);

        txSaleItems.push({
          ...item,
          stockItemName: stockItem?.name || "",
          stockItemCode: stockItem?.code || "",
          amount: inventoryMoney(totalSales),
          configuredPrice: inventoryMoney(configuredPrice),
          profitPerUnit: inventoryMoney(profitPerUnit),
          totalProfitVsConfigured: inventoryMoney(totalProfitVsConfigured),
        });
      }

      goldenCoastSaleDetected = isGoldenCoast || (isSpCompany && (await isGoldenCoastPosCompany(tx, currentCompanyId)));
      if (goldenCoastSaleDetected && !isCreditSale) {
        const payableAmount = Math.max(
          0,
          spPayableAfterDeduction(grandTotal, spDeductionAmount(spCtx.spPosTotalQtySold, spCtx.spPosDeductionPerQty))
        );
        await postGoldenCoastPosAccountingTx({
          tx,
          companyId: currentCompanyId,
          locationId: parsedLocationId,
          clientSaleId: clientSaleId || "",
          revision: "create",
          saleDate: voucherDate,
          amountUsd: grandTotal,
          paymentAccountType: accountType === "bank" ? "bank" : "cash",
          paymentAccountId: accountId,
          supplierPayableAccountId: spCtx.spPosPayableAccountId!,
          payableAmountUsd: payableAmount,
          actor: { userId, username, reason: "Golden Coast itemized POS sale settlement" },
        });
      }

      // Perpetual inventory (wave 8.1): the exact value this sale took out of
      // stock, as its COGS journal. Supplier-partner companies carry their stock
      // in their own sp_stock accounts and are not posted here.
      if (!isSpCompany) {
        await postSaleCogsTx(tx, {
          companyId: currentCompanyId,
          saleVoucherId: txVoucher.id,
          saleVoucherNumber: voucherNumber,
          voucherDate: String(txVoucher.voucherDate),
          locationId: parsedLocationId,
          relieved: relievedTotal,
        });
      }

      if (lanInvoice) {
        await capturePhase9PosSaleTx(tx, lanInvoice, {
          companyId: currentCompanyId,
          localVoucherId: txVoucher.id,
          lanInvoiceNumber: lanInvoice.number,
          locationId: parsedLocationId,
          paymentAccountType: accountType === "credit" ? "credit" : accountType === "bank" ? "bank" : "cash",
          paymentAccountId: Number(accountId),
          actorUserId: String(userId),
          actorUsername: username,
          requestId: String(clientSaleId),
          currency: lockedPosCurrency.currency,
          exchangeRate: lockedPosCurrency.exchangeRate == null ? null : String(lockedPosCurrency.exchangeRate),
          voucherDate,
          notes: typeof notes === "string" && notes ? notes : null,
          items: inventoryValidation.map(({ item }) => ({
            stockItemId: Number(item.stockItemId),
            quantity: inventoryQuantity(item.quantity),
            rate: inventoryMoney(item.rate),
            originalCurrencyRate:
              item.originalCurrencyRate == null || item.originalCurrencyRate === ""
                ? null
                : String(item.originalCurrencyRate),
          })),
        });
      }

      // Phase 21 (B): the create audit commits with the sale or rolls it back.
      await logAudit(
        {
          userId,
          username,
          companyId: currentCompanyId,
          action: "create",
          tableName: "vouchers",
          recordId: txVoucher.id,
          recordIdentifier: voucherNumber,
          changes: {
            voucherNumber: { old: undefined, new: voucherNumber },
            voucherType: { old: undefined, new: "Sales" },
            saleType: { old: undefined, new: isCreditSale ? "Credit Invoice" : "Cash Sale" },
            location: { old: undefined, new: location.name },
            totalAmount: { old: undefined, new: grandTotal.toFixed(2) },
            date: { old: undefined, new: voucherDate },
            itemCount: { old: undefined, new: txSaleItems.length },
            items: {
              new: txSaleItems.map((item) => ({
                stockItemId: item.stockItemId,
                stockItemName: item.stockItemName,
                code: item.stockItemCode,
                quantity: item.quantity,
                rate: item.rate,
                totalAmount: item.amount,
              })),
            },
            customer: { old: undefined, new: customerAccount ? customerAccount.name : null },
          },
        },
        tx
      );

      return { voucher: txVoucher, saleItems: txSaleItems, replayed: false };
    });
  } catch (error: unknown) {
    const committedRetry = await checkIdempotentSale(currentCompanyId, clientSaleId);
    if (committedRetry) return committedRetry;
    throw error;
  }

  if (txResult.replayed) {
    const existingVoucher = txResult.voucher;
    const existingLocation =
      (existingVoucher.locationId ? await storage.getLocationById(existingVoucher.locationId) : null) ?? null;
    return {
      status: 200,
      body: {
        voucher: existingVoucher,
        location: existingLocation,
        items: txResult.saleItems,
        grandTotal: existingVoucher.totalAmount,
        voucherNumber: existingVoucher.voucherNumber,
        saleDate: existingVoucher.voucherDate,
        isCreditSale: existingVoucher.isCreditSale,
        customer: null,
        _idempotent: true,
      },
    };
  }

  const voucher = txResult.voucher;
  const saleItems = txResult.saleItems;

  if (!goldenCoastSaleDetected && !isCreditSale && accountType === "cash") {
    runIntercompanyPosTransfer(currentCompanyId, accountId, grandTotal, voucherDate, voucher.id).catch((error) =>
      logger.error("[IntercompanyPOS] Unhandled:", { error })
    );
  }

  return {
    status: 200,
    body: {
      voucher,
      location,
      items: saleItems,
      grandTotal: grandTotal.toFixed(2),
      ...(nativeZmwTotal ? { nativeZmwTotal } : {}),
      voucherNumber,
      saleDate: voucherDate,
      isCreditSale,
      customer: customerAccount
        ? { id: customerAccount.id, code: customerAccount.code, name: customerAccount.name }
        : null,
    },
  };
}
