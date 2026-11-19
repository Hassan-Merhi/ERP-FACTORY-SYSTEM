/**
 * Full offline mode (Phase B2): a PC delivers the entries it made offline, and
 * an Admin or Developer reviews the negative-stock flags they caused.
 *
 * Off unless OFFLINE_PC_SYNC_ENABLED=1 (404 OFFLINE_PC_SYNC_DISABLED). Delivery
 * also needs the browser offline apply path (OFFLINE_BROWSER_SYNC_ENABLED=1).
 *
 * POST /api/offline/pc-sync/operations
 *   The browser-sync request and answers (200 receipt, 409 conflict, 202
 *   waiting, 422 invalid), except that an entry whose only disagreement is
 *   stock going below zero is applied and flagged (200 with flagged: true).
 * POST /api/offline/pc-sync/files (application/octet-stream, at most 10 MB)
 *   Headers X-Pc-Sync-Device-Id and X-File-Sha256: the bytes of a file the PC
 *   uploaded offline, sent before the file's record. They are kept only when
 *   they hash to the declared SHA-256, for that device; the record's apply
 *   then reads them (and checks size and hash again).
 * GET /api/offline/pc-sync/negative-stock-flags?status=open|all
 *   Admin/Developer of the active company: that company's flags, newest first.
 * POST /api/offline/pc-sync/negative-stock-flags/:id/resolve { note }
 *   Admin/Developer of the active company: closes an open flag with a note.
 */
import express, { type Express, type Request, type Response } from "express";
import { createHash } from "node:crypto";
import { z } from "zod";
import { requireAuth } from "../../auth";
import { pool } from "../../db";
import { logger } from "../../lib/logger";
import {
  applyPcOperation,
  listNegativeStockFlags,
  resolveNegativeStockFlag,
} from "../../offline/pcSync/pcOperationApply";
import { actorOf, guard, refusal } from "./browserSyncRoutes";
import { pcSyncEnabled } from "./pcSyncRoutes";
import { PHASE9_ATTACHMENT_MAX_BYTES } from "../../edge/phase9AttachmentEnvelope.mjs";

