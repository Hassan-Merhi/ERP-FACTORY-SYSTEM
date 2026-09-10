import type { Express, Request } from "express";

import { requireAuth, requireRole } from "../../auth";
import { db, pool } from "../../db";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import {
  CompanyAccessError,
  getAccessibleCompanyIds,
  resolveAuthorizedCompanyId,
  sendCompanyAccessError,
} from "../../security/companyAccessBoundary";
import { storage } from "../../storage";
import { companies } from "@shared/schema";
import { eq } from "drizzle-orm";

declare module "express-session" {
  interface SessionData {
    /** Display name of the active company, cached for presence/session reads. Set below when the company is switched. */
    currentCompanyName?: string | null;
  }
}

function disableSessionResponseCaching(res: { setHeader: (name: string, value: string) => void }) {
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Vary", "Cookie");
}

function saveSession(req: Request): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.save((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

class CompanyParentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompanyParentValidationError";
  }
}

function companyTypeRequiresParentDecision(rawCompanyType: unknown): boolean {
  const companyType =
    typeof rawCompanyType === "string" && rawCompanyType.trim().length > 0 ? rawCompanyType.trim() : "erp";
  return companyType !== "properties";
}

async function assertNoParentCycle(companyId: number, parentCompanyId: number): Promise<void> {
  let cursor: number | null = parentCompanyId;
  const visited = new Set<number>();

  for (let depth = 0; cursor !== null && depth < 100; depth += 1) {
    if (cursor === companyId) {
      throw new CompanyParentValidationError(
        "The selected parent company would create a circular company relationship."
      );
    }
    if (visited.has(cursor)) {
      throw new CompanyParentValidationError(
        "The selected parent company belongs to an existing circular company chain."
      );
    }
    visited.add(cursor);

    const current = await storage.getCompanyById(cursor);
    if (!current?.parentCompanyId) return;
    cursor = Number(current.parentCompanyId);
  }

  if (cursor !== null) {
    throw new CompanyParentValidationError("The selected parent company relationship is too deep to validate safely.");
  }
}

async function normalizeParentCompanyId(rawValue: unknown, companyId?: number): Promise<number | null | undefined> {
  if (rawValue === undefined) return undefined;
  if (rawValue === null || rawValue === "" || rawValue === "none") return null;

  const parentCompanyId =
    typeof rawValue === "number"
      ? rawValue
      : typeof rawValue === "string" && rawValue.trim().length > 0
        ? Number(rawValue)
        : NaN;

  if (!Number.isInteger(parentCompanyId) || parentCompanyId <= 0) {
    throw new CompanyParentValidationError("Parent company must be a valid company.");
  }
  if (companyId !== undefined && parentCompanyId === companyId) {
    throw new CompanyParentValidationError("A company cannot be its own parent company.");
  }

  const parentCompany = await storage.getCompanyById(parentCompanyId);
  if (!parentCompany) {
    throw new CompanyParentValidationError("The selected parent company does not exist.");
  }
  if (!parentCompany.active) {
    throw new CompanyParentValidationError("The selected parent company is inactive.");
  }
  if (parentCompany.companyType === "properties") {
    throw new CompanyParentValidationError("A Properties company cannot be used as an accounting parent company.");
  }

  if (companyId !== undefined) {
    await assertNoParentCycle(companyId, parentCompanyId);
  }

  return parentCompanyId;
}

async function prepareCompanyPayload(
  body: unknown,
  companyId?: number,
  requireParentDecision = false
): Promise<Record<string, unknown>> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new CompanyParentValidationError("Company data must be an object.");
  }

  const payload = { ...(body as Record<string, unknown>) };
  const hasParentDecision = Object.prototype.hasOwnProperty.call(payload, "parentCompanyId");

  if (requireParentDecision && companyTypeRequiresParentDecision(payload.companyType) && !hasParentDecision) {
    throw new CompanyParentValidationError(
      "Choose a parent company or explicitly select Standalone / No Parent before creating this company."
    );
  }

  if (hasParentDecision) {
    payload.parentCompanyId = await normalizeParentCompanyId(payload.parentCompanyId, companyId);
  }
  return payload;
}

