import type { Express, RequestHandler } from "express";
import { pool } from "../db";
import { edgeBlocksWrite, edgeStatusPayload, readFactoryEdgeConfiguration } from "./edgeRuntimePolicy.mjs";
import { hasFactoryEdgeData } from "./edgeDatabaseProof.mjs";

type EdgeConfiguration = ReturnType<typeof readFactoryEdgeConfiguration>;

export function makeFactoryEdgeWriteGuard(
  config: EdgeConfiguration,
  hasApprovedData: () => Promise<boolean>
): RequestHandler {
  return async (req, res, next) => {
    const path = req.originalUrl.split("?")[0];
    if (edgeBlocksWrite(config, req.method, path)) {
      return res.status(423).json({ code: "EDGE_READ_ONLY", message: "EDGE_READ_ONLY" });
    }

    // When operator cutover was explicitly acknowledged, still reject writes
    // against a blank/unprovisioned local database.
    if (
      config.mode === "lan" &&
      config.primary &&
      !["GET", "HEAD", "OPTIONS"].includes(req.method.toUpperCase())
    ) {
      try {
        if (!(await hasApprovedData())) {
          return res.status(503).json({ code: "EDGE_DATABASE_NOT_PROVISIONED" });
        }
      } catch {
        return res.status(503).json({ code: "EDGE_DATABASE_NOT_PROVISIONED" });
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

  app.get("/api/edge/status", async (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (config.mode !== "lan") return res.json(edgeStatusPayload(config));
    return res.json(edgeStatusPayload(config, await provisioned()));
  });
  app.use("/api", makeFactoryEdgeWriteGuard(config, provisioned));
}
