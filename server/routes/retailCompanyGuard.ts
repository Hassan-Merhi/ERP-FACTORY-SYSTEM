import type { Request, Response } from "express";
import { eq } from "drizzle-orm";
import { companies } from "@shared/schema";
import { db } from "../db";

/**
 * Retail inventory routes only serve Retail / Variant Inventory companies.
 * Writes the 400/403 response itself and returns null when the request must
 * not proceed (shared by retailRoutes.ts and retailSupplierImportRoutes.ts).
 */
export async function requireRetailCompany(req: Request, res: Response): Promise<number | null> {
  const companyId = req.session.currentCompanyId;
  if (!companyId) {
    res.status(400).json({ message: "No company selected" });
    return null;
  }

  const [company] = await db
    .select({ companyType: companies.companyType })
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1);

  if (!company || company.companyType !== "retail") {
    res.status(403).json({
      message: "Retail inventory is only available for Retail / Variant Inventory companies",
    });
    return null;
  }

  return companyId;
}
