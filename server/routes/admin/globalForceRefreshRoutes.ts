import type { Express } from "express";
import { requireAuth, requireRole } from "../../auth";
import { logger } from "../../lib/logger";
import { issueGlobalForceRefresh, type ForceRefreshTarget } from "../../services/globalForceRefresh";

const ROUTES: ReadonlyArray<{ path: string; target: ForceRefreshTarget }> = [
  // Retain the existing route for compatibility, but it now only targets
  // regular users; administrators, owners, and developers are excluded.
  { path: "/api/admin/force-refresh-all", target: "regular" },
  { path: "/api/admin/force-refresh-privileged", target: "privileged" },
];

export function registerGlobalForceRefreshRoutes(app: Express): void {
  for (const { path, target } of ROUTES) {
    // Both operations are global across companies, role-gated and CSRF
    // protected. Never accept arbitrary target users from a request body.
    app.post(path, requireAuth, requireRole("Admin", "Owner", "Developer"), async (req, res) => {
      try {
        const issued = await issueGlobalForceRefresh(target);
        if (!issued) {
          return res.status(429).json({
            message: "A refresh was already requested for this user group recently. Try again in 30 seconds.",
          });
        }

        logger.info("[GlobalForceRefresh] Role-scoped session reload requested", {
          actorId: req.session.userId ?? null,
          actorRole: req.session.currentRole ?? null,
          target,
          issuedAt: issued.issuedAt,
        });
        return res.json({ ok: true, target, token: issued.token, issuedAt: issued.issuedAt });
      } catch (error) {
        logger.error("[GlobalForceRefresh] Could not issue reload", { error, target });
        return res.status(500).json({ message: "Could not request user refresh" });
      }
    });
  }
}
