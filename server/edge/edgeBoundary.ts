import type { Express, RequestHandler } from "express";
import { requireAuth } from "../auth";
import {
  assertActiveCompanyAccess,
  CompanyAccessError,
  sendCompanyAccessError,
} from "../security/companyAccessBoundary";
import { pool } from "../db";
import {
  edgeBlocksWrite,
  edgeStatusPayload,
  PHASE9_PRESSING_CONFIRM_ROUTE,
  readFactoryEdgeConfiguration,
} from "./edgeRuntimePolicy.mjs";
import { hasFactoryEdgeData } from "./edgeDatabaseProof.mjs";
import { hasVerifiedPhase7WriterAuthority } from "./phase7WriterGate.mjs";
import { supportsPhase8LanVoucherCapture } from "./phase8CapturePolicy.mjs";
import { Phase9StatusRefusal, readPhase9OperationStatus } from "./phase9OperationStatus.mjs";
import { registerCloudEdgeSyncReceiver } from "./edgeSyncReceiver";

type EdgeConfiguration = ReturnType<typeof readFactoryEdgeConfiguration>;

export function makeFactoryEdgeWriteGuard(
  config: EdgeConfiguration,
  hasApprovedData: () => Promise<boolean>,
  hasWriterAuthority: () => Promise<boolean> = async () => false,
  hasPressingCapture: () => Promise<boolean> = async () => false
): RequestHandler {
  return async (req, res, next) => {
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

  app.get(
    "/api/edge/status",
    (req, res, next) => {
      // Keep the LAN identity probe public. Receipt queries must pass current
      // credential-version, session-expiry and company-session enforcement.
      if (req.query.operationId === undefined) return next();
      return void requireAuth(req, res, next);
    },
    async (req, res) => {
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
          // Membership can be revoked after the session selected its company.
          // Never trust the session's company ID as membership proof by itself.
          await assertActiveCompanyAccess(req);
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
          if (error instanceof CompanyAccessError) return sendCompanyAccessError(res, error);
          return res.status(503).json({ code: "EDGE_OPERATION_STATUS_UNAVAILABLE" });
        }
      }
      if (config.mode !== "lan") return res.json(edgeStatusPayload(config));
      return res.json(edgeStatusPayload(config, await provisioned()));
    }
  );
  // Staging-only, HMAC-authenticated cloud receiver. No posted business effects.
  registerCloudEdgeSyncReceiver(app);
  let pressingCheck: { value: boolean; at: number } | null = null;
  async function pressingCaptureInstalled(): Promise<boolean> {
    const now = Date.now();
    if (pressingCheck && now - pressingCheck.at < 3_000) return pressingCheck.value;
    const { rows } = await pool.query(
      // Tables alone (e.g. from drizzle-kit push) are not a reviewed install:
      // the immutable-evidence triggers must be present and enabled too.
      `SELECT count(*) = 3 AS installed
         FROM pg_trigger t
        WHERE t.tgenabled = 'O' AND NOT t.tgisinternal
          AND (t.tgrelid, t.tgname) IN (
            ('public.factory_edge_pressing_outbox'::regclass, 'factory_edge_pressing_outbox_no_mutation'),
            ('public.factory_edge_event_stage_receipts'::regclass, 'factory_edge_event_stage_receipts_no_mutation'),
            ('public.factory_edge_event_applied_receipts'::regclass, 'factory_edge_event_applied_receipts_no_mutation')
          )`
    );
    const value = rows[0]?.installed === true;
    pressingCheck = { value, at: now };
    return value;
  }
  app.use(
    "/api",
    makeFactoryEdgeWriteGuard(
      config,
      provisioned,
      () => hasVerifiedPhase7WriterAuthority(pool, config),
      pressingCaptureInstalled
    )
  );
}
