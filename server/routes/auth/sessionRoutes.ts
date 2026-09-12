import type { Express, Response } from "express";

import { requireAuth } from "../../auth";
import { getErrorMessage } from "../../lib/httpHandlers";
import { SessionRouteError, sessionService } from "./sessionService";

function sendSessionError(res: Response, error: unknown): Response {
  const statusCode = error instanceof SessionRouteError ? error.statusCode : 500;
  return res.status(statusCode).json({ message: getErrorMessage(error) });
}

export function registerSessionRoutes(app: Express) {
  app.get("/api/sessions", requireAuth, async (req, res) => {
    try {
      return res.json(
        await sessionService.list({
          userId: req.session.userId,
          role: req.session.currentRole,
          currentSid: req.sessionID,
        }),
      );
    } catch (error: unknown) {
      return sendSessionError(res, error);
    }
  });

  app.delete("/api/sessions/:sid", requireAuth, async (req, res) => {
    try {
      return res.json(
        await sessionService.revoke({
          sid: req.params.sid,
          userId: req.session.userId,
          role: req.session.currentRole,
        }),
      );
    } catch (error: unknown) {
      return sendSessionError(res, error);
    }
  });

  app.delete("/api/sessions", requireAuth, async (req, res) => {
    try {
      return res.json(await sessionService.revokeOthers(req.session.userId, req.sessionID));
    } catch (error: unknown) {
      return sendSessionError(res, error);
    }
  });

  app.get("/api/login-history", requireAuth, async (req, res) => {
    try {
      return res.json(
        await sessionService.loginHistory(req.session.currentRole, req.session.currentCompanyId),
      );
    } catch (error: unknown) {
      return sendSessionError(res, error);
    }
  });
}
