import type { Express, Request } from "express";

import { requireAuth } from "../../auth";
import { db } from "../../db";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { storage } from "../../storage";
import { companies } from "@shared/schema";
import { eq } from "drizzle-orm";
import { registerCompanyAccessRoutesPart1 } from "./registerCompanyAccessRoutesPart1";

declare module "express-session" {
  interface SessionData {
    /** Display name of the active company, cached for presence/session reads. Set below when the company is switched. */
    currentCompanyName?: string | null;
  }
}

function saveSession(req: Request): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.save((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

export function registerCompanyAccessRoutes(app: Express) {
  registerCompanyAccessRoutesPart1(app);
  registerCompanyAccessRoutesPart2(app);
}

function registerCompanyAccessRoutesPart2(app: Express) {
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
        .select({ name: companies.name, active: companies.active })
        .from(companies)
        .where(eq(companies.id, companyId))
        .limit(1);

      if (!companyRow?.active) {
        return res.status(409).json({
          message: "This company is inactive. Reactivate it in Company Management before switching.",
          code: "COMPANY_INACTIVE",
        });
      }

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
