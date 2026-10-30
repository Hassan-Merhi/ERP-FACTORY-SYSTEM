import type { Express } from "express";
import { pool } from "../db";
import { EdgeStageConflict, stageVoucherEvents } from "./edgeCloudStaging";
import {
  EDGE_SYNC_STAGE_PATH,
  readCloudSyncStageConfiguration,
  verifyStageSignature,
} from "./edgeSyncStageProtocol.mjs";

/**
 * Dedicated non-browser transport authenticated by per-factory HMAC.
 * Registered before CSRF/browser guards because this is not a session action.
 * Never bypass this signature for any other route or business mutation.
 */
export function registerCloudEdgeSyncReceiver(app: Express): void {
  const config = readCloudSyncStageConfiguration();
  if (!config.enabled) return;
  app.post(EDGE_SYNC_STAGE_PATH, async (req, res) => {
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
