import type { Express, RequestHandler } from "express";
import { pool } from "../db";
import { edgeBlocksWrite, edgeStatusPayload, readFactoryEdgeConfiguration } from "./edgeRuntimePolicy.mjs";
import { hasFactoryEdgeData } from "./edgeDatabaseProof.mjs";
import { hasVerifiedPhase7WriterAuthority } from "./phase7WriterGate.mjs";
import { supportsPhase8LanVoucherCapture } from "./phase8CapturePolicy.mjs";
import { Phase9StatusRefusal, readPhase9OperationStatus } from "./phase9OperationStatus.mjs";
import { registerCloudEdgeSyncReceiver } from "./edgeSyncReceiver";

type EdgeConfiguration = ReturnType<typeof readFactoryEdgeConfiguration>;

export function makeFactoryEdgeWriteGuard(
  config: EdgeConfiguration,
  hasApprovedData: () => Promise<boolean>,
  hasWriterAuthority: () => Promise<boolean> = async () => false
): RequestHandler {
  return async (req, res, next) => {
    const path = req.originalUrl.split("?")[0];
    if (edgeBlocksWrite(config, req.method, path)) {
      const code = config.mode === "cloud" ? "CLOUD_WRITES_FENCED" : config.primary ? "EDGE_SYNC_UNSUPPORTED_OPERATION" : "EDGE_READ_ONLY";
      return res.status(423).json({ code, message: code });
    }

    // Phase 8 supports only the protected central USD journal route.
    // Do not let the legacy compatibility fallback or arbitrary voucher
    // payloads create local records that Phase 8 cannot safely replay.
    if (config.mode === "lan" && config.primary &&
        req.method.toUpperCase() === "POST" && path === "/api/vouchers/with-entries" &&
        !supportsPhase8LanVoucherCapture(req.body)) {
      return res.status(423).json({ code: "EDGE_PHASE8_CAPTURE_UNSUPPORTED" });
    }

    // When operator cutover was explicitly acknowledged, still reject writes
    // against a blank/unprovisioned local database.
    if (config.mode === "lan" && config.primary && !["GET", "HEAD", "OPTIONS"].includes(req.method.toUpperCase())) {
      try {
        if (!(await hasApprovedData())) {
          return res.status(503).json({ code: "EDGE_DATABASE_NOT_PROVISIONED" });
        }
      } catch {
        return res.status(503).json({ code: "EDGE_DATABASE_NOT_PROVISIONED" });
      }
    }
    // Phase 7: even a populated database + manual operator ACK must not
    // unlock transactions unless an independently installed DB fence is live.
    if (config.mode === "lan" && config.primary && !["GET", "HEAD", "OPTIONS"].includes(req.method.toUpperCase())) {
      try {
        if (!(await hasWriterAuthority())) {
          return res.status(503).json({ code: "EDGE_PHASE7_WRITER_AUTHORITY_UNVERIFIED" });
        }
      } catch {
        return res.status(503).json({ code: "EDGE_PHASE7_WRITER_AUTHORITY_UNVERIFIED" });
      }
    }
    next();
  };
}

/** Same-origin endpoint lets laptops confirm which independent server they use. */
export function registerFactoryEdgeBoundary(app: Express): void {
  const config = readFactoryEdgeConfiguration();
  let lastCheck: { value: boolean; at: number } | null = null;
  async function provisioned(): Promise<boolean> {
    const now = Date.now();
    if (lastCheck && now - lastCheck.at < 3_000) return lastCheck.value;
    const value = await hasFactoryEdgeData(pool);
    lastCheck = { value, at: now };
    return value;
  }

  app.get("/api/edge/status", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    // Phase 9: an optional per-operation projection; never expose another
    // actor's vouchers or infer cloud application from a browser 2xx/stage ACK.
    // Kept on the existing status route to preserve the route manifest.
    if (req.query.operationId !== undefined) {
      if (config.mode !== "lan") return res.status(404).json({ code: "EDGE_OPERATION_NOT_FOUND" });
      const userId = req.session?.userId;
      const companyId = req.session?.currentCompanyId;
      if (!userId || !Number.isSafeInteger(companyId) || Number(companyId) <= 0) {
        return res.status(401).json({ code: "EDGE_OPERATION_AUTH_REQUIRED" });
      }
      if (typeof req.query.operationId !== "string") {
        return res.status(400).json({ code: "PHASE9_STATUS_SCOPE_INVALID" });
      }
      try {
        const status = await readPhase9OperationStatus(pool, {
          siteId: config.siteId,
          operationId: req.query.operationId,
          companyId: Number(companyId),
          actorUserId: userId,
        });
        if (!status) return res.status(404).json({ code: "EDGE_OPERATION_NOT_FOUND" });
        return res.json(status);
      } catch (error) {
        if (error instanceof Phase9StatusRefusal) {
          return res.status(400).json({ code: "PHASE9_STATUS_SCOPE_INVALID" });
        }
        return res.status(503).json({ code: "EDGE_OPERATION_STATUS_UNAVAILABLE" });
      }
    }
    if (config.mode !== "lan") return res.json(edgeStatusPayload(config));
    return res.json(edgeStatusPayload(config, await provisioned()));
  });
  // Staging-only, HMAC-authenticated cloud receiver. No posted business effects.
  registerCloudEdgeSyncReceiver(app);
  app.use("/api", makeFactoryEdgeWriteGuard(config, provisioned, () => hasVerifiedPhase7WriterAuthority(pool, config)));
}
