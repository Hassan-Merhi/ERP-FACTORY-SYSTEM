// Extracted from ./createSaleService.ts: validation and context for createPosSale.
import { logger } from "../../lib/logger";
import { db } from "../../db";
import { storage } from "../../storage";
import {
  checkIdempotentSale,
  resolvePosEnforcedCashAccount,
  resolvePaymentAccount,
  validateLocationAccess,
  validateStockItemsExist,
} from "./validateSaleRequest";
import { validateItemsBasic, calculateGrandTotal, validateInventoryAvailability } from "./buildSaleItems";
import { getOrCreateSalesRevenueAccount, fetchSupplierPartnerAccountingContext } from "./postSaleAccounting";
import { POS_CLIENT_SALE_ID_MAX_LENGTH } from "./posSaleIdempotency";
import { baleMirrorMovementRefusal } from "../accounting/perpetualInventory/cutoverRefusal";
import { PosZmwRateError, resolveLockedZmwPosCurrency, checkedPosNativeSaleAmounts } from "./posZmwRatePolicy";
import { isPhase9LanPrimary } from "../../edge/phase9PosOutbox";
import { phase9PosSaleRefusal } from "./posSaleOfflinePolicy";
import { offlineEnteredRate, err } from "./createSaleServiceHelpers";
import type { CreatePosSaleParams } from "./posSaleTypes";

type ValidateInventoryAvailabilityResult = Awaited<ReturnType<typeof validateInventoryAvailability>>;

export async function preparePosSale({
  params,
  companyType,
}: {
  params: CreatePosSaleParams;
  companyType: { isSpCompany: boolean; isGoldenCoast?: boolean };
}) {
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
  if ("error" in posEnforcedResult) return { done: true as const, value: err(posEnforcedResult.error) };
  const { posEnforcedCashAccountId } = posEnforcedResult;

  const accountResult = await resolvePaymentAccount({
    isCreditSale,
    paymentAccountId,
    cashAccountId,
    posEnforcedCashAccountId,
    companyId: currentCompanyId,
  });
  if ("error" in accountResult) return { done: true as const, value: err(accountResult.error) };
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
      done: true as const,
      value: {
        status: 400,
        body: {
          code: "POS_CLIENT_SALE_ID_TOO_LONG",
          message: "clientSaleId must be at most 36 characters",
        },
      },
    };
  }

  const idempotentResult = await checkIdempotentSale(currentCompanyId, clientSaleId);
  if (idempotentResult) return { done: true as const, value: idempotentResult };

  // Factory LAN server during an outage: only the owner-approved offline sale
  // shape is accepted, before anything is written (see posSaleOfflinePolicy).
  const lanCapture = isPhase9LanPrimary();
  if (lanCapture) {
    const refusal = phase9PosSaleRefusal({ clientSaleId, currency, exchangeRate, isSpCompany });
    if (refusal) return { done: true as const, value: err(refusal) };
  }

  if (!locationId) {
    return { done: true as const, value: { status: 400, body: { message: "Location is required" } } };
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
      done: true as const,
      value: {
        status: 400,
        body: { message: isCreditSale ? "Customer is required" : "Payment account is required" },
      },
    };
  }
  if (!items || !Array.isArray(items) || items.length === 0) {
    return { done: true as const, value: { status: 400, body: { message: "At least one item is required" } } };
  }

  const parsedLocationId = Number(locationId);
  const basicItemsCheck = validateItemsBasic(locationId, items);
  if (basicItemsCheck) return { done: true as const, value: err(basicItemsCheck.error) };

  const grandTotalResult = calculateGrandTotal(items);
  if ("error" in grandTotalResult) return { done: true as const, value: err(grandTotalResult.error) };
  let { grandTotal } = grandTotalResult;
  let nativeZmwTotal: string | undefined;
  const salesAccountResult = await getOrCreateSalesRevenueAccount(currentCompanyId);
  if ("error" in salesAccountResult) return { done: true as const, value: err(salesAccountResult.error) };
  const { salesAccount } = salesAccountResult;

  const locationResult = await validateLocationAccess({
    locationId: parsedLocationId,
    parsedLocationId,
    companyId: currentCompanyId,
    isPOSUser,
    userId,
  });
  if ("error" in locationResult) return { done: true as const, value: err(locationResult.error) };
  const { location } = locationResult;

  const voucherDate = providedVoucherDate || voucherDateFallback;
  // Lock the company's effective-dated rate before creating any accounting or
  // inventory rows. The client must recalculate USD line prices when a
  // backdated ZMW sale's approved rate differs from the current rate.
  let lockedPosCurrency: { currency: string; exchangeRate: string | null };
  try {
    const enteredRate = lanCapture ? offlineEnteredRate(currency, exchangeRate) : null;
    lockedPosCurrency =
      params.lockedCurrency ??
      enteredRate ??
      (await resolveLockedZmwPosCurrency(currentCompanyId, voucherDate, currency, exchangeRate));
  } catch (error) {
    if (error instanceof PosZmwRateError) {
      return {
        done: true as const,
        value: err({ status: error.statusCode, body: { code: error.code, message: error.message } }),
      };
    }
    throw error;
  }

  try {
    const amounts = checkedPosNativeSaleAmounts(items, lockedPosCurrency, isSpCompany || lanCapture);
    if (amounts) {
      nativeZmwTotal = amounts.nativeTotal;
      grandTotal = amounts.usdTotal;
    }
  } catch (error) {
    if (error instanceof PosZmwRateError) {
      return {
        done: true as const,
        value: err({ status: error.statusCode, body: { code: error.code, message: error.message } }),
      };
    }
    throw error;
  }

  const stockExistsError = await validateStockItemsExist(currentCompanyId, items);
  if (stockExistsError) return { done: true as const, value: err(stockExistsError.error) };

  const mirrorRefusal = await baleMirrorMovementRefusal(
    db,
    currentCompanyId,
    items.map((item: { stockItemId?: unknown }) => item?.stockItemId),
    "pos-sale"
  );
  if (mirrorRefusal)
    return { done: true as const, value: err({ status: mirrorRefusal.status, body: { ...mirrorRefusal.body } }) };

  let inventoryValidation: ValidateInventoryAvailabilityResult;
  try {
    inventoryValidation = await validateInventoryAvailability(parsedLocationId, items, canSellNegativeStock);
  } catch (error: unknown) {
    const committedRetry = await checkIdempotentSale(currentCompanyId, clientSaleId);
    if (committedRetry) return { done: true as const, value: committedRetry };
    throw error;
  }

  const spCtxResult = await fetchSupplierPartnerAccountingContext(
    isSpCompany,
    currentCompanyId,
    location,
    inventoryValidation
  );
  if ("error" in spCtxResult) return { done: true as const, value: err(spCtxResult.error) };
  const spCtx = spCtxResult;

  return {
    done: false as const,
    currentCompanyId,
    userId,
    username,
    canSellNegativeStock,
    isSpCompany,
    isGoldenCoast,
    notes,
    isCreditSale,
    clientSaleId,
    accountType,
    accountId,
    customerAccount,
    lanCapture,
    effectiveShiftId,
    parsedLocationId,
    grandTotal,
    nativeZmwTotal,
    salesAccount,
    location,
    voucherDate,
    lockedPosCurrency,
    inventoryValidation,
    spCtx,
  };
}
