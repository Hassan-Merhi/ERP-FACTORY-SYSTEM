import type { Request } from "express";
import { and, eq } from "drizzle-orm";
import { userLocations } from "@shared/schema";
import { db } from "../../db";
import { isRetailManagerRole } from "./retailCheckoutPolicy";
import { currentUserId } from "./retailPosContext";

/**
 * Locations the current user may move Retail stock at, or null when the role is
 * unrestricted. Managers and above act company-wide (the convention used by the
 * stock-in-sales and POS location scopes); every other role is limited to its
 * user_locations assignments, and a user with no assignment may act nowhere.
 */
export async function retailAllowedLocationIds(req: Request, companyId: number): Promise<Set<number> | null> {
  if (isRetailManagerRole(req.user?.role)) return null;
  const rows = await db
    .select({ locationId: userLocations.locationId })
    .from(userLocations)
    .where(and(eq(userLocations.userId, currentUserId(req)), eq(userLocations.companyId, companyId)));
  return new Set(rows.map((row) => row.locationId));
}

/** Refusal message when any of the locations is outside the user's assignments, else null. */
export async function retailLocationRefusal(
  req: Request,
  companyId: number,
  locationIds: number[]
): Promise<string | null> {
  const allowed = await retailAllowedLocationIds(req, companyId);
  if (!allowed || locationIds.every((id) => allowed.has(id))) return null;
  return "You are not assigned to this Retail location";
}
