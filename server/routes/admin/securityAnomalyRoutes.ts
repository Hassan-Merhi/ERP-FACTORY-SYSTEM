import type { Express, Request, Response } from "express";
import { logger } from "../../lib/logger";
import { db } from "../../db";
import { requireAuth, requireRole } from "../../auth";
import { loadCompanySecurityAnomalies } from "../../services/security/securityAuditRuntime";
import { listLegacyPasswordHashUsers } from "../../services/security/legacyPasswordRehash";

export function registerSecurityAnomalyRoutes(app: Express) {
  app.get(
    "/api/admin/security-anomalies",
    requireAuth,
    requireRole("Admin", "Developer"),
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.currentCompanyId;
        if (!companyId) return res.status(403).json({ message: "Forbidden" });
        const result = await loadCompanySecurityAnomalies(db, companyId, {
          windowMs: 15 * 60 * 1000,
          denialThreshold: 5,
          limit: 500,
        });
        return res.json({
          companyId,
          generatedAt: new Date().toISOString(),
          ...result,
        });
      } catch (error) {
        logger.error("Security anomaly query failed:", { error: error });
        return res.status(500).json({ message: "Failed to load security anomalies" });
      }
    }
  );

  // Phase 26 leftover: users of the active company still on a legacy SHA-256
  // password digest (rehashed to bcrypt on their next successful check).
  app.get(
    "/api/admin/security/legacy-password-hashes",
    requireAuth,
    requireRole("Admin", "Owner", "Developer"),
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.currentCompanyId;
        if (!companyId) return res.status(403).json({ message: "Forbidden" });
        const usersOnLegacyHash = await listLegacyPasswordHashUsers(companyId);
        return res.json({
          companyId,
          generatedAt: new Date().toISOString(),
          status: usersOnLegacyHash.length > 0 ? "warn" : "pass",
          count: usersOnLegacyHash.length,
          users: usersOnLegacyHash,
        });
      } catch (error) {
        logger.error("Legacy password hash diagnostic failed:", { error: error });
        return res.status(500).json({ message: "Failed to load the legacy password diagnostic" });
      }
    }
  );
}
