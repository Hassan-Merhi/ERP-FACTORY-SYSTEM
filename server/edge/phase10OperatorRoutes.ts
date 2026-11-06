/**
 * Phase 10 operator buttons (owner decision 2026-11-05, plan batch 1).
 *
 * Factory LAN server: POST /api/edge/operator/sync-control pauses or resumes
 * LAN -> cloud delivery. Admin/Owner of the active company only.
 *
 * Cloud operator console (the cloud instance started with the Phase 9 apply
 * settings: fenced, apply enabled and acknowledged, approved site/company):
 * GET /api/edge/operator/conflicts lists held events and POST
 * /api/edge/operator/conflicts/decide approves (overridable codes only) or
 * rejects one. Admin/Developer of the approved company only. On an ordinary
 * cloud instance both answer 404 EDGE_OPERATOR_CONSOLE_DISABLED.
 *
 * Every write needs the user's password again and a reason of at least 10
 * characters, and goes through a DBA-owned database function that re-checks
 * the user's current role (server/edge/phase10OperatorControls.mjs).
 */
import type { Express, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import { requireAuth } from "../auth";
import { pool } from "../db";
import { storage } from "../storage";
import {
  assertActiveCompanyAccess,
  CompanyAccessError,
  sendCompanyAccessError,
} from "../security/companyAccessBoundary";
import {
  ActiveCompanyPermissionContextError,
  getActiveCompanyPermissionContext,
} from "../services/security/activeCompanyPermissionContext";
import { verifyPasswordBcryptOnly } from "../routes/helpers/passwordHelpers";
import type { readFactoryEdgeConfiguration } from "./edgeRuntimePolicy.mjs";
import { readPhase10SyncControl } from "./phase10SyncControl.mjs";
import {
  decidePhase10Conflict,
  listPhase10OpenConflicts,
  Phase10OperatorRefusal,
  recordPhase10OperatorSyncControl,
} from "./phase10OperatorControls.mjs";
import { readPhase9OperatorConfig } from "./phase9OperatorApply";

type EdgeConfiguration = ReturnType<typeof readFactoryEdgeConfiguration>;

const operatorWriteLimit = rateLimit({
  windowMs: 60_000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({ code: "EDGE_OPERATOR_RATE_LIMITED" }),
});

class OperatorAccessRefusal extends Error {
  constructor(
    readonly code: string,
    readonly status: number
  ) {
    super(code);
  }
}

/** The signed-in user, an allowed role in the active company, and (for writes) their password again. */
async function operatorContext(req: Request, roles: readonly string[], password?: unknown) {
  await assertActiveCompanyAccess(req);
  const ctx = await getActiveCompanyPermissionContext(req);
  if (!roles.includes(ctx.role) || ctx.posViewOnly) throw new OperatorAccessRefusal("EDGE_OPERATOR_ROLE_REQUIRED", 403);
  const userId = String(req.session.userId ?? "");
  const companyId = Number(req.session.currentCompanyId);
  if (password !== undefined) {
    const user = typeof password === "string" && password.length > 0 ? await storage.getUser(userId) : undefined;
    if (!user?.password || !(await verifyPasswordBcryptOnly(String(password), user.password))) {
      throw new OperatorAccessRefusal("EDGE_OPERATOR_PASSWORD_INVALID", 401);
    }
  }
  return { userId, companyId };
}

function sendOperatorError(res: Response, error: unknown, fallback: string) {
  if (error instanceof OperatorAccessRefusal || error instanceof Phase10OperatorRefusal) {
    return res.status(error.status).json({ code: error.message });
  }
  if (error instanceof CompanyAccessError) return sendCompanyAccessError(res, error);
  if (error instanceof ActiveCompanyPermissionContextError) {
    return res.status(error.status).json({ code: error.code });
  }
  return res.status(503).json({ code: fallback });
}

/** The cloud operator console configuration, or null on an ordinary cloud instance. */
function cloudOperatorConsole() {
  try {
    return readPhase9OperatorConfig();
  } catch {
    return null;
  }
}

export function registerPhase10OperatorRoutes(app: Express, config: EdgeConfiguration) {
  if (config.mode === "lan") {
    app.post("/api/edge/operator/sync-control", operatorWriteLimit, requireAuth, async (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      try {
        const { userId, companyId } = await operatorContext(req, ["Admin", "Owner"], req.body?.password);
        await recordPhase10OperatorSyncControl(pool, {
          siteId: String(config.siteId),
          companyId,
          userId,
          action: req.body?.action,
          reason: req.body?.reason,
        });
        return res.json(await readPhase10SyncControl(pool, String(config.siteId)));
      } catch (error) {
        return sendOperatorError(res, error, "EDGE_OPERATOR_SYNC_CONTROL_UNAVAILABLE");
      }
    });
    return;
  }

  app.get("/api/edge/operator/conflicts", requireAuth, async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const console = cloudOperatorConsole();
    if (!console) return res.status(404).json({ code: "EDGE_OPERATOR_CONSOLE_DISABLED" });
    try {
      const { companyId } = await operatorContext(req, ["Admin", "Developer"]);
      if (companyId !== console.companyId) return res.status(403).json({ code: "EDGE_OPERATOR_COMPANY_MISMATCH" });
      return res.json({
        siteId: console.siteId,
        conflicts: await listPhase10OpenConflicts(pool, { siteId: console.siteId, companyId }),
      });
    } catch (error) {
      return sendOperatorError(res, error, "EDGE_OPERATOR_CONFLICTS_UNAVAILABLE");
    }
  });

  app.post("/api/edge/operator/conflicts/decide", operatorWriteLimit, requireAuth, async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const console = cloudOperatorConsole();
    if (!console) return res.status(404).json({ code: "EDGE_OPERATOR_CONSOLE_DISABLED" });
    try {
      const { userId, companyId } = await operatorContext(req, ["Admin", "Developer"], req.body?.password);
      if (companyId !== console.companyId) return res.status(403).json({ code: "EDGE_OPERATOR_COMPANY_MISMATCH" });
      return res.json(
        await decidePhase10Conflict(pool, {
          siteId: console.siteId,
          stream: req.body?.stream,
          sequence: String(req.body?.sequence ?? ""),
          decision: req.body?.decision,
          userId,
          reason: req.body?.reason,
        })
      );
    } catch (error) {
      return sendOperatorError(res, error, "EDGE_OPERATOR_DECISION_UNAVAILABLE");
    }
  });
}
