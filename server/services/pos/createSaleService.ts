/**
 * server/services/pos/createSaleService.ts
 *
 * PHASE 19 — POS Backend Sale Creation Structural Split.
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
import type {
  CreatePosSaleParams,
  CreatePosSaleResult,
  HandlerErrorResult,
  PosSaleResponseItem,
  PosSaleVoucher,
} from "./posSaleTypes";
import {
  checkIdempotentSale,
  resolvePosEnforcedCashAccount,
  resolvePaymentAccount,
  validateLocationAccess,
  validateStockItemsExist,
} from "./validateSaleRequest";
import { validateItemsBasic, calculateGrandTotal, validateInventoryAvailability } from "./buildSaleItems";
import {
  getOrCreateSalesRevenueAccount,
  fetchSupplierPartnerAccountingContext,
  insertSaleAccountingEntries,
} from "./postSaleAccounting";
import { insertSaleVoucher } from "./createSaleVoucher";
import { lockAndDeductInventoryForSaleItem } from "./deductSaleInventory";
import { lockAndFindExistingPosSaleTx, POS_CLIENT_SALE_ID_MAX_LENGTH } from "./posSaleIdempotency";
import { isGoldenCoastPosCompany, postGoldenCoastPosAccountingTx } from "./goldenCoastPosAccounting";

function err(result: HandlerErrorResult): CreatePosSaleResult {
  return { status: result.status, body: result.body };
}

export async function createPosSale(
  params: CreatePosSaleParams,
  companyType: { isSpCompany: boolean; isGoldenCoast?: boolean }
): Promise<CreatePosSaleResult> {
  const {
    currentCompanyId,
    userId,
    username,
    userRole,
    canSellNegativeStock,
    sessionCashAccountId,
    voucherDateFallback,
    body,
  } = params;
  const { isSpCompany, isGoldenCoast = false } = companyType;
  const isPOSUser = userRole === "POS";
  let goldenCoastSaleDetected = isGoldenCoast;

  const {
    locationId,
    cashAccountId,
    paymentAccountId,
    items,
    notes,
    isCreditSale,
    voucherDate: providedVoucherDate,
    shiftId,
    clientSaleId,
    currency,
    exchangeRate,
  } = body;

  const posEnforcedResult = await resolvePosEnforcedCashAccount({
    isPOSUser,
    isCreditSale,
    locationId,
    userId,
    companyId: currentCompanyId,
    sessionCashAccountId,
  });
  if ("error" in posEnforcedResult) return err(posEnforcedResult.error);
  const { posEnforcedCashAccountId } = posEnforcedResult;

  const accountResult = await resolvePaymentAccount({
    isCreditSale,
    paymentAccountId,
    cashAccountId,
    posEnforcedCashAccountId,
    companyId: currentCompanyId,
  });
  if ("error" in accountResult) return err(accountResult.error);
  const { accountType, accountId, customerAccount } = accountResult;

  logger.info("[POS Sale] Payment info:", {
    provided: { paymentAccountType: body.paymentAccountType, paymentAccountId, cashAccountId, isCreditSale },
    resolved: { accountType, accountId },
  });

  // vouchers.client_sale_id is varchar(36) because the retry identity is a
  // UUID. A longer key used to reach the insert and fail there, turning a
  // malformed request into a 500 with no usable message.
  if (typeof clientSaleId === "string" && clientSaleId.length > POS_CLIENT_SALE_ID_MAX_LENGTH) {
    return {
      status: 400,
      body: {
        code: "POS_CLIENT_SALE_ID_TOO_LONG",
        message: "clientSaleId must be at most 36 characters",
      },
    };
  }

  const idempotentResult = await checkIdempotentSale(currentCompanyId, clientSaleId);
  if (idempotentResult) return idempotentResult;

  if (!locationId) {
    return { status: 400, body: { message: "Location is required" } };
  }

  let effectiveShiftId: number | null = shiftId || null;
  if (effectiveShiftId) {
    const shift = await storage.getShiftById(effectiveShiftId);
    if (
      !shift ||
      shift.companyId !== currentCompanyId ||
      shift.locationId !== locationId ||
      shift.status !== "open" ||
      shift.userId !== userId
    ) {
      effectiveShiftId = null;
    }
  }
  if (!accountId) {
    return {
      status: 400,
      body: { message: isCreditSale ? "Customer is required" : "Payment account is required" },
    };
  }
  if (!items || !Array.isArray(items) || items.length === 0) {
    return { status: 400, body: { message: "At least one item is required" } };
  }

  const parsedLocationId = Number(locationId);
  const basicItemsCheck = validateItemsBasic(locationId, items);
  if (basicItemsCheck) return err(basicItemsCheck.error);

  const grandTotalResult = calculateGrandTotal(items);
  if ("error" in grandTotalResult) return err(grandTotalResult.error);
  const { grandTotal } = grandTotalResult;

  const salesAccountResult = await getOrCreateSalesRevenueAccount(currentCompanyId);
  if ("error" in salesAccountResult) return err(salesAccountResult.error);
  const { salesAccount } = salesAccountResult;

  const locationResult = await validateLocationAccess({
    locationId: parsedLocationId,
    parsedLocationId,
    companyId: currentCompanyId,
    isPOSUser,
    userId,
  });
  if ("error" in locationResult) return err(locationResult.error);
  const { location } = locationResult;

  const voucherNumber = `SALES-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const voucherDate = providedVoucherDate || voucherDateFallback;

  const stockExistsError = await validateStockItemsExist(currentCompanyId, items);
  if (stockExistsError) return err(stockExistsError.error);

  let inventoryValidation: Awaited<ReturnType<typeof validateInventoryAvailability>>;
  try {
    inventoryValidation = await validateInventoryAvailability(parsedLocationId, items, canSellNegativeStock);
  } catch (error: unknown) {
    const committedRetry = await checkIdempotentSale(currentCompanyId, clientSaleId);
    if (committedRetry) return committedRetry;
    throw error;
  }

  const spCtxResult = await fetchSupplierPartnerAccountingContext(
    isSpCompany,
    currentCompanyId,
    location,
    inventoryValidation
  );
  if ("error" in spCtxResult) return err(spCtxResult.error);
  const spCtx = spCtxResult;

  type PosSaleTxResult = { voucher: PosSaleVoucher; saleItems: PosSaleResponseItem[]; replayed: boolean };
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

      const txVoucher = await insertSaleVoucher(tx, {
        companyId: currentCompanyId,
        locationId: parsedLocationId,
        locationName: location.name,
        voucherNumber,
        voucherDate,
        notes,
        isCreditSale,
        customerAccountName: customerAccount ? customerAccount.name : undefined,
        grandTotal,
        effectiveShiftId,
        clientSaleId,
        currency,
        exchangeRate,
      });

      await insertSaleAccountingEntries(tx, {
        txVoucherId: txVoucher.id,
        voucherNumber,
        grandTotal,
        isCreditSale,
        accountType,
        accountId,
        location,
        customerAccount,
        companyId: currentCompanyId,
        isSpCompany,
        salesAccount,
        spCtx,
        currency: currency || "USD",
        exchangeRate: exchangeRate ? String(exchangeRate) : null,
      });

      const txSaleItems = [];
      const issueOrdinalByStockItem = new Map<number, number>();

      for (const validatedItem of inventoryValidation) {
        const { item } = validatedItem;
        const issueOrdinal = (issueOrdinalByStockItem.get(item.stockItemId) ?? 0) + 1;
        issueOrdinalByStockItem.set(item.stockItemId, issueOrdinal);

        const { costPrice } = await lockAndDeductInventoryForSaleItem(
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
          sellingPrice: inventoryMoney(sellingPrice),
          costPrice: inventoryUnitCost(costPriceDecimal),
          totalSales: inventoryMoney(totalSales),
          totalCost: inventoryMoney(totalCost),
          profit: inventoryMoney(profit),
          configuredPrice: inventoryUnitCost(configuredPrice),
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
          Number((grandTotal - spCtx.spPosTotalQtySold * spCtx.spPosDeductionPerQty).toFixed(2))
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

  try {
    await logAudit({
      userId,
      username,
      companyId: currentCompanyId,
      action: "create",
      tableName: "vouchers",
      recordId: voucher.id,
      recordIdentifier: voucherNumber,
      changes: {
        voucherNumber: { old: undefined, new: voucherNumber },
        voucherType: { old: undefined, new: "Sales" },
        saleType: { old: undefined, new: isCreditSale ? "Credit Invoice" : "Cash Sale" },
        location: { old: undefined, new: location.name },
        totalAmount: { old: undefined, new: grandTotal.toFixed(2) },
        date: { old: undefined, new: voucherDate },
        itemCount: { old: undefined, new: saleItems.length },
        customer: { old: undefined, new: customerAccount ? customerAccount.name : null },
      },
    });
  } catch {
    /* non-fatal */
  }

  if (!goldenCoastSaleDetected && !isCreditSale && accountType === "cash") {
    runIntercompanyPosTransfer(currentCompanyId, accountId, grandTotal, voucherDate).catch((error) =>
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
      voucherNumber,
      saleDate: voucherDate,
      isCreditSale,
      customer: customerAccount
        ? { id: customerAccount.id, code: customerAccount.code, name: customerAccount.name }
        : null,
    },
  };
}
