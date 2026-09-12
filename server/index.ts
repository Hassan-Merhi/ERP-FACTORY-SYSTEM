import express, { type Request, Response, NextFunction } from "express";
import { getErrorMessage } from "./lib/httpHandlers";
import compression from "compression";
import helmet from "helmet";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import path from "path";
import fs from "fs";
import { randomBytes } from "crypto";
import { registerRoutes } from "./routes";
import { markStartupMigrationsComplete } from "./startupMigrationReport";
import { registerDbHealthRoute } from "./health/dbHealthRoute";
import { blockViewOnlyWrites } from "./auth";
import { setupWS } from "./wsServer";
import { startScheduler, checkAndRecoverDailyExport } from "./services/scheduler";
import { setupVite, log } from "./vite";
import type { User } from "@shared/schema";
import { pool } from "./db";
import { resolveDatabaseSsl } from "./lib/databaseSsl.mjs";
import { requestLogger } from "./middleware/requestLogger";
import { bandwidthDebugMiddleware } from "./middleware/bandwidthDebug";
import { logger } from "./lib/logger";
import {
  startupMigrations,
  ensureCanonicalStockMovementJournal,
  ensureFinancialOperationRequests,
} from "./startup-schema";
import { registerProcessErrorHandlers } from "./startup/registerProcessErrorHandlers";
import { runStartupMigrations, warmupDb } from "./startup/runServerStartupMigrations";
import { ensureFactoryStaffTrackingSchema } from "./startup/factoryStaffTrackingSchema";
import { apiRateLimit } from "./middleware/apiRateLimit";
import { ORIGIN_GUARD_EXEMPT_PATHS, originGuard } from "./security/originGuard";
import { helmetContentSecurityPolicyOption, registerCspReportRoute } from "./security/contentSecurityPolicy";

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

declare global {
  namespace Express {
    interface Request {
      user?: User & {
        role?: string;
        assignedLocationId?: number | null;
        posStation?: number | null;
        cashAccountId?: number | null;
        canSellNegativeStock?: boolean;
        daybookEditDays?: number;
        canAccessCustomers?: boolean;
      };
    }
  }
}

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

declare module "express-session" {
  interface SessionData {
    userId?: string;
    username?: string;
    currentCompanyId?: number;
    factoryCompanyId?: number;
    currentRole?: string;
    currentLocationId?: number | null;
    currentPOSStation?: number | null;
    cashAccountId?: number | null;
    canSellNegativeStock?: boolean;
    posViewOnly?: boolean;
    daybookEditDays?: number;
    canAccessCustomers?: boolean;
    canDeleteRecords?: boolean;
    /** Unix timestamp (ms) when user last confirmed their password via POST /api/auth/confirm-password */
    passwordConfirmedAt?: number;
  }
}

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
// Browser WebViews (iOS Capacitor, Android Capacitor, Ionic) send these origins
// when calling the production API. They cannot be spoofed by web-based CSRF
// attacks. We must echo the exact origin back (not "*") so that the browser
// also honours Access-Control-Allow-Credentials: true.
const CAPACITOR_ORIGINS = new Set([
  "capacitor://localhost",
  "ionic://localhost",
  "https://localhost",
  "http://localhost",
]);
app.use((req, res, next) => {
  const origin = req.headers.origin as string | undefined;
  if (origin && CAPACITOR_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Methods", "GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type,Authorization,X-CSRF-Token,X-Client-Date,X-Requested-With"
    );
    res.setHeader("Access-Control-Max-Age", "86400"); // 24h preflight cache
    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
  }
  next();
});

// Disable ETag generation globally so Express never sends ETags for API responses.
// ETags cause 304 "Not Modified" responses which prevent balance/data from refreshing.
app.set("etag", false);

// Session middleware
const PgSession = connectPgSimple(session);

if (!process.env.SESSION_SECRET) {
  logger.error("CRITICAL: SESSION_SECRET environment variable is not set!");
  logger.error("Please set a strong, random SESSION_SECRET for production security.");
  if (process.env.NODE_ENV === "production") {
    process.exit(1);
  }
}

