/**
 * Server entry point: composes middleware, routes, static serving, and the
 * startup sequence. Individual concerns live in focused modules:
 *   - server/startup/sessionMiddleware.ts   session config + PG store
 *   - server/startup/startupDataOperations / approved repairs  boot-time DML
 *   (The schema is owned by migrations/; startupPreload verifies it read-only.)
 *   - server/startup/postStartupJobs.ts     post-listen background jobs
 *   - server/startup/staticServing.ts       production SPA serving
 *   - server/startup/listenWithRetry.ts     listen + graceful shutdown
 *   - server/middleware/…                   capacitorCors, httpConventions,
 *                                           errorHandler
 *   - server/security/csrfProtection.ts     CSRF token + enforcement
 */
import express from "express";
import { createHttpApp } from "./httpApp";
import { registerFactoryEdgeBoundary } from "./edge/edgeBoundary";
import {
  applyPcLocalModeEnvironment,
  makePcLocalReadOnlyGuard,
  pcLocalReadOnly,
} from "./offline/pcLocal/localReadOnlyGuard";
import { readFactoryEdgeConfiguration, shouldStartEdgeBackgroundJobs } from "./edge/edgeRuntimePolicy.mjs";
import compression from "compression";
import { securityHeadersMiddleware } from "./security/securityHeaders";
import { registerRoutes } from "./routes";
import { markStartupMigrationsComplete } from "./startupMigrationReport";
import { registerDbHealthRoute } from "./health/dbHealthRoute";
import { blockErpTesterSettings, blockViewOnlyWrites, blockUnverifiedCreateOnlyWrites } from "./auth";
import { permissionResponseObserver } from "./middleware/permissionResponseObserver";
import { registerWebSocketHttpFallback, setupWS } from "./wsServer";
import { startScheduler } from "./services/scheduler";
import { pool } from "./db";
import { readGlobalForceRefreshToken } from "./services/globalForceRefresh";
import { requestLogger } from "./middleware/requestLogger";
import { bandwidthDebugMiddleware } from "./middleware/bandwidthDebug";
import { apiRateLimit } from "./middleware/apiRateLimit";
import { logger } from "./lib/logger";
import { getErrorMessage } from "./lib/httpHandlers";
import { originGuard } from "./security/originGuard";
import { registerCspReportRoute } from "./security/contentSecurityPolicy";
import { registerCsrfProtection } from "./security/csrfProtection";
import { registerErrorHandler } from "./middleware/errorHandler";
import { capacitorCors } from "./middleware/capacitorCors";
import { buildVersionHeader, apiNoCache, slowRequestLogger } from "./middleware/httpConventions";
import { buildSessionMiddleware } from "./startup/sessionMiddleware";
import { recordFactoryRowHistoryBaselines } from "./services/audit/factoryRowHistory";
import { ensureRequiredSystemAccountsForAllCompanies } from "./services/accounting/systemAccounts";
import { runPostStartupJobs } from "./startup/postStartupJobs";
import { serveProductionClient } from "./startup/staticServing";
import { listenWithRetry, registerGracefulShutdown } from "./startup/listenWithRetry";
import { registerProcessErrorHandlers } from "./startup/registerProcessErrorHandlers";
import { inspectHistoricalProductionBonusExpenseAccounts } from "./services/factory/productionBonusExpenseReclassification";
import { applyApprovedZakariaOpeningCredit } from "./startup/applyApprovedZakariaOpeningCredit";
import { applyApprovedEmployeeOpeningCredits } from "./startup/applyApprovedEmployeeOpeningCredits";
import { startStockTransferOrderWaApprovalWorker } from "./services/stockTransferOrderWhatsAppApprovalWorker";
import { startStockTransferOrderWaDeliveryWorker } from "./services/stockTransferOrderWaDeliveryWorker";
import { repairCompletedOrderBaleStatuses } from "./startup/repairCompletedOrderBaleStatuses";
import { warmupDb } from "./startup/warmupDb";
import { runApprovedLegacyBaleUnitCostRepair } from "./startup/runApprovedLegacyBaleUnitCostRepair";
import { runApprovedLegacySoldBaleUnitCostRepair } from "./startup/runApprovedLegacySoldBaleUnitCostRepair";
import { runApprovedCustomerLoadingDateRepair } from "./startup/runApprovedCustomerLoadingDateRepair";
import { runApprovedReturnedLoadingDateRepair } from "./startup/runApprovedReturnedLoadingDateRepair";
import { runApprovedFactoryPayableReclassification } from "./startup/runApprovedFactoryPayableReclassification";
import { runApprovedFactoryPayableUndo } from "./startup/runApprovedFactoryPayableUndo";
import { runApprovedAboSobhiGoods82 } from "./startup/runApprovedAboSobhiGoods82";
import { runApprovedAboJaberPayableFix } from "./startup/runApprovedAboJaberPayableFix";
import { runApprovedUkBasma38 } from "./startup/runApprovedUkBasma38";
import { runApprovedHmdEurogulfFreightRepair } from "./startup/runApprovedHmdEurogulfFreightRepair";
import { runApprovedFactoryDestinationNormalization } from "./startup/runApprovedFactoryDestinationNormalization";
import { runApprovedMali53DestinationNormalization } from "./startup/runApprovedMali53DestinationNormalization";
import { runApprovedFactoryWorkerAdvanceLedgerRepair } from "./startup/runApprovedFactoryWorkerAdvanceLedgerRepair";
import { runApprovedNoCashAdvanceSourceRepair } from "./startup/runApprovedNoCashAdvanceSourceRepair";
import { runApprovedFactoryWorkerAdvanceNonCashGLRepair } from "./startup/runApprovedFactoryWorkerAdvanceNonCashGLRepair";
import { inspectOctoberPayrollJournalIntegrity20261103 } from "./startup/inspectOctoberPayrollJournalIntegrity20261103";
import { applyApprovedOctoberPayrollOverlapReclass20261103 } from "./startup/applyApprovedOctoberPayrollOverlapReclass20261103";
import { bootstrapRecurringJournalFromEnvironment } from "./services/accounting/recurringJournalBootstrap";

