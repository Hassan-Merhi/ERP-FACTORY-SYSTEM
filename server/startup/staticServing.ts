/**
 * Production static client serving.
 *
 * Serves the built SPA from server/public with proper cache headers, returns
 * a hard 404 for missing /assets/* files (so the index.html fallback is never
 * served as JavaScript), and falls back to index.html for SPA routing.
 * Extracted from server/index.ts; behaviour is unchanged.
 */
import express from "express";
import type { Express } from "express";
import path from "path";
import fs from "fs";

export function serveProductionClient(app: Express): void {
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
