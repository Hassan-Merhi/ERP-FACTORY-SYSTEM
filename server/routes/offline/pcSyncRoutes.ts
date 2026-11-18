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
 *
 * Initial full copy (Phase A2):
 * GET /api/offline/pc-sync/snapshot/start
 *   200 { cursor, tables, schemaVersion }: replay the feed from `cursor` once
 *   every table is loaded; refuse to load when `schemaVersion` differs.
 * GET /api/offline/pc-sync/snapshot?table=<name>&after=<opaque>&limit=<1-1000>
 *   200 { table, rows, after }: one page of one synced table for the user's
 *   companies, secret columns removed; `after` is null when the table is done.
 *   422 OFFLINE_PC_SYNC_TABLE_NOT_SYNCED / OFFLINE_PC_SYNC_AFTER_INVALID.
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
import {
  PcSyncSnapshotRefusal,
  decodePcSyncSnapshotAfter,
  pcSyncSnapshotInstalled,
  readPcSyncSnapshotPage,
  startPcSyncSnapshot,
} from "../../offline/pcSync/snapshotReader";

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

  app.get("/api/offline/pc-sync/snapshot/start", requireAuth, async (req: Request, res: Response) => {
    if (!pcSyncEnabled()) return res.status(404).json({ code: "OFFLINE_PC_SYNC_DISABLED" });
    if (req.session.userId == null) return res.status(401).json({ code: "OFFLINE_PC_SYNC_SESSION_REQUIRED" });
    const client = await pool.connect();
    try {
      if (!(await pcSyncSnapshotInstalled(client))) {
        return res.status(503).json({ code: "OFFLINE_PC_SYNC_NOT_INSTALLED" });
      }
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json(await startPcSyncSnapshot(client));
    } catch (error) {
      logger.error("PC sync snapshot start failed", { error });
      return res.status(503).json({ code: "OFFLINE_PC_SYNC_RETRY" });
    } finally {
      client.release();
    }
  });

  app.get("/api/offline/pc-sync/snapshot", requireAuth, async (req: Request, res: Response) => {
    if (!pcSyncEnabled()) return res.status(404).json({ code: "OFFLINE_PC_SYNC_DISABLED" });
    const userId = req.session.userId == null ? "" : String(req.session.userId);
    if (!userId) return res.status(401).json({ code: "OFFLINE_PC_SYNC_SESSION_REQUIRED" });
    let after;
    try {
      after = decodePcSyncSnapshotAfter(req.query.after);
    } catch (error) {
      if (error instanceof PcSyncSnapshotRefusal) return res.status(422).json({ code: error.message });
      throw error;
    }
    const limit = Number(req.query.limit ?? 0) || undefined;
    const client = await pool.connect();
    try {
      if (!(await pcSyncSnapshotInstalled(client))) {
        return res.status(503).json({ code: "OFFLINE_PC_SYNC_NOT_INSTALLED" });
      }
      const companyIds = [...(await getAccessibleCompanyIds(userId))];
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json(await readPcSyncSnapshotPage(client, companyIds, req.query.table, after, limit));
    } catch (error) {
      if (error instanceof PcSyncSnapshotRefusal) return res.status(422).json({ code: error.message });
      logger.error("PC sync snapshot page failed", { error });
      return res.status(503).json({ code: "OFFLINE_PC_SYNC_RETRY" });
    } finally {
      client.release();
    }
  });
}
