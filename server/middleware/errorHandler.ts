/**
 * Final Express error handler.
 *
 * Maps database pool/lock timeouts to 503, logs 5xx errors, and hides
 * internal messages in production. Registered after all routes so it is the
 * last stop for thrown route errors. Extracted from server/index.ts;
 * behaviour is unchanged.
 */
import type { Express, Request, Response, NextFunction } from "express";
import { logger } from "../lib/logger";

export function registerErrorHandler(app: Express): void {
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
}
