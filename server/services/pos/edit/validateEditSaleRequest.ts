/**
 * server/services/pos/edit/validateEditSaleRequest.ts
 *
 * PHASE 20 structural split — moved from
 * server/routes/pos/posEditSaleRoutes.ts:
 *   - items array / quantity / price validation
 *   - existing voucher lookup + Sales-type validation
 *   - POS-user restrictions
 *   - source/target location resolution + new-location validation
 */
import { db } from "../../../db";
import { logger } from "../../../lib/logger";
import { locations, vouchers } from "@shared/schema";
import { eq, and, isNull } from "drizzle-orm";
import type { HandlerErrorResult, VoucherRow } from "./posEditSaleTypes";

type SelectConnection = Pick<typeof db, "select">;

/** Validates all items have positive quantities and prices. Throws (matching the original) rather than returning an error result. */
export function validateItemsPositive(items: unknown[]): void {
  for (const item of items as Array<{ quantity?: unknown; sellingPrice?: unknown }>) {
    // Items arrive straight from the JSON body; parseFloat's own coercion is
    // preserved by stringifying exactly what the request carried. The thrown
    // messages keep their historical raw template text so the i18n
    // compatibility inventory still covers them.
    const qty = parseFloat(String(item.quantity));
    const price = parseFloat(String(item.sellingPrice));

    if (isNaN(qty) || qty <= 0) {
      throw new Error(`Invalid quantity: ${item.quantity}. Must be greater than 0.`);
    }
    if (isNaN(price) || price <= 0) {
      throw new Error(`Invalid price: ${item.sellingPrice}. Must be greater than 0.`);
    }
  }
}

/** Loads the existing voucher and validates it belongs to the company and is a Sales voucher. */
export async function loadAndValidateExistingVoucher(
  voucherId: number,
  companyId: number
): Promise<{ existingVoucher: VoucherRow } | { error: HandlerErrorResult }> {
  const [existingVoucher] = await db
    .select()
    .from(vouchers)
    .where(and(eq(vouchers.id, voucherId), eq(vouchers.companyId, companyId)))
    .limit(1);

  if (!existingVoucher) {
    return { error: { status: 404, body: { message: "Voucher not found" } } };
  }

  if (existingVoucher.voucherType !== "Sales") {
    return { error: { status: 400, body: { message: "Only Sales vouchers can be updated with this endpoint" } } };
  }

  return { existingVoucher };
}

/**
 * POS restrictions on existing sales:
 *   - Cannot change location: block if a different locationId is sent.
 *   - Payment-account behavior remains compatible with the existing route.
 * Date changes are blocked by the canModifyDate middleware in the route.
 */
export function applyPosRoleRestrictions(
  userRole: string | undefined,
  newLocationId: unknown,
  existingVoucherLocationId: number | null
): { error: HandlerErrorResult } | { ok: true } {
  if (userRole === "POS") {
    if (newLocationId && parseInt(String(newLocationId)) !== existingVoucherLocationId) {
      return { error: { status: 403, body: { message: "POS users cannot change the location of an existing sale" } } };
    }
  }
  return { ok: true };
}

/** Determines the target/old location and whether the location changed. */
export function resolveEditLocations(
  oldLocationId: number,
  newLocationId: unknown
): { targetLocationId: number; oldLocationId: number; locationChanged: boolean } {
  const targetLocationId = newLocationId ? parseInt(String(newLocationId)) : oldLocationId;
  const locationChanged = targetLocationId !== oldLocationId;
  return { targetLocationId, oldLocationId, locationChanged };
}

/**
 * Validates the new location belongs to the company. A transaction connection
 * may be supplied so validation uses the same snapshot as the locked voucher.
 */
export async function validateNewLocationBelongsToCompany(
  targetLocationId: number,
  oldLocationId: number,
  companyId: number,
  connection: SelectConnection = db
): Promise<{ ok: true } | { error: HandlerErrorResult }> {
  const [newLocation] = await connection
    .select()
    .from(locations)
    .where(and(eq(locations.id, targetLocationId), eq(locations.companyId, companyId), isNull(locations.deletedAt)))
    .limit(1);

  if (!newLocation) {
    return { error: { status: 400, body: { message: "Invalid location or location not found" } } };
  }
  logger.info(`[POS Sales Edit] Location changing from ${oldLocationId} to ${targetLocationId}`);
  return { ok: true };
}
