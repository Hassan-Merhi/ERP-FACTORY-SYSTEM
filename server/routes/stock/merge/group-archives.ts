/**
 * stockMergeRoutes: StockGroupArchive endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { storage } from "../../../storage";
import { requireAuth, requireNonPOS } from "../../../auth";
import {} from "@shared/schema";
import {} from "drizzle-orm";

export function registerStockGroupArchiveRoutes(app: Express) {
  // Stock Group Location Archives - Archive/Restore stock groups at specific locations
  app.get("/api/stock-group-archives", requireAuth, async (req, res) => {
    try {
      if (!req.session.currentCompanyId) {
        return res.status(400).json({ message: "No company selected" });
      }
      const archives = await storage.getStockGroupLocationArchives(req.session.currentCompanyId);
      res.json(archives);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/stock-group-archives/:id", requireAuth, async (req, res) => {
    try {
      if (!req.session.currentCompanyId) {
        return res.status(400).json({ message: "No company selected" });
      }
      const archive = await storage.getStockGroupLocationArchiveById(
        parseInt(req.params.id),
        req.session.currentCompanyId
      );
      if (!archive) {
        return res.status(404).json({ message: "Archive not found" });
      }
      const items = await storage.getStockGroupLocationArchiveItems(archive.id);
      res.json({ archive, items });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/stock-group-archives", requireAuth, requireNonPOS, async (req, res) => {
    try {
      if (!req.session.currentCompanyId) {
        return res.status(400).json({ message: "No company selected" });
      }
      const { locationId, stockGroupId, notes } = req.body;
      if (!locationId) {
        return res.status(400).json({ message: "Location ID is required" });
      }
      const archive = await storage.archiveStockGroupAtLocation(
        req.session.currentCompanyId,
        parseInt(locationId),
        stockGroupId !== null && stockGroupId !== undefined ? parseInt(stockGroupId) : null,
        req.user!.id,
        notes
      );
      res.json(archive);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/stock-group-archives/:id/restore", requireAuth, requireNonPOS, async (req, res) => {
    try {
      if (!req.session.currentCompanyId) {
        return res.status(400).json({ message: "No company selected" });
      }
      const archive = await storage.restoreStockGroupLocationArchive(
        parseInt(req.params.id),
        req.session.currentCompanyId
      );
      res.json(archive);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.delete("/api/stock-group-archives/:id", requireAuth, requireNonPOS, async (req, res) => {
    try {
      if (!req.session.currentCompanyId) {
        return res.status(400).json({ message: "No company selected" });
      }
      // The storage layer throws a plain "Archive not found" Error, which the
      // catch below reported as a 500. Resolve the archive here instead, the
      // same way the GET above does, so a missing or unparseable id is a 4xx
      // and the storage layer keeps no knowledge of HTTP status codes.
      const id = parseInt(req.params.id);
      if (!Number.isInteger(id)) {
        return res.status(400).json({ message: "Invalid id" });
      }
      const existing = await storage.getStockGroupLocationArchiveById(id, req.session.currentCompanyId);
      if (!existing) {
        return res.status(404).json({ message: "Archive not found" });
      }

      const permanent = req.query.permanent === "true";
      if (permanent) {
        await storage.permanentlyDeleteStockGroupLocationArchive(id, req.session.currentCompanyId);
      } else {
        await storage.deleteStockGroupLocationArchive(id, req.session.currentCompanyId);
      }
      res.json({ success: true });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // ── Stock Item Merge ────────────────────────────────────────────────────────
}
