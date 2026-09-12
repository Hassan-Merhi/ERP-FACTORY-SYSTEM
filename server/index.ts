/**
 * Server entry point: composes middleware, routes, static serving, and the
 * startup sequence. Individual concerns live in focused modules:
 *   - server/startup/sessionMiddleware.ts   session config + PG store
 *   - server/startup/ensureRuntimeSchema.ts always-running schema repairs
 *   - server/startup/postStartupJobs.ts     post-listen background jobs
 *   - server/startup/staticServing.ts       production SPA serving
 *   - server/startup/listenWithRetry.ts     listen + graceful shutdown
 *   - server/middleware/…                   capacitorCors, httpConventions,
 *                                           errorHandler
 *   - server/security/csrfProtection.ts     CSRF token + enforcement
 */
import express from "express";
import compression from "compression";
import helmet from "helmet";
import { registerRoutes } from "./routes";
import { markStartupMigrationsComplete } from "./startupMigrationReport";
import { registerDbHealthRoute } from "./health/dbHealthRoute";
import { blockViewOnlyWrites } from "./auth";
import { setupWS } from "./wsServer";
import { startScheduler } from "./services/scheduler";
import { setupVite } from "./vite";
import { pool } from "./db";
import { requestLogger } from "./middleware/requestLogger";
import { bandwidthDebugMiddleware } from "./middleware/bandwidthDebug";
import { apiRateLimit } from "./middleware/apiRateLimit";
import { logger } from "./lib/logger";
import { getErrorMessage } from "./lib/httpHandlers";
import { originGuard } from "./security/originGuard";
import { helmetContentSecurityPolicyOption, registerCspReportRoute } from "./security/contentSecurityPolicy";
import { registerCsrfProtection } from "./security/csrfProtection";
import { registerErrorHandler } from "./middleware/errorHandler";
import { capacitorCors } from "./middleware/capacitorCors";
import { buildVersionHeader, apiNoCache, slowRequestLogger } from "./middleware/httpConventions";
import { buildSessionMiddleware } from "./startup/sessionMiddleware";
import { ensureRuntimeSchema } from "./startup/ensureRuntimeSchema";
import { runPostStartupJobs } from "./startup/postStartupJobs";
import { serveProductionClient } from "./startup/staticServing";
import { listenWithRetry, registerGracefulShutdown } from "./startup/listenWithRetry";
import { registerProcessErrorHandlers } from "./startup/registerProcessErrorHandlers";
import { runStartupMigrations, warmupDb } from "./startup/runServerStartupMigrations";
import { ensureFactoryStaffTrackingSchema } from "./startup/factoryStaffTrackingSchema";
import {
  startupMigrations,
  ensureCanonicalStockMovementJournal,
  ensureFinancialOperationRequests,
} from "./startup-schema";

registerProcessErrorHandlers();

// and causes the browser to think the app was updated, triggering false reload prompts.
const BUILD_VERSION = process.env.BUILD_VERSION || process.env.RENDER_GIT_COMMIT?.substring(0, 8) || "dev";

// The frontend polls /api/boot and reloads when this changes, which recovers
// stale Vite chunks in Replit's dev environment (where HMR WebSocket can't connect).
const SERVER_BOOT_ID = Math.random().toString(36).slice(2);

const app = express();

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

// Security headers (X-Frame-Options, X-Content-Type-Options, HSTS, Referrer-Policy, etc.)
// CSP ships report-only in production and off elsewhere; CSP_ENFORCE=true
// flips the same policy to enforcing. Policy and violation collection live in
// server/security/contentSecurityPolicy.ts.
// crossOriginEmbedderPolicy is disabled to allow loading external images (logos, etc.).
app.use(
  helmet({
    contentSecurityPolicy: helmetContentSecurityPolicyOption(),
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" },
  })
);

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

// Globally block all mutation requests (POST/PUT/PATCH/DELETE) for View Only role.
// Must run after session middleware so req.session.currentRole is populated.
app.use(blockViewOnlyWrites);

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
// Port opens immediately; migrations run in background. Render holds traffic
// on the old instance (via health check 503) until this flips to true.
let migrationsDone = false;

(async () => {
  const migrations = startupMigrations;

  registerDbHealthRoute(app, () => migrationsDone);

  // Build info endpoint for frontend version checking (must be before registerRoutes)
  app.get("/api/build-info", (_req, res) => {
    res.json({ version: BUILD_VERSION });
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
  if (process.env.ENABLE_SCHEDULERS !== "false") {
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
    await setupVite(app, server);
  } else {
    serveProductionClient(app);
  }

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = parseInt(process.env.PORT || "5000", 10);

  const runMigrations = () =>
    runStartupMigrations(migrations, () => {
      migrationsDone = true;
    });

  // Ensure Puppeteer's Chrome binary is present before the server starts
  // accepting tracking requests.  Runs in background — does not block startup.
  import("./lib/parcelsAppScraper")
    .then(({ ensureChromiumAvailable }) => {
      ensureChromiumAvailable().catch(() => {});
    })
    .catch(() => {});

  registerGracefulShutdown();

  // ── Startup sequence: warmup → migrations → listen ────────────────────────
  // Migrations run to completion BEFORE the port opens. This guarantees:
  //   1. The schema is always up-to-date before any request reaches new code.
  //   2. A failed migration aborts startup, keeping the old deployment alive
  //      instead of serving requests against a stale or broken schema.
  // Set RUN_STARTUP_MIGRATIONS=false to skip migrations entirely (emergency
  // kill-switch for severe lock contention).
  const migrationsEnabled = process.env.RUN_STARTUP_MIGRATIONS !== "false";
  if (!migrationsEnabled) {
    logger.info("⚠ Startup migrations DISABLED via RUN_STARTUP_MIGRATIONS=false");
    migrationsDone = true;
    markStartupMigrationsComplete({ skipped: true });
  }

  warmupDb()
    .then(async () => {
      // Always-running schema repairs (exchange-rate index, multi-currency
      // columns, fiscal/factory tables) — see startup/ensureRuntimeSchema.ts.
      await ensureRuntimeSchema(pool);
      await ensureCanonicalStockMovementJournal(pool);
      await ensureFinancialOperationRequests(pool);
      try {
        // Factory Production Targets and Attendance Register must be available
        // even when production skips the bulk startup migration pass.
        await ensureFactoryStaffTrackingSchema(pool);
        logger.info("[startup] ✓ Factory staff tracking schema ensured");
      } catch (staffTrackingSchemaErr: unknown) {
        logger.error("[startup] ✗ Could not ensure Factory staff tracking schema:", {
          error: getErrorMessage(staffTrackingSchemaErr),
        });
      }
      if (migrationsEnabled) {
        try {
          await runMigrations();
        } catch (err: unknown) {
          logger.error("Migration error (non-fatal — server will still start):", {
            error: getErrorMessage(err) ?? err,
          });
          migrationsDone = true;
          markStartupMigrationsComplete();
        }
      }
    })
    .then(() => {
      listenWithRetry(server, port, () => runPostStartupJobs());
    })
    .catch((err: unknown) => {
      logger.error("Fatal startup error:", { error: getErrorMessage(err) ?? err });
      process.exit(1);
    });
})();
