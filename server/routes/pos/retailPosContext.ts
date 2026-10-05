import type { Request, Response } from "express";
import { and, eq } from "drizzle-orm";
import { companies, locations } from "@shared/schema";
import { db } from "../../db";

function currentCompanyId(req: Request): number | null {
  const companyId = Number(req.session.currentCompanyId);
  return Number.isInteger(companyId) && companyId > 0 ? companyId : null;
}

export function currentUserId(req: Request): string {
  const userId = req.user?.id ?? req.session.userId;
  if (!userId) throw new Error("Authenticated user is required");
  return String(userId);
}

export async function requireRetailCompany(req: Request, res: Response): Promise<number | null> {
  const companyId = currentCompanyId(req);
  if (!companyId) {
    res.status(400).json({ message: "No company selected" });
    return null;
  }

  const [company] = await db
    .select({ id: companies.id, companyType: companies.companyType })
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1);

  if (!company || company.companyType !== "retail") {
    res.status(409).json({ message: "Retail POS is only available for Retail / Variant Inventory companies" });
    return null;
  }
  return companyId;
}

export async function ensureCompanyLocation(companyId: number, locationId: number, req?: Request): Promise<void> {
  const role = req?.session?.currentRole ?? req?.user?.role;
  if (role === "POS") {
    const assignedLocationId = Number(req?.user?.assignedLocationId ?? req?.session?.currentLocationId ?? 0);
    if (!Number.isInteger(assignedLocationId) || assignedLocationId <= 0 || assignedLocationId !== locationId) {
      throw new Error("POS users are restricted to their assigned Retail location");
    }
  }
  const [location] = await db
    .select({ id: locations.id })
    .from(locations)
    .where(and(eq(locations.id, locationId), eq(locations.companyId, companyId), eq(locations.active, true)))
    .limit(1);
  if (!location) throw new Error("Location is not active or does not belong to the selected company");
}
