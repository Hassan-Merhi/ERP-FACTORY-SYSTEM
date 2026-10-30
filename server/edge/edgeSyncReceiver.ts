import type { Express, Request, Response } from "express";
import { pool } from "../db";
import { edgeSyncRateLimit } from "./edgeRateLimit";
import { EdgeStageConflict, stageVoucherEvents } from "./edgeCloudStaging";
import { getAppliedCloudReceipts, PHASE8_RECEIPT_QUERY_PATH } from "./phase8AppliedReceipts.mjs";
import {
  EDGE_SYNC_STAGE_PATH,
  EVENT_STAGE_SIGNATURE_DOMAIN,
  readCloudSyncStageConfiguration,
  verifyStageSignature,
} from "./edgeSyncStageProtocol.mjs";
import { EDGE_EVENT_RECEIPT_QUERY_PATH, EDGE_EVENT_STAGE_PATH } from "./phase9EventProtocol.mjs";
import { getPhase9AppliedReceipts, Phase9StageConflict, stagePhase9Events } from "./phase9CloudEventStore.mjs";
import { EdgeRefusal } from "./edgeRefusal";

/** HTTPS + exact event-domain HMAC; false means a response was already sent. */
function acceptSignedEvent(req: Request, res: Response, secret: string): boolean {
  res.setHeader("Cache-Control", "no-store");
  if (process.env.NODE_ENV === "production" && !req.secure) {
    res.status(403).json({ code: "EDGE_SYNC_HTTPS_REQUIRED" });
    return false;
  }
  try {
    if (!Buffer.isBuffer(req.rawBody)) throw new EdgeRefusal("EDGE_EVENT_RAW_BODY_MISSING");
    verifyStageSignature(
      req.rawBody,
      req.get("X-Factory-Sync-Timestamp") ?? "",
      req.get("X-Factory-Sync-Signature") ?? "",
      secret,
      Date.now() / 1000,
      EVENT_STAGE_SIGNATURE_DOMAIN
    );
    return true;
  } catch {
    res.status(401).json({ code: "EDGE_SYNC_AUTH_FAILED" });
    return false;
  }
}

/**
 * Dedicated non-browser transport authenticated by per-factory HMAC.
 * Registered before CSRF/browser guards because this is not a session action.
 * Never bypass this signature for any other route or business mutation.
 */
export function registerCloudEdgeSyncReceiver(app: Express): void {
  const config = readCloudSyncStageConfiguration();
  if (!config.enabled) return;
  // Phase 8: a separately opt-in, READ-ONLY receipt lookup. It never
  // invokes posting and cannot convert "staged" to "applied" on its own.
  if (process.env.FACTORY_PHASE8_RECEIPTS_ENABLED === "1") {
    app.post(PHASE8_RECEIPT_QUERY_PATH, edgeSyncRateLimit, async (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      if (process.env.NODE_ENV === "production" && !req.secure) {
        return res.status(403).json({ code: "EDGE_SYNC_HTTPS_REQUIRED" });
      }
      try {
        if (!Buffer.isBuffer(req.rawBody)) throw new EdgeRefusal("PHASE8_RAW_BODY_MISSING");
        verifyStageSignature(
          req.rawBody,
          req.get("X-Factory-Sync-Timestamp") ?? "",
          req.get("X-Factory-Sync-Signature") ?? "",
          config.secret
        );
      } catch {
        return res.status(401).json({ code: "EDGE_SYNC_AUTH_FAILED" });
      }
      try {
        return res.status(200).json(await getAppliedCloudReceipts(pool, req.body, config.siteId));
      } catch (error) {
        if (error instanceof Error && error.message === "PHASE8_RECEIPT_QUERY_INVALID") {
          return res.status(400).json({ code: error.message });
        }
        return res.status(503).json({ code: "PHASE8_RECEIPT_QUERY_UNAVAILABLE" });
      }
    });
  }

  // Phase 9: generic business-event streams (pressing). Staging only; the
  // operator apply CLI is the single path that posts business effects.
  app.post(EDGE_EVENT_STAGE_PATH, edgeSyncRateLimit, async (req, res) => {
    if (!acceptSignedEvent(req, res, config.secret)) return;
    try {
      return res.status(200).json(await stagePhase9Events(pool, req.body, config.siteId));
    } catch (error) {
      if (error instanceof Phase9StageConflict) return res.status(409).json({ code: error.message });
      if (error instanceof Error && error.message.startsWith("EDGE_EVENT_")) {
        return res.status(400).json({ code: error.message });
      }
      return res.status(503).json({ code: "EDGE_EVENT_STAGE_UNAVAILABLE" });
    }
  });
  if (process.env.FACTORY_PHASE9_RECEIPTS_ENABLED === "1") {
    app.post(EDGE_EVENT_RECEIPT_QUERY_PATH, edgeSyncRateLimit, async (req, res) => {
      if (!acceptSignedEvent(req, res, config.secret)) return;
      try {
        return res.status(200).json(await getPhase9AppliedReceipts(pool, req.body, config.siteId));
      } catch (error) {
        if (error instanceof Error && error.message === "PHASE9_RECEIPT_QUERY_INVALID") {
          return res.status(400).json({ code: error.message });
        }
        return res.status(503).json({ code: "PHASE9_RECEIPT_QUERY_UNAVAILABLE" });
      }
    });
  }

  app.post(EDGE_SYNC_STAGE_PATH, edgeSyncRateLimit, async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (process.env.NODE_ENV === "production" && !req.secure) {
      return res.status(403).json({ code: "EDGE_SYNC_HTTPS_REQUIRED" });
    }
    try {
      // Express rawBody is declared unknown, and a missing/non-buffer raw
      // payload cannot be authenticated. Reject rather than coercing it.
      if (!Buffer.isBuffer(req.rawBody)) {
        return res.status(401).json({ code: "EDGE_SYNC_AUTH_FAILED" });
      }
      verifyStageSignature(
        req.rawBody,
        req.get("X-Factory-Sync-Timestamp") ?? "",
        req.get("X-Factory-Sync-Signature") ?? "",
        config.secret
      );
    } catch {
      return res.status(401).json({ code: "EDGE_SYNC_AUTH_FAILED" });
    }
    try {
      const receipt = await stageVoucherEvents(pool, req.body, config.siteId);
      return res.status(200).json(receipt);
    } catch (error) {
      if (error instanceof EdgeStageConflict) return res.status(409).json({ code: error.message });
      if (error instanceof Error && error.message.startsWith("EDGE_SYNC_")) {
        return res.status(400).json({ code: error.message });
      }
      return res.status(503).json({ code: "EDGE_SYNC_STAGE_UNAVAILABLE" });
    }
  });
}
