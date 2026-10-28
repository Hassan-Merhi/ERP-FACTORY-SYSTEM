import type { Express } from "express";
import { requireAuth, requireRole } from "../../auth";
import { logger } from "../../lib/logger";
import { issueGlobalForceRefresh } from "../../services/globalForceRefresh";

export function registerGlobalForceRefreshRoutes(app: Express): void {
  // This is a GLOBAL operational action. Never accept a company ID or target
  // user list from the request; all authenticated ERP + Factory clients watch
  // the same persisted epoch. CSRF enforcement is applied by server/index.ts.
  app.post(
    "/api/admin/force-refresh-all",
    requireAuth,
    requireRole("Admin", "Owner", "Developer"),
    async (req, res) => {
      try {
        const issued = await issueGlobalForceRefresh();
        if (!issued) {
          return res.status(429).json({
            message: "A global refresh was already requested recently. Try again in 30 seconds.",
          });
        }

        logger.info("[GlobalForceRefresh] All-session reload requested", {
          actorId: req.session.userId ?? null,
          actorRole: req.session.currentRole ?? null,
          issuedAt: issued.issuedAt,
        });
        return res.json({ ok: true, token: issued.token, issuedAt: issued.issuedAt });
      } catch (error) {
        logger.error("[GlobalForceRefresh] Could not issue reload", { error });
        return res.status(500).json({ message: "Could not request global refresh" });
      }
    }
  );
}
