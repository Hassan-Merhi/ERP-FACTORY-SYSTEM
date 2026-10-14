import type { Express } from "express";

// The database health endpoint is registered earlier during startup by
// server/health/dbHealthRoute.ts, which exposes migration progress.
// Registering a second GET /api/health/db here made that handler unreachable.
export function registerLegacyHealthRoutes(app: Express): void {
  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, ts: Date.now() });
  });
}
