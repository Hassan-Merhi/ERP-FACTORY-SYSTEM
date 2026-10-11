/**
 * server/services/pos/validateSaleRequest.ts
 *
 * PHASE 19 structural split — moved (unchanged) from server/routes/pos/posSalesRoutes.ts:
 *   - idempotency short-circuit (existing clientSaleId)
 *   - POS-enforced cash account resolution
 *   - payment account resolution (cash / bank / credit)
 *   - location validation (existence, ownership, POS-user assignment)
 *   - stock item existence validation
 *
 * Every message, status code, and query is byte-identical to the original —
 * only the code location changed.
 */
import { db } from "../../db";
import { storage } from "../../storage";
import {
  ledgerAccounts,
  bankAccounts,
  vouchers,
  salesItems,
  userLocations,
  userLocationCashAccounts,
  stockItems,
} from "@shared/schema";
import { eq, and, isNull } from "drizzle-orm";
import type {
  HandlerErrorResult,
  PosLocation,
  PosSaleItemInput,
  PosSaleResponseBody,
  ResolvedPaymentAccount,
} from "./posSaleTypes";
import { isAccountType } from "../accounting/accountClassification";

/** Returns the existing sale response body if `clientSaleId` was already saved, else null. */
export async function checkIdempotentSale(
  companyId: number,
  clientSaleId: string | undefined
): Promise<{ status: number; body: PosSaleResponseBody } | null> {
  if (!clientSaleId) return null;

  const [existingVoucher] = await db
    .select()
    .from(vouchers)
    .where(and(eq(vouchers.companyId, companyId), eq(vouchers.clientSaleId, clientSaleId), isNull(vouchers.deletedAt)))
    .limit(1);
  if (!existingVoucher) return null;

  const existingSalesItems = await db.select().from(salesItems).where(eq(salesItems.voucherId, existingVoucher.id));
  const existingLocation =
    (existingVoucher.locationId ? await storage.getLocationById(existingVoucher.locationId) : null) ?? null;
  return {
    status: 200,
    body: {
      voucher: existingVoucher,
      location: existingLocation,
      items: existingSalesItems,
      grandTotal: existingVoucher.totalAmount,
      voucherNumber: existingVoucher.voucherNumber,
      saleDate: existingVoucher.voucherDate,
      isCreditSale: existingVoucher.isCreditSale,
      customer: null,
      _idempotent: true,
    },
  };
}

/**
 * POS cash account enforcement: look up the mapped cash account from DB.
 * For POS users on non-credit sales, the cash account is determined server-side
 * from user_location_cash_accounts, not from the frontend submission.
 */
export async function resolvePosEnforcedCashAccount(params: {
  isPOSUser: boolean;
  isCreditSale: boolean | null | undefined;
  locationId: number | string | null | undefined;
  userId: string;
  companyId: number;
  sessionCashAccountId: number | null | undefined;
}): Promise<{ posEnforcedCashAccountId: number | null } | { error: HandlerErrorResult }> {
  const { isPOSUser, isCreditSale, locationId, userId, companyId, sessionCashAccountId } = params;

  if (!isPOSUser || isCreditSale) {
    return { posEnforcedCashAccountId: null };
  }

  const parsedLocId = locationId ? Number(locationId) : null;
  // Block immediately — POS users must always supply a location for cash sales.
  if (!parsedLocId) {
    return { error: { status: 400, body: { message: "Location is required for POS sales" } } };
  }
  const [locMapping] = await db
    .select({ cashAccountId: userLocationCashAccounts.cashAccountId })
    .from(userLocationCashAccounts)
    .where(
      and(
        eq(userLocationCashAccounts.userId, userId),
        eq(userLocationCashAccounts.companyId, companyId),
        eq(userLocationCashAccounts.locationId, parsedLocId)
      )
    )
    .limit(1);
  if (locMapping) {
    return { posEnforcedCashAccountId: locMapping.cashAccountId };
  }

  // Legacy fallback: only apply when this user has NO mappings at all
  // (pre-migration POS user). If any mapping exists, this location is
  // simply not configured — block with a clear error instead of using
  // a session account that belongs to a different location.
  const [anyMapping] = await db
    .select({ id: userLocationCashAccounts.id })
    .from(userLocationCashAccounts)
    .where(and(eq(userLocationCashAccounts.userId, userId), eq(userLocationCashAccounts.companyId, companyId)))
    .limit(1);
  if (!anyMapping && sessionCashAccountId) {
    return { posEnforcedCashAccountId: sessionCashAccountId };
  }
  return {
    error: {
      status: 400,
      body: { message: "No cash account assigned for this POS location. Contact admin." },
    },
  };
}

