/**
 * Full offline mode (Phase A3): the ERP server running on a PC against that
 * PC's local copy is read-only. Only the desktop app sets
 * OFFLINE_PC_LOCAL_MODE=read-only; the cloud never does.
 *
 * Reading works. Signing in, out and switching company work (sessions are
 * local). Every other write is refused with OFFLINE_PC_LOCAL_READ_ONLY until
 * offline entries arrive in Phase B. Background jobs (schedulers, WhatsApp and
 * email workers) must not run against a local copy; see pcLocalModeEnvironment.
 */
import type { RequestHandler } from "express";

const READS = new Set(["GET", "HEAD", "OPTIONS"]);

export const PC_LOCAL_ALLOWED_WRITES: ReadonlySet<string> = new Set([
  "POST /api/auth/login",
  "POST /api/auth/logout",
  "POST /api/auth/set-company",
]);

export function pcLocalReadOnly(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OFFLINE_PC_LOCAL_MODE === "read-only";
}

/**
 * In local mode, switch off every background job before anything starts them.
 * Returns true when local mode is on.
 */
export function applyPcLocalModeEnvironment(env: NodeJS.ProcessEnv = process.env): boolean {
  if (!pcLocalReadOnly(env)) return false;
  env.ENABLE_SCHEDULERS = "false";
  return true;
}

export function makePcLocalReadOnlyGuard(env: NodeJS.ProcessEnv = process.env): RequestHandler {
  return (req, res, next) => {
    if (!pcLocalReadOnly(env)) return next();
    const method = req.method.toUpperCase();
    if (READS.has(method)) return next();
    const path = req.originalUrl.split("?")[0];
    if (!path.startsWith("/api/") || PC_LOCAL_ALLOWED_WRITES.has(`${method} ${path}`)) return next();
    return res.status(423).json({ code: "OFFLINE_PC_LOCAL_READ_ONLY" });
  };
}
