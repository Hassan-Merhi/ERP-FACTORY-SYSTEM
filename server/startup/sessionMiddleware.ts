/**
 * Express session middleware construction.
 *
 * Builds the session config (cookie policy, SameSite, rolling expiry), swaps
 * in the PostgreSQL session store when a database is configured, and returns
 * the ready-to-use session middleware. Extracted from server/index.ts;
 * behaviour is unchanged.
 */
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import { randomBytes } from "crypto";
import type { RequestHandler } from "express";
import { resolveDatabaseSsl } from "../lib/databaseSsl.mjs";
import { logger } from "../lib/logger";

export function buildSessionMiddleware(): RequestHandler {
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
      secure:
        process.env.NODE_ENV === "production" || !!process.env.REPL_ID || process.env.CAPACITOR_ENABLED === "true",
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
  return session(sessionConfig);
}
