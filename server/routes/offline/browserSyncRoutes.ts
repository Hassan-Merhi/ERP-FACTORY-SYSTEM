/**
 * Standalone browser offline mode (Phase 14): a laptop's browser delivers the
 * operations it recorded while offline straight to the cloud, one at a time.
 *
 * Off unless OFFLINE_BROWSER_SYNC_ENABLED=1 (the owner enables it with the
 * client feature flag after sign-off); then the routes answer 404
 * OFFLINE_BROWSER_SYNC_DISABLED and change nothing.
 *
 * - POST /api/offline/browser-sync/operations: apply one operation exactly once.
 *   200 with a receipt; 409 with a conflict code (nothing written); 202 when it
 *   waits for an earlier offline record; 422 when the input is not acceptable.
 * - POST /api/offline/browser-sync/operations/discard: the user gives the
 *   operation up; it is recorded as rejected, the cloud is untouched.
 * - POST /api/offline/browser-sync/receipts: receipts this device already has
 *   (recovers an acknowledgement lost in transit).
 *
 * The signed-in session is the actor: user, company and username come from it.
 */
import type { Express, Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "../../auth";
import { logger } from "../../lib/logger";
import {
  BrowserSyncRefusal,
  applyBrowserOperation,
  browserSyncInstalled,
  discardBrowserOperation,
  listBrowserReceipts,
} from "../../offline/browserSync/browserSyncApply";
import { BrowserOperationRefusal, type BrowserActor } from "../../offline/browserSync/browserOperationKinds";

export function browserSyncEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OFFLINE_BROWSER_SYNC_ENABLED === "1";
}

const operationSchema = z
  .object({
    deviceId: z.string().uuid(),
    operationId: z.string().uuid(),
    kind: z.string().min(1).max(100),
    localRef: z.number().int(),
    capturedAt: z.string().max(40),
    input: z.record(z.string(), z.unknown()),
    override: z.string().max(100).nullable().optional(),
  })
  .strict();

const receiptsSchema = z
  .object({ deviceId: z.string().uuid(), operationIds: z.array(z.string().uuid()).max(500) })
  .strict();

function actorOf(req: Request): BrowserActor | null {
  const companyId = Number(req.session.currentCompanyId);
  const userId = req.session.userId == null ? "" : String(req.session.userId);
  if (!Number.isSafeInteger(companyId) || companyId < 1 || !userId) return null;
  return { companyId, userId, username: req.session.username || "unknown" };
}

async function guard(req: Request, res: Response): Promise<BrowserActor | null> {
  if (!browserSyncEnabled()) {
    res.status(404).json({ code: "OFFLINE_BROWSER_SYNC_DISABLED" });
    return null;
  }
  const actor = actorOf(req);
  if (!actor) {
    res.status(400).json({ code: "OFFLINE_BROWSER_COMPANY_REQUIRED" });
    return null;
  }
  if (!(await browserSyncInstalled())) {
    res.status(503).json({ code: "OFFLINE_BROWSER_SYNC_NOT_INSTALLED" });
    return null;
  }
  return actor;
}

function refusal(res: Response, error: unknown): Response {
  if (error instanceof BrowserSyncRefusal) return res.status(error.status).json({ code: error.message });
  if (error instanceof BrowserOperationRefusal) return res.status(422).json({ code: error.message });
  logger.error("Browser offline sync failed", { error });
  // A server or database failure: the browser keeps the operation and retries.
  return res.status(503).json({ code: "OFFLINE_BROWSER_SYNC_RETRY" });
}

export function registerBrowserSyncRoutes(app: Express): void {
  app.post("/api/offline/browser-sync/operations", requireAuth, async (req: Request, res: Response) => {
    const actor = await guard(req, res);
    if (!actor) return;
    const parsed = operationSchema.safeParse(req.body);
    if (!parsed.success) return res.status(422).json({ code: "OFFLINE_BROWSER_REQUEST_INVALID" });
    try {
      const result = await applyBrowserOperation(actor, parsed.data);
      if (result.status === "applied") return res.status(200).json(result.receipt);
      if (result.status === "conflict") {
        return res.status(409).json({ code: result.code, overridable: result.overridable, detail: result.detail });
      }
      if (result.status === "waiting") return res.status(202).json({ code: result.code });
      return res.status(422).json({ code: result.code });
    } catch (error) {
      return refusal(res, error);
    }
  });

  app.post("/api/offline/browser-sync/operations/discard", requireAuth, async (req: Request, res: Response) => {
    const actor = await guard(req, res);
    if (!actor) return;
    const parsed = operationSchema.safeParse(req.body);
    if (!parsed.success) return res.status(422).json({ code: "OFFLINE_BROWSER_REQUEST_INVALID" });
    try {
      return res.status(200).json(await discardBrowserOperation(actor, parsed.data));
    } catch (error) {
      return refusal(res, error);
    }
  });

  app.post("/api/offline/browser-sync/receipts", requireAuth, async (req: Request, res: Response) => {
    const actor = await guard(req, res);
    if (!actor) return;
    const parsed = receiptsSchema.safeParse(req.body);
    if (!parsed.success) return res.status(422).json({ code: "OFFLINE_BROWSER_REQUEST_INVALID" });
    try {
      return res
        .status(200)
        .json({ receipts: await listBrowserReceipts(actor, parsed.data.deviceId, parsed.data.operationIds) });
    } catch (error) {
      return refusal(res, error);
    }
  });
}