const sessionConfig: session.SessionOptions = {
  name: "erp.session",
  secret: process.env.SESSION_SECRET || randomBytes(32).toString("hex"),
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    secure: process.env.NODE_ENV === "production" || !!process.env.REPL_ID || process.env.CAPACITOR_ENABLED === "true",
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
    path: "/",
    // SameSite=None is required for Capacitor WebView cross-origin requests.
    // Origin guard + CSRF token remain primary CSRF protection.
    // Set CAPACITOR_ENABLED=true on the server used by the Capacitor app.
    sameSite: process.env.CAPACITOR_ENABLED === "true" ? "none" : "lax",
  },
};

// Use PostgreSQL session store when a database is available
// This ensures sessions persist across server restarts
if (process.env.DATABASE_URL || process.env.PGHOST) {
  const connectionString =
    process.env.DATABASE_URL ||
    `postgresql://${process.env.PGUSER}:${process.env.PGPASSWORD}@${process.env.PGHOST}:${process.env.PGPORT}/${process.env.PGDATABASE}`;

  // Match SSL configuration with main database connection
  const isLocalReplitDB = process.env.PGHOST === "helium";
  const sslExplicitlyDisabled = process.env.PGSSLMODE === "disable";
  const requiresSSL = !isLocalReplitDB && !sslExplicitlyDisabled;

  sessionConfig.store = new PgSession({
    conObject: {
      connectionString,
      ssl: resolveDatabaseSsl(connectionString),
      // Allow a small pool so concurrent session reads don't serialize behind one connection.
      max: Number(process.env.PG_SESSION_POOL_MAX || 3),
      connectionTimeoutMillis: 8000,
      idleTimeoutMillis: 30000,
    },
    createTableIfMissing: true,
  });

  logger.info(`✓ PostgreSQL session store configured (SSL: ${requiresSSL ? "enabled" : "disabled"})`);
}

// Held so the WebSocket upgrade can resolve the same session and learn which
// company a socket belongs to; see setupWS.
const sessionMiddleware = session(sessionConfig);
app.use(sessionMiddleware);

// Globally block all mutation requests (POST/PUT/PATCH/DELETE) for View Only role.
// Must run after session middleware so req.session.currentRole is populated.
app.use(blockViewOnlyWrites);

// Add build version header to all responses for cache tracking
app.use((_req, res, next) => {
  res.setHeader("X-Build-Version", BUILD_VERSION);
  next();
});

// Structured HTTP request logger — fires on res.finish, never logs secrets
app.use(requestLogger);

// Bandwidth debug logging — only active when BANDWIDTH_DEBUG=true.
// Logs any response ≥ 500 KB: method, path, status, size, duration.
// Never logs body content, cookies, auth headers, or sensitive data.
app.use(bandwidthDebugMiddleware);

// Disable HTTP-level caching for all API routes.
// Without this, Express generates ETags and the browser returns 304 "Not Modified"
// for every subsequent request — causing TanStack Query's invalidateQueries to have
// no effect (the browser hands back its cached response instead of hitting the server).
app.use((req, res, next) => {
  if (req.path.startsWith("/api")) {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
  }
  next();
});

// Structured request logging — never logs response bodies to avoid leaking sensitive data.
app.use((req, res, next) => {
  const start = Date.now();
  const reqPath = req.path;
  res.on("finish", () => {
    const duration = Date.now() - start;
    if (reqPath.startsWith("/api") && duration > 500) {
      log(`[SLOW API] ${req.method} ${reqPath} ${res.statusCode} in ${duration}ms`);
    }
  });
  next();
});

// Global API rate limit — per-user buckets for signed-in callers, per-IP for
// anonymous ones. Placed after the request loggers (so 429s are still logged)
// and before the origin/CSRF guards (so floods are rejected first).
app.use(apiRateLimit);

// ── Phase D: Origin / Referer guard (CSRF defense layer 1) ─────────────────
// Implementation lives in server/security/originGuard.ts.
app.use(originGuard);

