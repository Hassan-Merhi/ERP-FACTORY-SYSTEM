// Extracted from ./edgeBoundary.ts
import type { RequestHandler } from "express";
import rateLimit from "express-rate-limit";
import {
  edgeBlocksWrite,
  PHASE9_PRESSING_CONFIRM_ROUTE,
  phase9ApprovedCaptureRoute,
  readFactoryEdgeConfiguration,
} from "./edgeRuntimePolicy.mjs";
import { supportsPhase8LanVoucherCapture } from "./phase8CapturePolicy.mjs";

type EdgeConfiguration = ReturnType<typeof readFactoryEdgeConfiguration>;

export function makeFactoryEdgeWriteGuard(
  config: EdgeConfiguration,
  hasApprovedData: () => Promise<boolean>,
  hasWriterAuthority: () => Promise<boolean> = async () => false,
  hasPressingCapture: () => Promise<boolean> = async () => false,
  /** Other approved Phase 9 routes: "METHOD /path" -> its DBA-installed outbox check. */
  routeCaptures: Readonly<Record<string, { installed: () => Promise<boolean>; code: string }>> = {}
): RequestHandler[] {
  // Each LAN write runs database authority proofs; bound how often one client
  // can trigger them. Reads and cloud-mode traffic are not counted.
  const limiter = rateLimit({
    windowMs: 60_000,
    max: 600,
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => config.mode !== "lan" || ["GET", "HEAD", "OPTIONS"].includes(req.method.toUpperCase()),
    handler: (_req, res) => res.status(429).json({ code: "EDGE_WRITE_RATE_LIMITED" }),
  });
  const guard: RequestHandler = async (req, res, next) => {
    const path = req.originalUrl.split("?")[0];
    if (edgeBlocksWrite(config, req.method, path)) {
      const code =
        config.mode === "cloud"
          ? "CLOUD_WRITES_FENCED"
          : config.primary
            ? "EDGE_SYNC_UNSUPPORTED_OPERATION"
            : "EDGE_READ_ONLY";
      return res.status(423).json({ code, message: code });
    }

    // Phase 8 supports only the protected central USD journal route.
    // Do not let the legacy compatibility fallback or arbitrary voucher
    // payloads create local records that Phase 8 cannot safely replay.
    if (
      config.mode === "lan" &&
      config.primary &&
      req.method.toUpperCase() === "POST" &&
      path === "/api/vouchers/with-entries" &&
      !supportsPhase8LanVoucherCapture(req.body)
    ) {
      return res.status(423).json({ code: "EDGE_PHASE8_CAPTURE_UNSUPPORTED" });
    }

    // Phase 9: the pressing route is approved ONLY where the reviewed,
    // DBA-installed capture + receipt schema exists. Refuse up front rather
    // than letting a scan fail inside its transaction.
    if (
      config.mode === "lan" &&
      config.primary &&
      `${req.method.toUpperCase()} ${path}` === PHASE9_PRESSING_CONFIRM_ROUTE
    ) {
      try {
        if (!(await hasPressingCapture())) {
          return res.status(503).json({ code: "EDGE_PHASE9_PRESSING_CAPTURE_NOT_INSTALLED" });
        }
      } catch {
        return res.status(503).json({ code: "EDGE_PHASE9_PRESSING_CAPTURE_NOT_INSTALLED" });
      }
    }

    // Same rule for every other approved Phase 9 route and its own outbox.
    const routeKey = config.mode === "lan" && config.primary ? phase9ApprovedCaptureRoute(req.method, path) : null;
    const capture = routeKey ? routeCaptures[routeKey] : undefined;
    if (capture) {
      try {
        if (!(await capture.installed())) return res.status(503).json({ code: capture.code });
      } catch {
        return res.status(503).json({ code: capture.code });
      }
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
  return [limiter, guard];
}