/** Determine account type and ID by validating against actual database records. */
export async function resolvePaymentAccount(params: {
  isCreditSale: boolean | null | undefined;
  paymentAccountId: number | null | undefined;
  cashAccountId: number | null | undefined;
  posEnforcedCashAccountId: number | null;
  companyId: number;
}): Promise<ResolvedPaymentAccount | { error: HandlerErrorResult }> {
  const { isCreditSale, paymentAccountId, cashAccountId, posEnforcedCashAccountId, companyId } = params;

  if (isCreditSale) {
    // Credit sales must use a customer receivable ledger account (Asset type)
    if (!paymentAccountId) {
      return { error: { status: 400, body: { message: "Customer account is required for credit sales" } } };
    }

    const [fetchedCustomerAccount] = await db
      .select()
      .from(ledgerAccounts)
      .where(and(eq(ledgerAccounts.id, paymentAccountId), eq(ledgerAccounts.companyId, companyId)))
      .limit(1);

    if (!fetchedCustomerAccount) {
      return {
        error: {
          status: 400,
          body: { message: "Invalid customer account - account not found or does not belong to this company" },
        },
      };
    }

    if (!isAccountType(fetchedCustomerAccount.accountType, "Asset")) {
      return {
        error: {
          status: 400,
          body: {
            message: `Invalid customer account type: ${fetchedCustomerAccount.accountType}. Credit sales require Asset-type accounts (customer receivables).`,
          },
        },
      };
    }

    return { accountType: "credit", accountId: paymentAccountId, customerAccount: fetchedCustomerAccount };
  } else if (posEnforcedCashAccountId !== null) {
    // POS users: use the server-enforced cash account from user_location_cash_accounts
    return { accountType: "cash", accountId: posEnforcedCashAccountId, customerAccount: null };
  } else if (cashAccountId) {
    // Legacy: cashAccountId parameter - validate it's a cash ledger account in current company
    const [cashLedger] = await db
      .select()
      .from(ledgerAccounts)
      .where(and(eq(ledgerAccounts.id, cashAccountId), eq(ledgerAccounts.companyId, companyId)))
      .limit(1);

    if (!cashLedger) {
      return {
        error: {
          status: 400,
          body: { message: "Invalid cash account - account not found or does not belong to this company" },
        },
      };
    }

    if (!isAccountType(cashLedger.accountType, "Cash")) {
      return {
        error: {
          status: 400,
          body: {
            message: `Invalid cash account type: ${cashLedger.accountType}. The cashAccountId parameter must refer to a Cash-type ledger account.`,
          },
        },
      };
    }

    return { accountType: "cash", accountId: cashAccountId, customerAccount: null };
  } else if (paymentAccountId) {
    // Infer account type by checking if ID exists in ledger accounts or bank accounts
    // IMPORTANT: Scope by company to prevent cross-tenant access
    const [ledgerAccount] = await db
      .select()
      .from(ledgerAccounts)
      .where(and(eq(ledgerAccounts.id, paymentAccountId), eq(ledgerAccounts.companyId, companyId)))
      .limit(1);

    if (ledgerAccount) {
      // It's a ledger account - validate it's appropriate for POS sales
      if (isAccountType(ledgerAccount.accountType, "Cash")) {
        return { accountType: "cash", accountId: paymentAccountId, customerAccount: null };
      } else if (isAccountType(ledgerAccount.accountType, "Asset")) {
        // Asset accounts are customer receivables - should only be used for credit sales
        return {
          error: {
            status: 400,
            body: {
              message:
                "Asset accounts (customer receivables) can only be used for credit sales. Please enable 'Credit Sale' or select a Cash/Bank account.",
            },
          },
        };
      } else {
        // Other ledger account types (Expense, Liability, etc.) are not valid for POS sales
        return {
          error: {
            status: 400,
            body: {
              message: `Invalid payment account type: ${ledgerAccount.accountType}. POS sales require Cash accounts or Bank accounts for cash/bank payments, or Asset accounts for credit sales.`,
            },
          },
        };
      }
    } else {
      // Check if it's a bank account
      const [bankAccount] = await db
        .select()
        .from(bankAccounts)
        .where(and(eq(bankAccounts.id, paymentAccountId), eq(bankAccounts.companyId, companyId)))
        .limit(1);

      if (bankAccount) {
        return { accountType: "bank", accountId: paymentAccountId, customerAccount: null };
      } else {
        return {
          error: {
            status: 400,
            body: { message: "Invalid payment account ID - account not found or does not belong to this company" },
          },
        };
      }
    }
  } else {
    return { error: { status: 400, body: { message: "Payment account is required" } } };
  }
}