registerProcessErrorHandlers();
// A PC's local read-only copy (desktop app only) runs no background jobs.
applyPcLocalModeEnvironment();

// and causes the browser to think the app was updated, triggering false reload prompts.
const BUILD_VERSION = process.env.BUILD_VERSION || process.env.RENDER_GIT_COMMIT?.substring(0, 8) || "dev";

// The frontend polls /api/boot and reloads when this changes, which recovers
// stale Vite chunks in Replit's dev environment (where HMR WebSocket can't connect).
const SERVER_BOOT_ID = Math.random().toString(36).slice(2);

const app = createHttpApp();

// Compress text-based HTTP responses (gzip/deflate) — reduces bandwidth by 60-80%.
// Binary/already-compressed types (xlsx, zip, pdf, images) are excluded because:
//   1. They are already compressed internally (xlsx = ZIP) so gzip yields minimal savings.
//   2. Routes set Content-Length to the uncompressed buffer size; if compression then
//      shrinks the body, the browser sees a length mismatch and discards the download (0 B).
const SKIP_COMPRESSION_RE = /spreadsheet|zip|pdf|octet-stream|image\//i;
app.use(
  compression({
    filter: (req, res) => {
      const type = String(res.getHeader("Content-Type") ?? "");
      if (SKIP_COMPRESSION_RE.test(type)) return false;
      return compression.filter(req, res);
    },
  })
);

// Security headers (Content-Security-Policy, X-Frame-Options, X-Content-Type-Options,
// HSTS, Referrer-Policy, etc.), mounted ahead of every route. The CSP is the one
// enforced policy built in server/security/securityHeaders.ts; violations are
// collected at /api/csp-report.
app.use(securityHeadersMiddleware());

