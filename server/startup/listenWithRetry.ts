/**
 * Port listening and graceful shutdown wiring.
 *
 * Opens the listening port once migrations have completed, retries after a
 * zombie EADDRINUSE holder is killed, and closes the DB pool on SIGTERM /
 * SIGINT so zero-downtime deploys don't leave zombie connections.
 * Extracted from server/index.ts; behaviour is unchanged.
 */
import type { Server } from "node:http";
import { pool } from "../db";
import { getErrorMessage } from "../lib/httpHandlers";
import { logger } from "../lib/logger";
import { log } from "../vite";

export function listenWithRetry(server: Server, port: number, onListening: () => void): void {
  // Called only after migrations have completed (see startServer below).
  const doListen = () => {
    server.listen({ port, host: "0.0.0.0", reusePort: true }, () => {
      log(`serving on port ${port}`);
      onListening();
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

  doListen();
}

export function registerGracefulShutdown(): void {
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
}
