/**
 * Full offline mode (Phase A): a PC downloads the changes that keep its local
 * copy current.
 *
 * Off unless OFFLINE_PC_SYNC_ENABLED=1; until then the route answers 404
 * OFFLINE_PC_SYNC_DISABLED and reads nothing. It also needs the change feed a
 * DBA installs (scripts/pc-sync/render-change-feed-sql.mjs); without it the
 * route answers 503 OFFLINE_PC_SYNC_NOT_INSTALLED.
 *
 * GET /api/offline/pc-sync/changes?cursor=<opaque>&limit=<1-1000>
 *   200 { changes, cursor, upToDate }: the next page for every company the
 *   signed-in user may open (the same rule as the company selector).
 *   422 OFFLINE_PC_SYNC_CURSOR_INVALID for a cursor this server did not issue.
 */
import type { Express, Request, Response } from "express";
import { requireAuth } from "../../auth";
import { pool } from "../../db";
import { logger } from "../../lib/logger";
import { getAccessibleCompanyIds } from "../../security/companyAccessBoundary";
import {
  PcSyncCursorInvalid,
  decodePcSyncCursor,
  pcSyncInstalled,
  readPcSyncPage,
} from "../../offline/pcSync/changeFeedReader";

export function pcSyncEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OFFLINE_PC_SYNC_ENABLED === "1";
}

export function registerPcSyncRoutes(app: Express): void {
  app.get("/api/offline/pc-sync/changes", requireAuth, async (req: Request, res: Response) => {
    if (!pcSyncEnabled()) return res.status(404).json({ code: "OFFLINE_PC_SYNC_DISABLED" });
    const userId = req.session.userId == null ? "" : String(req.session.userId);
    if (!userId) return res.status(401).json({ code: "OFFLINE_PC_SYNC_SESSION_REQUIRED" });

    let cursor;
    try {
      cursor = decodePcSyncCursor(req.query.cursor);
    } catch (error) {
      if (error instanceof PcSyncCursorInvalid) return res.status(422).json({ code: error.message });
      throw error;
    }
    const limit = Number(req.query.limit ?? 0) || undefined;

    const client = await pool.connect();
    try {
      if (!(await pcSyncInstalled(client))) {
        return res.status(503).json({ code: "OFFLINE_PC_SYNC_NOT_INSTALLED" });
      }
      const companyIds = [...(await getAccessibleCompanyIds(userId))];
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json(await readPcSyncPage(client, companyIds, cursor, limit));
    } catch (error) {
      logger.error("PC sync change feed read failed", { error });
      return res.status(503).json({ code: "OFFLINE_PC_SYNC_RETRY" });
    } finally {
      client.release();
    }
  });
}