/** Get location, validate it exists, belongs to the company, and (for POS users) is assigned to the user. */
export async function validateLocationAccess(params: {
  locationId: number;
  parsedLocationId: number;
  companyId: number;
  isPOSUser: boolean;
  userId: string;
}): Promise<{ location: PosLocation } | { error: HandlerErrorResult }> {
  const { locationId, parsedLocationId, companyId, isPOSUser, userId } = params;

  const location = await storage.getLocationById(locationId);
  if (!location) {
    return { error: { status: 404, body: { message: "Location not found" } } };
  }
  if (location.companyId !== companyId) {
    return { error: { status: 403, body: { message: "Location does not belong to the current company" } } };
  }

  // Fix 2: POS users can only sell from their assigned locations
  if (isPOSUser) {
    const assignedLocs = await db
      .select({ locationId: userLocations.locationId })
      .from(userLocations)
      .where(and(eq(userLocations.userId, userId), eq(userLocations.companyId, companyId)));
    const allowedIds = assignedLocs.map((l) => l.locationId);
    if (!allowedIds.includes(parsedLocationId)) {
      return { error: { status: 403, body: { message: "You are not allowed to sell from this location." } } };
    }
  }

  return { location };
}

/** Fix 5: Verify each stockItemId exists, belongs to this company, and is not deleted/merged. */
export async function validateStockItemsExist(
  companyId: number,
  items: PosSaleItemInput[]
): Promise<{ error: HandlerErrorResult } | null> {
  for (const item of items) {
    const [si] = await db
      .select({ id: stockItems.id, name: stockItems.name, deletedAt: stockItems.deletedAt })
      .from(stockItems)
      .where(and(eq(stockItems.id, item.stockItemId), eq(stockItems.companyId, companyId)))
      .limit(1);
    if (!si) {
      return {
        error: {
          status: 400,
          body: {
            message: `Item ID ${item.stockItemId} does not exist or does not belong to this company.`,
            code: "ITEM_NOT_FOUND",
            invalidItemId: item.stockItemId,
          },
        },
      };
    }
    if (si.deletedAt) {
      return {
        error: {
          status: 400,
          body: {
            message: `This item was merged or deleted. Please select it again.`,
            code: "ITEM_DELETED",
            invalidItemId: item.stockItemId,
          },
        },
      };
    }
  }
  return null;
}