// General API body limit is 2 MB. Upload routes specify their own higher limit via multer.
app.use(
  express.json({
    limit: "2mb",
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);
app.use(express.urlencoded({ extended: false, limit: "2mb" }));
// /uploads is NOT served publicly — file access goes through authenticated endpoints.

// Trust proxy for HTTPS termination
// This is required for both Replit (development) and Render (production)
// as both run behind reverse proxies
app.set("trust proxy", 1);

// ── Capacitor / Mobile CORS ─────────────────────────────────────────────────
app.use(capacitorCors);

// Disable ETag generation globally so Express never sends ETags for API responses.
// ETags cause 304 "Not Modified" responses which prevent balance/data from refreshing.
app.set("etag", false);

// Session middleware (see server/startup/sessionMiddleware.ts)
const sessionMiddleware = buildSessionMiddleware();
app.use(sessionMiddleware);

// Read-only LAN edge safety boundary + same-origin server identity endpoint.
// Cloud stays unchanged; edge requests never silently proxy to cloud.
registerFactoryEdgeBoundary(app);

// A PC's local copy (OFFLINE_PC_LOCAL_MODE=read-only, desktop app only) refuses writes.
app.use(makePcLocalReadOnlyGuard());

// Permission monitoring: classify refused API responses (403s and
// cross-company refusals) into permission signals after they are sent. Reads
// only the response status and error code; never bodies or headers.
app.use(permissionResponseObserver);

// Globally block all mutation requests (POST/PUT/PATCH/DELETE) for View Only role.
// Must run after session middleware so req.session.currentRole is populated.
app.use(blockViewOnlyWrites);
app.use(blockUnverifiedCreateOnlyWrites);
app.use(blockErpTesterSettings);

// Add build version header to all responses for cache tracking
app.use(buildVersionHeader(BUILD_VERSION));

// Structured HTTP request logger — fires on res.finish, never logs secrets
app.use(requestLogger);

// Bandwidth debug logging — only active when BANDWIDTH_DEBUG=true.
// Logs any response ≥ 500 KB: method, path, status, size, duration.
// Never logs body content, cookies, auth headers, or sensitive data.
app.use(bandwidthDebugMiddleware);

// Disable HTTP-level caching for all API routes (see middleware/httpConventions.ts)
app.use(apiNoCache);

// Slow API request logging — never logs response bodies (see middleware/httpConventions.ts)
app.use(slowRequestLogger);

// Global API rate limit — per-user buckets for signed-in callers, per-IP for
// anonymous ones. Placed after the request loggers (so 429s are still logged)
// and before the origin/CSRF guards (so floods are rejected first).
app.use(apiRateLimit);

// ── Phase D: Origin / Referer guard (CSRF defense layer 1) ─────────────────
// Implementation lives in server/security/originGuard.ts.
app.use(originGuard);

// ── Phase E: CSRF synchroniser-token middleware (ENFORCING by default) ─────
// Generates a per-session CSRF token, exposes it via GET /api/csrf-token, and
// inspects state-changing requests for a matching X-CSRF-Token header.
// Implementation lives in server/security/csrfProtection.ts.
registerCsrfProtection(app);

// CSP violation reports: browser telemetry, best-effort, throttled inside the
// handler. Registered here (after body parsing) so reports are accepted even
// though browsers cannot attach CSRF tokens to them.
registerCspReportRoute(app);

// Flag used by /api/health/db to signal readiness to Render's health check.
// The schema was already verified read-only before this module loaded
// (server/startupPreload.mjs); this flips once the boot-time data operations
// below have finished. Render holds traffic on the old instance until then.
let startupDataReady = false;

(async () => {
  registerDbHealthRoute(app, () => startupDataReady);

  // Build info endpoint for frontend version checking (must be before registerRoutes)
  app.get("/api/build-info", async (req, res) => {
    // The login page and unauthenticated tabs may check build metadata, but
    // must never receive or compare a logged-in user's refresh signal.
    if (!req.session?.userId) {
      res.json({ version: BUILD_VERSION });
      return;
    }
    try {
      // The server selects the signal using the authenticated session's
      // effective role. Never trust a client-provided role for this decision.
      const target = ["Admin", "Owner", "Developer"].includes(req.session.currentRole ?? "") ? "privileged" : "regular";
      const forceRefreshToken = await readGlobalForceRefreshToken(target);
      res.json({ version: BUILD_VERSION, forceRefreshToken, refreshAudience: target });
    } catch (error) {
      logger.warn("[GlobalForceRefresh] Build info token unavailable", { error });
      // Keep normal build update detection working during a transient DB issue.
      // Omitting the token makes the client ignore this failed check.
      res.json({ version: BUILD_VERSION });
    }
  });

  // Boot ID endpoint — returns a random ID generated once per server process start.
  // The frontend polls this in dev mode and reloads when it changes, recovering
  // stale Vite chunks after a server restart (Replit's HMR WS can't connect).
  app.get("/api/boot", (_req, res) => {
    res.json({ bootId: SERVER_BOOT_ID });
  });

  const server = await registerRoutes(app);
  // Keep connections alive longer than Render's 60-second proxy idle timeout.
  // Without this, Express closes sockets at 5 s (Node default), causing the
  // proxy to send a request on a dead connection → socket hang-up retries.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  setupWS(server, sessionMiddleware);
  // Valid websocket upgrades are handled by the upgrade path. Plain HTTP GET
  // requests to /ws should fail explicitly instead of falling through to the SPA.
  registerWebSocketHttpFallback(app);
  if (
    process.env.ENABLE_SCHEDULERS !== "false" &&
    !pcLocalReadOnly() &&
    shouldStartEdgeBackgroundJobs(readFactoryEdgeConfiguration())
  ) {
    startScheduler();
    logger.info("[Schedulers] Started (ENABLE_SCHEDULERS != false)");
  } else {
    logger.info("[Schedulers] Disabled via ENABLE_SCHEDULERS=false");
  }

  registerErrorHandler(app);

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (app.get("env") === "development") {
    // Vite pulls a large development-only dependency graph. Keep it out of
    // production startup/module residency entirely and load it only when the
    // development server actually needs it.
    const { setupVite } = await import("./vite");
    await setupVite(app, server);
  } else {
    serveProductionClient(app);
  }

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = parseInt(process.env.PORT || "5000", 10);

  // Keep Puppeteer/Chrome out of production baseline RSS. Development keeps
  // the old convenience pre-warm so a missing local Chromium can still be
  // installed automatically; production can opt back in explicitly if needed.
  if (process.env.NODE_ENV !== "production" || process.env.PUPPETEER_PREWARM === "true") {
    void import("./lib/parcelsAppScraper")
      .then(({ ensureChromiumAvailable }) => ensureChromiumAvailable())
      .catch((error: unknown) => {
        logger.warn("[Puppeteer] Optional pre-warm failed", { error: getErrorMessage(error) });
      });
  }

  registerGracefulShutdown();

  // ── Startup sequence: warmup → boot data operations → listen ─────────────
  // No schema work happens here. migrations/ owns the schema; the preload gate
  // already refused to start unless the database is at exactly this release's
  // migration level. The steps below only read and write business data, and
  // run to completion BEFORE the port opens so a failure keeps the previous
  // deployment serving.
  warmupDb()
    .then(async () => {
      // A PC's local copy must stay byte-for-byte the cloud's: no boot repair,
      // baseline or provisioning writer runs there (the cloud already ran them
      // and their results arrive through the change feed).
      if (pcLocalReadOnly()) {
        logger.info("[startup] PC local copy: boot data operations skipped");
        startupDataReady = true;
        markStartupMigrationsComplete();
        return;
      }
      // Data operations formerly embedded in the (removed) runtime schema
      // repairs, kept in their original order. None changes the schema.
      // The payroll daybook pass rewrites the factory daybook mirror only (no
      // voucher, line or account).
      const { runPhase3PayrollDaybookRepair } = await import("./services/accounting/phase3PayrollDaybookRepair");
      await runPhase3PayrollDaybookRepair();
      // Immutable inventory valuation cutover snapshots, captured after the
      // daybook pass while startup still blocks traffic to the new instance.
      const { ensurePhase3InventoryValuationBaselines } =
        await import("./services/accounting/phase3InventoryValuation");
      const baselinesCreated = await ensurePhase3InventoryValuationBaselines(pool);
      logger.info("[startup] ✓ Phase 3 inventory valuation cutovers ensured", { baselinesCreated });
      // Disabled by default: an explicitly reviewed one-shot historical-sales repair.
      const { maybeRunHistoricalSalesCostRepairFromEnv } =
        await import("./services/inventory/historicalSalesCostRepairStartup");
      await maybeRunHistoricalSalesCostRepairFromEnv();
      // Factory row history baseline snapshots (historical Net Position). Data
      // only; the history triggers are part of the schema. Never fatal.
      await recordFactoryRowHistoryBaselines(pool);
      await ensureRequiredSystemAccountsForAllCompanies().catch((error: unknown) => {
        logger.error("[startup] ✗ System account provisioning failed", { error: getErrorMessage(error) });
      });
      if (shouldStartEdgeBackgroundJobs(readFactoryEdgeConfiguration())) {
        await bootstrapRecurringJournalFromEnvironment();
      }
      // Owner-confirmed: HADI L'SHI Zakaria El Ali #103's $9,930.12
      // opening is Cr, not Dr. Scoped, audited and idempotent; never alters
      // salary/bonus postings or other employees.
      await applyApprovedZakariaOpeningCredit();
      // The historical payroll import used positive openings for employee
      // credits; several records still carry the default Dr side. Correct the
      // verified records once with before/after audit; never alter vouchers.
      try {
        await applyApprovedEmployeeOpeningCredits();
      } catch (openingRepairError: unknown) {
        logger.error("[startup] Historical employee openings were not fully corrected", {
          error: getErrorMessage(openingRepairError),
        });
        // Do not take the whole ERP offline for a historical correction.
        // Failed database transactions roll back; errors remain visible here.
      }
      // The one-time historical bonus reclassification has already been applied.
      // Never rerun a historical voucher mutation on every server startup.
      // A later legitimate voucher edit can change a paid amount while its old
      // claim still reflects the original value. Report that discrepancy for
      // audited reconciliation; do not change accounting or take ERP offline.
      if (process.env.RENDER_SERVICE_ID === "srv-d6kibgtactks739u7vl0") {
        try {
          const database = await pool.query<{ name: string }>("SELECT current_database() AS name");
          if (database.rows[0]?.name !== "erp_db_qscj_64lv_e7rz_8744_2lm3") {
            logger.warn("[startup] Historical bonus inspection skipped on unexpected database");
          } else {
            const inspection = await inspectHistoricalProductionBonusExpenseAccounts();
            if (inspection.inspected !== 9 || inspection.discrepancies.length > 0) {
              logger.warn("[startup] Historical production bonus claims require manual reconciliation", inspection);
            } else {
              logger.info("[startup] Historical production bonus expense accounts reconciled", inspection);
            }
          }
        } catch (inspectionError: unknown) {
          logger.warn(
            "[startup] Historical production bonus inspection unavailable; serving without changing posted vouchers",
            {
              error: getErrorMessage(inspectionError),
            }
          );
        }
      }
      // Before accepting requests, reconcile old completed-order bales still
      // marked IN_STOCK (audited; the guard trigger is part of the schema).
      await repairCompletedOrderBaleStatuses(pool);
      // Explicitly owner-approved, one-time monetary correction. Disabled by
      // default and guarded against repeat execution or accounting cutover.
      // Startup repair writers are forbidden on independently authoritative LAN
      // databases and on a cloud explicitly fenced for factory handoff.
      if (shouldStartEdgeBackgroundJobs(readFactoryEdgeConfiguration())) {
        await runApprovedLegacyBaleUnitCostRepair(pool);
        // Owner-approved (2026-10-17) follow-up for the remaining historical/sold bales.
        await runApprovedLegacySoldBaleUnitCostRepair(pool);
        // One-time owner-authorized, company-12 historical loading-date reconciliation.
        // Atomic before-image audit and exact first-submission evidence are required.
        await runApprovedCustomerLoadingDateRepair(pool);
        // Restore the original date for a historically confirmed order returned to LOADING.
        await runApprovedReturnedLoadingDateRepair(pool);
        // Owner-approved, idempotent reclassification of 18 original factory import payables.
        // No-op unless explicitly enabled on the verified production Render service.
        await runApprovedFactoryPayableReclassification();
        await runApprovedFactoryPayableUndo();
        // One-time exact goods payable catch-up for ABO SOBHI container TCLU8160430.
        await runApprovedAboSobhiGoods82();
        // One-time, source-reviewed, owner-approved company-12 JABER liability reassignment.
        await runApprovedAboJaberPayableFix();
        // Exact-source, owner-requested UK BASMA supplier statement reconciliation.
        await runApprovedUkBasma38();
        // Owner-approved EUROGULF freight reclass; no-op without exact Render opt-in.
        await runApprovedHmdEurogulfFreightRepair();
        // Owner-approved Factory customer order destination spelling consolidation.
        // Opt-in only; exact company, database, before-images and audit are verified.
        await runApprovedFactoryDestinationNormalization(pool);
        // One-time, audited destination label consolidation on the finalized MALI 53 order.
        await runApprovedMali53DestinationNormalization(pool);
        // Opt-in, production company 12 only; no UI or reporting substitution.
        try {
          await runApprovedFactoryWorkerAdvanceLedgerRepair();
        } catch (advanceRepairError: unknown) {
          logger.error("[startup] Factory worker advance accrual correction blocked", {
            error: getErrorMessage(advanceRepairError),
          });
        }
        // Company 12 source repair only; never writes Cash or ledger journals.
        try {
          await runApprovedNoCashAdvanceSourceRepair();
        } catch (noCashAdvanceError: unknown) {
          logger.error("[startup] No-cash worker advance source repair blocked", {
            error: getErrorMessage(noCashAdvanceError),
          });
        }
        // Original-date accounting correction for the remaining $51.61.
        // Exact Render opt-in, guarded against any Cash or source mutation.
        try {
          await runApprovedFactoryWorkerAdvanceNonCashGLRepair();
        } catch (advanceGLRepairError: unknown) {
          logger.error("[startup] Factory advance historical noncash GL repair blocked", {
            error: getErrorMessage(advanceGLRepairError),
          });
        }
        // Explicitly opted-in, tenant-scoped READ-ONLY inspection. It only
        // logs posted October payroll accrual/payment evidence and closed books;
        // never changes cash, advances, payroll rows or journal entries.
        try {
          await inspectOctoberPayrollJournalIntegrity20261103();
        } catch (payrollInspectionError: unknown) {
          logger.error("[startup] October payroll journal inspection unavailable", {
            error: getErrorMessage(payrollInspectionError),
          });
        }
        // Audited, opt-in October paid-overlap reclassification. Never touches
        // cash, Daybook, historical payrolls or existing worker advances.
        // All source/payments/attendance snapshots must match before posting.
        try {
          await applyApprovedOctoberPayrollOverlapReclass20261103();
        } catch (overlapRepairError: unknown) {
          logger.error("[startup] October payroll overlap reclassification blocked", {
            error: getErrorMessage(overlapRepairError),
          });
        }
      }
      startupDataReady = true;
      markStartupMigrationsComplete();
    })
    .then(() => {
      listenWithRetry(server, port, () => {
        if (!pcLocalReadOnly() && shouldStartEdgeBackgroundJobs(readFactoryEdgeConfiguration())) {
          runPostStartupJobs();
          // Run only on the authoritative scheduler, honoring production activation kill switch.
          if (process.env.ENABLE_SCHEDULERS !== "false") {
            startStockTransferOrderWaApprovalWorker();
            startStockTransferOrderWaDeliveryWorker();
          }
        } else {
          logger.info("[FactoryEdge] Background startup jobs disabled by LAN mode or cloud writer fence");
        }
      });
    })
    .catch((err: unknown) => {
      logger.error("Fatal startup error:", { error: getErrorMessage(err) ?? err });
      process.exit(1);
    });
})();