export function registerCompanyAccessRoutes(app: Express) {
  app.get("/api/companies", requireAuth, async (req, res) => {
    try {
      if (!req.user) return res.status(401).json({ message: "Unauthorized" });
      const accessible = await getAccessibleCompanyIds(req.user.id);
      const allCompanies = await storage.getAllCompanies();
      res.json(allCompanies.filter((company) => accessible.has(Number(company.id))));
    } catch (error: unknown) {
      if (error instanceof CompanyAccessError) return sendCompanyAccessError(res, error);
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/user/companies", requireAuth, async (req, res) => {
    disableSessionResponseCaching(res);
    try {
      if (!req.user) return res.status(401).json({ message: "Unauthorized" });
      if (req.user.role === "Developer") {
        const allCompanies = await storage.getAllCompanies();
        return res.json(
          allCompanies.map((company) => ({
            id: -1,
            userId: req.user!.id,
            companyId: company.id,
            role: "Developer",
            assignedLocationId: null,
            cashAccountId: null,
            posStation: null,
            canSellNegativeStock: true,
            daybookEditDays: 9999,
            canAccessCustomers: true,
            createdAt: new Date(),
            companyCode: company.code,
            companyName: company.name,
            companyActive: company.active,
            companyType: company.companyType || "erp",
          }))
        );
      }

      const { rows } = await pool.query(
        `SELECT
           ucr.id,
           ucr.user_id                  AS "userId",
           ucr.company_id               AS "companyId",
           ucr.role,
           ucr.assigned_location_id     AS "assignedLocationId",
           ucr.cash_account_id          AS "cashAccountId",
           ucr.pos_station              AS "posStation",
           ucr.can_sell_negative_stock  AS "canSellNegativeStock",
           ucr.daybook_edit_days        AS "daybookEditDays",
           ucr.can_access_customers     AS "canAccessCustomers",
           ucr.can_delete_records       AS "canDeleteRecords",
           ucr.pos_view_only            AS "posViewOnly",
           ucr.created_at               AS "createdAt",
           c.code                       AS "companyCode",
           c.name                       AS "companyName",
           c.active                     AS "companyActive",
           COALESCE(c.company_type, 'erp') AS "companyType"
         FROM user_company_roles ucr
         INNER JOIN companies c ON c.id = ucr.company_id
         WHERE ucr.user_id = $1
         ORDER BY c.name`,
        [req.user.id]
      );
      res.json(rows);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/companies", requireAuth, requireRole("Admin"), async (req, res) => {
    try {
      const payload = await prepareCompanyPayload(req.body, undefined, true);
      res.status(201).json(await storage.createCompany(payload as Parameters<typeof storage.createCompany>[0]));
    } catch (error: unknown) {
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/companies/:id", requireAuth, async (req, res) => {
    try {
      const companyId = await resolveAuthorizedCompanyId(req, req.params.id);
      const company = await storage.getCompanyById(companyId);
      if (!company) return res.status(404).json({ message: "Company not found" });
      res.json(company);
    } catch (error: unknown) {
      if (error instanceof CompanyAccessError) return sendCompanyAccessError(res, error);
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  app.patch("/api/companies/:id", requireAuth, requireRole("Admin"), async (req, res) => {
    try {
      const companyId = await resolveAuthorizedCompanyId(req, req.params.id);
      const payload = await prepareCompanyPayload(req.body, companyId);
      res.json(await storage.updateCompany(companyId, payload as Parameters<typeof storage.updateCompany>[1]));
    } catch (error: unknown) {
      if (error instanceof CompanyAccessError) return sendCompanyAccessError(res, error);
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  app.delete("/api/companies/:id", requireAuth, requireRole("Admin"), async (req, res) => {
    try {
      const companyId = await resolveAuthorizedCompanyId(req, req.params.id);
      await storage.deleteCompany(companyId);
      res.json({ message: "Company deleted successfully" });
    } catch (error: unknown) {
      if (error instanceof CompanyAccessError) return sendCompanyAccessError(res, error);
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/auth/session-company", requireAuth, (req, res) => {
    disableSessionResponseCaching(res);
    res.json({ companyId: req.session.currentCompanyId ?? null });
  });

  app.post("/api/auth/set-company", requireAuth, async (req, res) => {
    try {
      const { companyId } = req.body;
      if (!companyId) return res.status(400).json({ message: "Company ID is required" });
      if (!req.user) return res.status(401).json({ message: "Unauthorized" });

      let userRole = await storage.getUserCompanyRole(req.user.id, companyId);
      if (!userRole) {
        if (req.user.role === "Developer") {
          userRole = {
            id: -1,
            userId: req.user.id,
            companyId,
            role: "Developer",
            assignedLocationId: null,
            posStation: null,
            cashAccountId: null,
            canSellNegativeStock: true,
            posViewOnly: false,
            daybookEditDays: 9999,
            canAccessCustomers: true,
            canDeleteRecords: true,
            createdAt: new Date(),
          };
        } else {
          return res.status(403).json({ message: "You don't have access to this company" });
        }
      }

      const [companyRow] = await db
        .select({ name: companies.name })
        .from(companies)
        .where(eq(companies.id, companyId))
        .limit(1);

      req.session.currentCompanyId = companyId;
      delete req.session.factoryCompanyId;
      req.session.currentRole = userRole.role;
      req.session.currentLocationId = userRole.assignedLocationId;
      req.session.currentPOSStation = userRole.posStation;
      req.session.cashAccountId = userRole.cashAccountId;
      req.session.canSellNegativeStock = userRole.canSellNegativeStock;
      req.session.posViewOnly = userRole.posViewOnly ?? false;
      req.session.daybookEditDays = userRole.daybookEditDays;
      req.session.canAccessCustomers = userRole.canAccessCustomers;
      req.session.canDeleteRecords = userRole.canDeleteRecords;
      req.session.currentCompanyName = companyRow?.name ?? null;

      try {
        await saveSession(req);
      } catch (error: unknown) {
        logger.error("Error saving session:", { error });
        return res.status(500).json({ message: "Failed to save session" });
      }

      res.json({ message: "Company set successfully", companyId });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