// ── Phase E: CSRF synchroniser-token middleware (ENFORCING by default) ─────
// Generates a per-session CSRF token, exposes it via GET /api/csrf-token, and
// inspects state-changing requests for a matching X-CSRF-Token header. The
// frontend's window.fetch interceptor (client/src/lib/queryClient.ts) auto-
// attaches the token to every state-changing /api/* request — covering both
// apiRequest() callers and the ~350 raw fetch sites in legacy pages. Set
// CSRF_ENFORCE=0 to fall back to warn-only mode if a regression surfaces.
const CSRF_ENFORCE = process.env.CSRF_ENFORCE !== "0";
app.get("/api/csrf-token", (req, res) => {
  const sess = req.session;
  if (!sess.csrfToken) {
    sess.csrfToken = randomBytes(32).toString("hex");
  }
  res.json({ csrfToken: sess.csrfToken });
});
app.use((req, res, next) => {
  const method = req.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return next();
  if (!req.path.startsWith("/api")) return next();
  if (ORIGIN_GUARD_EXEMPT_PATHS.has(req.path)) return next();
  if (req.path === "/api/csrf-token") return next();

  const sess = req.session;
  const expected: string | undefined = sess?.csrfToken;
  const got = req.headers["x-csrf-token"];

  // No token in session yet means user is not authenticated / hasn't fetched one.
  // Don't gate auth/login endpoints on CSRF — first-touch endpoints by design.
  if (!expected) return next();

  if (typeof got === "string" && got === expected) return next();

  if (CSRF_ENFORCE) {
    logger.warn(
      `[CSRF] BLOCKED ${method} ${req.path} | expected=${expected.slice(0, 8)}… got=${typeof got === "string" ? got.slice(0, 8) + "…" : "<missing>"}`
    );
    return res.status(403).json({
      message: "CSRF token missing or invalid.",
      code: "CSRF_TOKEN_MISMATCH",
    });
  } else {
    logger.warn(`[CSRF warn-only] ${method} ${req.path} | got=${typeof got === "string" ? "present" : "missing"}`);
    next();
  }
});

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

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const error = err as {
      cause?: { message?: string };
      message?: string;
      status?: number;
      statusCode?: number;
    };
    // DB unavailable errors — return 503 immediately instead of a generic 500.
    const isPoolTimeout =
      error?.cause?.message?.includes("timeout exceeded when trying to connect") ||
      error?.message?.includes("timeout exceeded when trying to connect");
    const isLockTimeout =
      error?.cause?.message?.includes("lock timeout") ||
      error?.message?.includes("lock timeout") ||
      error?.cause?.message?.includes("canceling statement due to lock timeout") ||
      error?.message?.includes("canceling statement due to lock timeout");
    if (isPoolTimeout || isLockTimeout) {
      logger.error("DB connection/lock timeout — pool exhausted or DDL lock contention", {
        module: "db",
        action: "poolTimeout",
        error: err,
      });
      return res.status(503).json({ message: "Service temporarily unavailable — please retry." });
    }

    const status = error.status || error.statusCode || 500;
    const isProduction = process.env.NODE_ENV === "production";

    if (status >= 500) {
      logger.error("Unhandled server error", { module: "server", action: "errorHandler", status, error: err });
    }

    const message =
      isProduction && status >= 500
        ? "An unexpected error occurred. Please try again."
        : error.message || "Internal Server Error";

    res.status(status).json({ message });
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (app.get("env") === "development") {
    await setupVite(app, server);
  } else {
    // Custom static file serving with proper cache headers
    const distPath = path.resolve(import.meta.dirname, "public");

    if (!fs.existsSync(distPath)) {
      throw new Error(`Could not find the build directory: ${distPath}, make sure to build the client first`);
    }

    // Serve static assets with cache control
    app.use(
      express.static(distPath, {
        setHeaders: (res, filePath) => {
          if (filePath.endsWith("index.html") || filePath.endsWith("sw.js") || filePath.endsWith("manifest.json")) {
            // Never cache index.html, sw.js, or manifest — must always be fresh
            res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
            res.setHeader("Pragma", "no-cache");
            res.setHeader("Expires", "0");
          } else {
            // Allow long-term caching for hashed assets
            res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
          }
        },
      })
    );

    // Return 404 for /assets/* that express.static didn't find.
    // This prevents the SPA index.html fallback from being served as JavaScript,
    // which would corrupt the service worker cache and cause MIME type errors in Safari.
    app.use("/assets", (_req, res) => {
      res.status(404).end();
    });

    // Fallback to index.html with no-cache headers (SPA routing)
    app.use("/{*splat}", (_req, res) => {
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");
      res.sendFile(path.resolve(distPath, "index.html"));
    });
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

  // ── Post-startup background jobs (run after port is open) ───────────────────
  const runPostStartupJobs = () => {
    // Delayed 30 s so diagnostics don't compete with user requests for pool
    // connections the moment the server goes live.
    setTimeout(async () => {
      try {
        const [posRows, posWithStation, normalUserRows, oldRoleRows, canDeleteCol] = await Promise.all([
          pool.query(`SELECT COUNT(*) AS n FROM user_company_roles WHERE role = 'POS'`),
          pool.query(`SELECT COUNT(*) AS n FROM user_company_roles WHERE role = 'POS' AND pos_station IS NOT NULL`),
          pool.query(`SELECT COUNT(*) AS n FROM user_company_roles WHERE role = 'Normal User'`),
          pool.query(
            `SELECT COUNT(*) AS n FROM user_company_roles WHERE role IN ('POS1','POS2','POS3','POS4','POS5','POS6','User')`
          ),
          pool.query(
            `SELECT COUNT(*) AS n FROM information_schema.columns
             WHERE table_name = 'user_company_roles' AND column_name = 'can_delete_records'`
          ),
        ]);
        const posCount = parseInt(posRows.rows[0]?.n ?? "0", 10);
        const posWithStn = parseInt(posWithStation.rows[0]?.n ?? "0", 10);
        const normalCount = parseInt(normalUserRows.rows[0]?.n ?? "0", 10);
        const oldRoleCount = parseInt(oldRoleRows.rows[0]?.n ?? "0", 10);
        const canDeleteOk = parseInt(canDeleteCol.rows[0]?.n ?? "0", 10) > 0;
        logger.info(
          `[MigrationDiag] POS roles: ${posCount} (${posWithStn} with pos_station set) | ` +
            `Normal User roles: ${normalCount} | ` +
            `Old roles remaining: ${oldRoleCount} | ` +
            `can_delete_records column: ${canDeleteOk ? "✓ present" : "✗ MISSING"}`
        );
        if (oldRoleCount > 0) {
          logger.warn(
            `[MigrationDiag] ⚠️  ${oldRoleCount} row(s) still have old roles (POS1–POS6 or User) — check /api/admin/deployment-diagnostics`
          );
        }
      } catch (e: unknown) {
        logger.warn("[MigrationDiag] Could not run startup diagnostic:", { error: getErrorMessage(e) });
      }
    }, 30000);

    // ── Fix bales where deletedAt is set but status is not DELETED ────────────
    void (async () => {
      try {
        const r = await pool.query(`
          UPDATE factory_bales
             SET status = 'DELETED', updated_at = NOW()
           WHERE deleted_at IS NOT NULL
             AND status != 'DELETED'
          RETURNING id, reference_number
        `);
        if (r.rowCount && r.rowCount > 0) {
          logger.info(`[BaleStatusFix] Fixed ${r.rowCount} bale(s) with deletedAt set but status != DELETED`, {
            detail: r.rows.map((x) => x.reference_number).join(", "),
          });
        }
      } catch (e: unknown) {
        logger.warn("[BaleStatusFix] Could not fix inconsistent bale statuses:", { error: getErrorMessage(e) });
      }
    })();

    // ── Clean up orphaned export runs ────────────────────────────────────────
    const cleanupOrphanedRuns = async () => {
      try {
        const r = await pool.query(`
          UPDATE daily_export_runs
             SET status         = 'failed',
                 finished_at    = NOW(),
                 skipped_reason = 'Server restarted or timed out while export was in progress'
           WHERE status         = 'running'
             AND started_at     < NOW() - INTERVAL '5 minutes'
          RETURNING id, run_type
        `);
        if (r.rowCount && r.rowCount > 0) {
          logger.info(`[ExportRun] Startup: marked ${r.rowCount} orphaned run(s) as failed`, {
            detail: r.rows.map((x) => `#${x.id} ${x.run_type}`).join(", "),
          });
        }
      } catch (e: unknown) {
        logger.warn("[ExportRun] Startup orphan-cleanup failed:", { error: getErrorMessage(e) });
      }
    };

    const cleanupHungRuns = async () => {
      try {
        const r = await pool.query(`
          UPDATE daily_export_runs
             SET status         = 'failed',
                 finished_at    = NOW(),
                 skipped_reason = 'Export timed out — exceeded 3-hour safety limit'
           WHERE status         = 'running'
             AND started_at     < NOW() - INTERVAL '3 hours'
          RETURNING id, run_type
        `);
        if (r.rowCount && r.rowCount > 0) {
          logger.info(`[ExportRun] Periodic: timed out ${r.rowCount} hung run(s)`, {
            detail: r.rows.map((x) => `#${x.id} ${x.run_type}`).join(", "),
          });
        }
      } catch (e: unknown) {
        logger.warn("[ExportRun] Periodic hung-run cleanup failed:", { error: getErrorMessage(e) });
      }
    };

    setTimeout(cleanupOrphanedRuns, 3000);
    setInterval(cleanupHungRuns, 30 * 60 * 1000);

    setTimeout(async () => {
      try {
        await checkAndRecoverDailyExport();
      } catch (e: unknown) {
        logger.warn("[DailyExport] Startup recovery call failed:", { error: getErrorMessage(e) });
      }
    }, 90 * 1000);
  };

  // ── Open the port ─────────────────────────────────────────────────────────
  // Called only after migrations have completed (see startServer below).
  const doListen = () => {
    server.listen({ port, host: "0.0.0.0", reusePort: true }, () => {
      log(`serving on port ${port}`);
      runPostStartupJobs();
    });
  };

  server.on("error", (err: Error & { code?: string }) => {
    if (err.code === "EADDRINUSE") {
      logger.warn(`Port ${port} in use — killing zombie process and retrying...`);
      try {
        const { execSync } = require("child_process");
        execSync(`fuser -k ${port}/tcp`, { stdio: "ignore" });
      } catch {
        // Failure here is non-fatal and the surrounding flow continues deliberately.
      }
      setTimeout(() => {
        server.removeAllListeners("error");
        server.on("error", (e) => {
          logger.error("Server error:", { error: e });
        });
        doListen();
      }, 600);
    } else {
      logger.error("Server error:", { error: err });
    }
  });

  // Graceful shutdown: close DB pool so zero-downtime deploys don't leave
  // zombie connections that exhaust max_connections on the next instance.
  const shutdown = async (signal: string) => {
    logger.info(`[Shutdown] ${signal} received — closing DB pool...`);
    try {
      await pool.end();
      logger.info("[Shutdown] DB pool closed cleanly.");
    } catch (e: unknown) {
      logger.warn("[Shutdown] DB pool close error:", { error: getErrorMessage(e) });
    }
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

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
      // ── Always-running critical index: exchange_rates upsert constraint ───────
      // This index is required for the exchange_rates upsert to work correctly.
      // It runs unconditionally (even when RUN_STARTUP_MIGRATIONS=false) so that
      // production environments that skipped the bulk migration still get it.
      // CREATE UNIQUE INDEX IF NOT EXISTS is a no-op if the index already exists.
      try {
        await pool.query(
          `CREATE UNIQUE INDEX IF NOT EXISTS exchange_rates_company_date_pair_unique
           ON exchange_rates (company_id, effective_date, from_currency, to_currency)`
        );
      } catch (idxErr: unknown) {
        // Non-fatal: upsertExchangeRate has a fallback that works without the index.
        logger.warn("[startup] Could not ensure exchange_rates unique index:", { error: getErrorMessage(idxErr) });
      }

      // ── Always-running multi-currency schema columns ──────────────────────────
      // These columns were added by migrations 0011, 0012, 20260720_002–006, but
      // production uses RUN_STARTUP_MIGRATIONS=false so those migrations never ran.
      // ALTER TABLE … ADD COLUMN IF NOT EXISTS is idempotent — safe to run every
      // startup.  Without these columns, /api/stats/net-profit returns 500 and the
      // dashboard shows the "Some financial data could not be loaded" error banner.
      try {
        await pool.query(`
          -- vouchers: currency column (migration 0011)
          ALTER TABLE vouchers
            ADD COLUMN IF NOT EXISTS currency VARCHAR(3) NOT NULL DEFAULT 'USD';

          -- user_preferences: preferred_currency (migration 0012)
          ALTER TABLE user_preferences
            ADD COLUMN IF NOT EXISTS preferred_currency VARCHAR(10);

          -- voucher_entries: multi-currency audit columns (migration 20260720_002)
          ALTER TABLE voucher_entries
            ADD COLUMN IF NOT EXISTS transaction_currency        VARCHAR(3),
            ADD COLUMN IF NOT EXISTS transaction_debit_amount    NUMERIC(20,6),
            ADD COLUMN IF NOT EXISTS transaction_credit_amount   NUMERIC(20,6),
            ADD COLUMN IF NOT EXISTS base_debit_amount           NUMERIC(20,6),
            ADD COLUMN IF NOT EXISTS base_credit_amount          NUMERIC(20,6),
            ADD COLUMN IF NOT EXISTS historical_exchange_rate    NUMERIC(20,10),
            ADD COLUMN IF NOT EXISTS rate_convention             VARCHAR(30);

          -- ledger_accounts: opening balance currency (migrations 20260720_003 + 006)
          -- ledger_accounts: category column for net-profit classification
          ALTER TABLE ledger_accounts
            ADD COLUMN IF NOT EXISTS opening_balance_currency         VARCHAR(10),
            ADD COLUMN IF NOT EXISTS opening_balance_historical_rate  NUMERIC(20,10),
            ADD COLUMN IF NOT EXISTS opening_balance_base_amount      NUMERIC(20,6),
            ADD COLUMN IF NOT EXISTS opening_balance_native_amount    NUMERIC(20,6),
            ADD COLUMN IF NOT EXISTS category                         TEXT;

          -- bank_accounts: opening balance currency (migrations 20260720_004 + 006)
          ALTER TABLE bank_accounts
            ADD COLUMN IF NOT EXISTS opening_balance_currency         VARCHAR(10),
            ADD COLUMN IF NOT EXISTS opening_balance_historical_rate  NUMERIC(20,10),
            ADD COLUMN IF NOT EXISTS opening_balance_base_amount      NUMERIC(20,6),
            ADD COLUMN IF NOT EXISTS opening_balance_native_amount    NUMERIC(20,6);

          -- customers: opening balance currency (migration 20260720_006)
          ALTER TABLE customers
            ADD COLUMN IF NOT EXISTS opening_balance_native_amount    NUMERIC(20,6),
            ADD COLUMN IF NOT EXISTS opening_balance_currency         VARCHAR(10),
            ADD COLUMN IF NOT EXISTS opening_balance_historical_rate  NUMERIC(20,10),
            ADD COLUMN IF NOT EXISTS opening_balance_base_amount      NUMERIC(20,6);

          -- suppliers: opening balance currency + side (migration 20260720_006)
          ALTER TABLE suppliers
            ADD COLUMN IF NOT EXISTS opening_balance_side             VARCHAR(2) DEFAULT 'Cr',
            ADD COLUMN IF NOT EXISTS opening_balance_native_amount    NUMERIC(20,6),
            ADD COLUMN IF NOT EXISTS opening_balance_currency         VARCHAR(10),
            ADD COLUMN IF NOT EXISTS opening_balance_historical_rate  NUMERIC(20,10),
            ADD COLUMN IF NOT EXISTS opening_balance_base_amount      NUMERIC(20,6);

          -- employees: opening balance currency + side (migration 20260720_006)
          ALTER TABLE employees
            ADD COLUMN IF NOT EXISTS opening_balance_side             VARCHAR(2) DEFAULT 'Cr',
            ADD COLUMN IF NOT EXISTS opening_balance_native_amount    NUMERIC(20,6),
            ADD COLUMN IF NOT EXISTS opening_balance_currency         VARCHAR(10),
            ADD COLUMN IF NOT EXISTS opening_balance_historical_rate  NUMERIC(20,10),
            ADD COLUMN IF NOT EXISTS opening_balance_base_amount      NUMERIC(20,6);

          -- fixed_assets: purchase currency (migration 20260720_006)
          ALTER TABLE fixed_assets
            ADD COLUMN IF NOT EXISTS purchase_native_amount           NUMERIC(20,6),
            ADD COLUMN IF NOT EXISTS purchase_currency                VARCHAR(10),
            ADD COLUMN IF NOT EXISTS purchase_historical_rate         NUMERIC(20,10),
            ADD COLUMN IF NOT EXISTS purchase_base_amount             NUMERIC(20,6);

          -- salary_advances: remaining_balance + fully_paid (added in a later drizzle migration
          -- that never ran on production because RUN_STARTUP_MIGRATIONS=false).
          -- Without these columns /api/stats/net-profit throws "column does not exist" and
          -- the dashboard shows the financial-data error banner.
          ALTER TABLE salary_advances
            ADD COLUMN IF NOT EXISTS remaining_balance DECIMAL(15,2) NOT NULL DEFAULT 0,
            ADD COLUMN IF NOT EXISTS fully_paid        BOOLEAN       NOT NULL DEFAULT false;

          -- suppliers: stock_group_id added in Drizzle schema (startupSchema migration index
          -- ~2423) but that migration is disabled on production via RUN_STARTUP_MIGRATIONS=false.
          -- db.select().from(schema.suppliers) generates SQL that includes this column; if it
          -- doesn't exist in production the entire SELECT fails with "column does not exist"
          -- → 500 on GET /api/accounts/voucher-sidebar and anywhere else that lists suppliers.
          -- Added here without the FK constraint so it applies even if stock_groups isn't
          -- yet present; the FK is enforced by the startupSchema migration when it runs.
          ALTER TABLE suppliers
            ADD COLUMN IF NOT EXISTS stock_group_id INTEGER;

          -- user_preferences: per-user widget visibility toggles (added post-multicurrency
          -- Drizzle schema; never reached production because RUN_STARTUP_MIGRATIONS=false).
          -- Missing columns cause 500s on /api/user-preferences reads.
          ALTER TABLE user_preferences
            ADD COLUMN IF NOT EXISTS show_chat_widget BOOLEAN NOT NULL DEFAULT true,
            ADD COLUMN IF NOT EXISTS show_notes_panel BOOLEAN NOT NULL DEFAULT true;

          -- factory_containers: server-side shared OTW notes + docs-received flag.
          -- Previously stored in localStorage (per-browser); moved to DB so all users share
          -- the same state. Missing columns cause 500s on PATCH /api/factory/containers/:id
          -- when otwNote or otwDocsReceived are included in the request body.
          ALTER TABLE factory_containers
            ADD COLUMN IF NOT EXISTS otw_note TEXT,
            ADD COLUMN IF NOT EXISTS otw_docs_received BOOLEAN NOT NULL DEFAULT false;

          -- factory_containers: JSONCargo tracking columns.
          -- Drizzle enumerates every declared column in INSERT statements. These three
          -- columns were added to the schema but never applied to production (which runs
          -- with RUN_STARTUP_MIGRATIONS=false), so every new factory-container CREATE
          -- failed with a "column does not exist" error. Added here idempotently so
          -- production gets the columns on next startup regardless of migration mode.
          ALTER TABLE factory_containers
            ADD COLUMN IF NOT EXISTS json_cargo_last_checked_at  TIMESTAMPTZ,
            ADD COLUMN IF NOT EXISTS json_cargo_tracking_status  TEXT,
            ADD COLUMN IF NOT EXISTS json_cargo_error            TEXT;

          -- fiscal_period_closures: the startup migration at index 2673 only adds an FK
          -- constraint but never creates the table itself. Add it here idempotently so the
          -- table exists before the FK migration runs (it is a no-op if already present).
          CREATE TABLE IF NOT EXISTS fiscal_period_closures (
            id                          SERIAL PRIMARY KEY,
            company_id                  INTEGER      NOT NULL,
            period_start_date           DATE         NOT NULL,
            period_end_date             DATE         NOT NULL,
            closure_date                TIMESTAMP    NOT NULL DEFAULT NOW(),
            closed_by_user_id           VARCHAR      NOT NULL,
            closing_voucher_id          INTEGER      NOT NULL,
            retained_earnings_account_id INTEGER     NOT NULL,
            total_income                DECIMAL(15,2) NOT NULL,
            total_expense               DECIMAL(15,2) NOT NULL,
            net_income                  DECIMAL(15,2) NOT NULL,
            status                      TEXT         NOT NULL DEFAULT 'CLOSED',
            notes                       TEXT,
            created_at                  TIMESTAMP    NOT NULL DEFAULT NOW()
          );
          CREATE UNIQUE INDEX IF NOT EXISTS fiscal_closures_company_period_unique
            ON fiscal_period_closures (company_id, period_end_date);

          -- factory_status_builder_log: added in a startupSchema migration (July 2026)
          -- that never ran on production because RUN_STARTUP_MIGRATIONS=false.
          -- Missing table causes "[StatusBuilder] history log failed" errors on every
          -- status-builder save and prevents the History tab from loading.
          CREATE TABLE IF NOT EXISTS factory_status_builder_log (
            id           SERIAL PRIMARY KEY,
            company_id   INTEGER NOT NULL,
            sheet_id     INTEGER NOT NULL,
            sheet_name   TEXT NOT NULL,
            row_label    TEXT NOT NULL DEFAULT '',
            column_label TEXT NOT NULL DEFAULT '',
            old_value    TEXT,
            new_value    TEXT,
            changed_by   TEXT,
            created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
          CREATE INDEX IF NOT EXISTS idx_sb_log_company_created
            ON factory_status_builder_log (company_id, created_at DESC);
          CREATE INDEX IF NOT EXISTS idx_sb_log_sheet
            ON factory_status_builder_log (sheet_id);

          -- ledger_accounts: is_hidden column (added in startup migration ~2419)
          -- Drizzle enumerates every declared column in SELECT statements. If this
          -- column is absent in production (RUN_STARTUP_MIGRATIONS=false), every
          -- getAllLedgerAccounts() call throws "column does not exist" → 500 →
          -- Pay From / Receive Into and all account pickers return empty.
          ALTER TABLE ledger_accounts
            ADD COLUMN IF NOT EXISTS is_hidden BOOLEAN NOT NULL DEFAULT false;

          -- ledger_accounts: sub_type and parent_id (declared in Drizzle schema)
          ALTER TABLE ledger_accounts
            ADD COLUMN IF NOT EXISTS sub_type  TEXT,
            ADD COLUMN IF NOT EXISTS parent_id INTEGER;
        `);
        logger.info("[startup] ✓ Multi-currency schema columns ensured");
      } catch (colErr: unknown) {
        logger.error("[startup] ✗ Could not ensure multi-currency columns:", { error: getErrorMessage(colErr) });
        // Non-fatal: the app will start but the dashboard net-profit query may still fail
        // if the columns are genuinely absent.
      }

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
      doListen();
    })
    .catch((err: unknown) => {
      logger.error("Fatal startup error:", { error: getErrorMessage(err) ?? err });
      process.exit(1);
    });
})();