const REVIEWER_ROLES = new Set(["Admin", "Developer"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const resolveSchema = z.object({ note: z.string().trim().min(1).max(1000) }).strict();

/** The browser-sync operation, or a finished envelope for an edit or delete (exactly one of the two). */
const pcOperationSchema = z
  .object({
    deviceId: z.string().uuid(),
    operationId: z.string().uuid(),
    kind: z.string().min(1).max(100),
    localRef: z.number().int(),
    capturedAt: z.string().max(40),
    input: z.record(z.string(), z.unknown()).optional(),
    envelope: z.record(z.string(), z.unknown()).optional(),
    override: z.string().max(100).nullable().optional(),
  })
  .strict()
  .refine((body) => (body.input === undefined) !== (body.envelope === undefined));

async function reviewer(req: Request, res: Response): Promise<{ companyId: number; userId: string } | null> {
  if (!pcSyncEnabled()) {
    res.status(404).json({ code: "OFFLINE_PC_SYNC_DISABLED" });
    return null;
  }
  const actor = actorOf(req);
  if (!actor) {
    res.status(400).json({ code: "OFFLINE_PC_SYNC_COMPANY_REQUIRED" });
    return null;
  }
  const { rows } = await pool.query(
    `SELECT r.role FROM user_company_roles r JOIN users u ON u.id = r.user_id
      WHERE r.user_id = $1 AND r.company_id = $2 AND u.active = true`,
    [actor.userId, actor.companyId]
  );
  if (!rows.some((row) => REVIEWER_ROLES.has(String(row.role)))) {
    res.status(403).json({ code: "OFFLINE_PC_SYNC_REVIEWER_REQUIRED" });
    return null;
  }
  return { companyId: actor.companyId, userId: actor.userId };
}

export function registerPcEntryRoutes(app: Express): void {
  app.post(
    "/api/offline/pc-sync/files",
    requireAuth,
    express.raw({ type: "application/octet-stream", limit: PHASE9_ATTACHMENT_MAX_BYTES }),
    async (req: Request, res: Response) => {
      if (!pcSyncEnabled()) return res.status(404).json({ code: "OFFLINE_PC_SYNC_DISABLED" });
      const actor = await guard(req, res);
      if (!actor) return;
      const deviceId = String(req.get("X-Pc-Sync-Device-Id") ?? "").toLowerCase();
      const sha256 = String(req.get("X-File-Sha256") ?? "").toLowerCase();
      const bytes = req.body;
      if (
        !UUID.test(deviceId) ||
        !SHA256.test(sha256) ||
        !Buffer.isBuffer(bytes) ||
        bytes.length < 1 ||
        bytes.length > PHASE9_ATTACHMENT_MAX_BYTES ||
        createHash("sha256").update(bytes).digest("hex") !== sha256
      ) {
        return res.status(422).json({ code: "OFFLINE_PC_SYNC_FILE_INVALID" });
      }
      try {
        await pool.query(
          `INSERT INTO factory_edge_staged_files (site_id, file_sha256, byte_size, content)
           VALUES ($1::uuid, $2, $3, $4) ON CONFLICT (site_id, file_sha256) DO NOTHING`,
          [deviceId, sha256, bytes.length, bytes]
        );
        return res.status(200).json({ staged: true, sha256, byteSize: bytes.length });
      } catch (error) {
        logger.error("[pc-sync] could not keep a file", { error: String(error) });
        return res.status(503).json({ code: "OFFLINE_PC_SYNC_FILE_UNAVAILABLE" });
      }
    }
  );

  app.post("/api/offline/pc-sync/operations", requireAuth, async (req: Request, res: Response) => {
    if (!pcSyncEnabled()) return res.status(404).json({ code: "OFFLINE_PC_SYNC_DISABLED" });
    const actor = await guard(req, res);
    if (!actor) return;
    const parsed = pcOperationSchema.safeParse(req.body);
    if (!parsed.success) return res.status(422).json({ code: "OFFLINE_BROWSER_REQUEST_INVALID" });
    try {
      const result = await applyPcOperation(actor, parsed.data);
      if (result.status === "applied") {
        return res.status(200).json({ ...result.receipt, flagged: "flagged" in result && result.flagged === true });
      }
      if (result.status === "conflict") {
        return res.status(409).json({ code: result.code, overridable: result.overridable, detail: result.detail });
      }
      if (result.status === "waiting") return res.status(202).json({ code: result.code });
      return res.status(422).json({ code: result.code });
    } catch (error) {
      return refusal(res, error);
    }
  });

  app.get("/api/offline/pc-sync/negative-stock-flags", requireAuth, async (req: Request, res: Response) => {
    try {
      const who = await reviewer(req, res);
      if (!who) return;
      const status = req.query.status === "all" ? "all" : "open";
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json({ flags: await listNegativeStockFlags(pool, who.companyId, status) });
    } catch (error) {
      logger.error("Negative stock flags read failed", { error });
      return res.status(503).json({ code: "OFFLINE_PC_SYNC_RETRY" });
    }
  });

  app.post(
    "/api/offline/pc-sync/negative-stock-flags/:id/resolve",
    requireAuth,
    async (req: Request, res: Response) => {
      try {
        const who = await reviewer(req, res);
        if (!who) return;
        const id = Number(req.params.id);
        const parsed = resolveSchema.safeParse(req.body);
        if (!Number.isSafeInteger(id) || id < 1 || !parsed.success) {
          return res.status(422).json({ code: "OFFLINE_PC_SYNC_FLAG_REQUEST_INVALID" });
        }
        if (!(await resolveNegativeStockFlag(pool, who.companyId, id, who.userId, parsed.data.note))) {
          return res.status(404).json({ code: "OFFLINE_PC_SYNC_FLAG_NOT_OPEN" });
        }
        return res.status(200).json({ resolved: true });
      } catch (error) {
        logger.error("Negative stock flag resolve failed", { error });
        return res.status(503).json({ code: "OFFLINE_PC_SYNC_RETRY" });
      }
    }
  );
}
