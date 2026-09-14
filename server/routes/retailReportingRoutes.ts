import type { Express, Request, Response } from "express";
import { and, eq } from "drizzle-orm";
import { companies, locations } from "@shared/schema";
import { requireAuth, requireNonPOS } from "../auth";
import { db } from "../db";
import { getErrorMessage } from "../lib/httpHandlers";
import { getRetailDashboard, runRetailAudit } from "../services/retail/retailReporting";

function parseDate(value: unknown, fallback: Date): Date {
  if (typeof value !== "string" || !value.trim()) return fallback;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

function parseOptionalPositiveInteger(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

async function requireRetailCompany(req: Request, res: Response): Promise<number | null> {
  const companyId = Number(req.session.currentCompanyId);
  if (!Number.isInteger(companyId) || companyId <= 0) {
    res.status(400).json({ message: "No company selected" });
    return null;
  }

  const [company] = await db
    .select({ companyType: companies.companyType })
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1);

  if (!company || company.companyType !== "retail") {
    res.status(403).json({ message: "Retail reporting is only available for Retail / Variant Inventory companies" });
    return null;
  }
  return companyId;
}

async function validateLocation(companyId: number, locationId?: number): Promise<void> {
  if (!locationId) return;
  const [location] = await db
    .select({ id: locations.id })
    .from(locations)
    .where(and(eq(locations.id, locationId), eq(locations.companyId, companyId), eq(locations.active, true)))
    .limit(1);
  if (!location) throw new Error("Retail report location is not active or does not belong to the selected company");
}

export function registerRetailReportingRoutes(app: Express): void {
  app.get("/api/retail/reporting/dashboard", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = await requireRetailCompany(req, res);
      if (!companyId) return;

      const now = new Date();
      const defaultFrom = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      const from = parseDate(req.query.from, defaultFrom);
      const to = parseDate(req.query.to, now);
      const locationId = parseOptionalPositiveInteger(req.query.locationId);
      const slowMovingDays = parseOptionalPositiveInteger(req.query.slowMovingDays) ?? 60;
      const limit = Math.min(parseOptionalPositiveInteger(req.query.limit) ?? 10, 50);

      if (from >= to) return res.status(400).json({ message: "Report start date must be before end date" });
      await validateLocation(companyId, locationId);

      res.json(await getRetailDashboard({ companyId, from, to, locationId, slowMovingDays, limit }));
    } catch (error) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/retail/reporting/audit", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = await requireRetailCompany(req, res);
      if (!companyId) return;
      res.json(await runRetailAudit(companyId));
    } catch (error) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/retail/reporting/readiness", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = await requireRetailCompany(req, res);
      if (!companyId) return;
      const audit = await runRetailAudit(companyId);
      res.status(audit.ready ? 200 : 409).json({
        ready: audit.ready,
        blockingErrors: audit.errors,
        warnings: audit.warnings,
        checks: {
          posToStock: !audit.issues.some((issue) => issue.code === "duplicate_pos_deductions"),
          returnsToStock: !audit.issues.some((issue) => issue.code === "return_stock_restoration"),
          transferConservation: !audit.issues.some((issue) => issue.code === "transfer_conservation"),
          inventoryToMovementHistory: !audit.issues.some(
            (issue) => issue.code === "incorrect_inventory_totals" || issue.code === "movement_chain_break"
          ),
          variantIntegrity: !audit.issues.some(
            (issue) => issue.code === "duplicate_barcodes" || issue.code === "orphan_variants"
          ),
        },
      });
    } catch (error) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}