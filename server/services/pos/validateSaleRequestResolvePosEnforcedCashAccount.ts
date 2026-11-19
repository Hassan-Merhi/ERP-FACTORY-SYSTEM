// Extracted from ./validateSaleRequest.ts
import { db } from "../../db";
import { userLocationCashAccounts } from "@shared/schema";
import { eq, and } from "drizzle-orm";
import type { HandlerErrorResult } from "./posSaleTypes";

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
