import type { Express, Response } from "express";
import { requireAuth } from "../auth";
import {
  type AuthenticatedRequest,
  getAuthenticatedUserId,
  sendHttpError,
} from "../lib/httpHandlers";
import { getUserNotes, saveUserNotes } from "../services/userNotesService";

export function registerUserNotesRoutes(app: Express) {
  // GET /api/user/notes — fetch current user's notes (returns empty string if none)
  app.get("/api/user/notes", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    try {
      res.json(await getUserNotes(getAuthenticatedUserId(req)));
    } catch (error: unknown) {
      sendHttpError(res, error);
    }
  });

  // PUT /api/user/notes — upsert current user's notes
  app.put("/api/user/notes", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const content = typeof req.body.content === "string" ? req.body.content : "";
      await saveUserNotes(getAuthenticatedUserId(req), content);
      res.json({ ok: true });
    } catch (error: unknown) {
      sendHttpError(res, error);
    }
  });
}
