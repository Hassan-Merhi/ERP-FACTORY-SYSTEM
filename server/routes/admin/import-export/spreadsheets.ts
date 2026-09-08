/**
 * importExportRoutes: Spreadsheet endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { storage } from "../../../storage";
import { requireAuth, requireNonPOS } from "../../../auth";
import { insertLiveSpreadsheetSchema } from "@shared/schema";
import {} from "drizzle-orm";

export function registerSpreadsheetRoutes(app: Express) {
  // ── Spreadsheets ───────────────────────────────────────────────────────────
  app.get("/api/spreadsheets", requireAuth, requireNonPOS, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const list = await storage.listSpreadsheets(companyId);
      res.json(list);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/spreadsheets/:id", requireAuth, requireNonPOS, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const id = parseInt(req.params.id);
      const sheet = await storage.getSpreadsheet(id, companyId);
      if (!sheet) return res.status(404).json({ message: "Spreadsheet not found" });
      res.json(sheet);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/spreadsheets", requireAuth, requireNonPOS, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const username = req.session?.username ?? req.session?.userId ?? "Unknown";
      const { name, data } = req.body;
      const sheet = await storage.createSpreadsheet(companyId, name || "Untitled Spreadsheet", data ?? [], username);
      res.status(201).json(sheet);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.patch("/api/spreadsheets/:id", requireAuth, requireNonPOS, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const id = parseInt(req.params.id);
      const { name, data } = req.body;
      const fields: { name?: string; data?: unknown } = {};
      if (name !== undefined) fields.name = name;
      if (data !== undefined) fields.data = data;
      const sheet = await storage.updateSpreadsheet(id, companyId, fields);
      if (!sheet) return res.status(404).json({ message: "Spreadsheet not found" });
      res.json(sheet);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.delete("/api/spreadsheets/:id", requireAuth, requireNonPOS, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const id = parseInt(req.params.id);
      await storage.deleteSpreadsheet(id, companyId);
      res.json({ message: "Spreadsheet deleted" });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // ─── Live Spreadsheet Links ───

  app.get("/api/live-spreadsheets", requireAuth, requireNonPOS, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const isAdmin =
        req.session?.currentRole === "Admin" ||
        req.session?.currentRole === "Owner" ||
        req.session?.currentRole === "Developer";
      const sheets = await storage.getLiveSpreadsheets(companyId, !isAdmin);
      res.json(sheets);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/live-spreadsheets", requireAuth, requireNonPOS, async (req: import("express").Request, res) => {
    try {
      const role = req.session?.currentRole;
      if (role !== "Admin" && role !== "Owner" && role !== "Developer") {
        return res.status(403).json({ message: "Admin or Owner role required" });
      }
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const parsed = insertLiveSpreadsheetSchema.parse({ ...req.body, companyId });
      const sheet = await storage.createLiveSpreadsheet(parsed);
      res.json(sheet);
    } catch (error: unknown) {
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  app.patch("/api/live-spreadsheets/:id", requireAuth, requireNonPOS, async (req: Request, res: Response) => {
    try {
      const role = req.session?.currentRole;
      if (role !== "Admin" && role !== "Owner" && role !== "Developer") {
        return res.status(403).json({ message: "Admin or Owner role required" });
      }
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const id = parseInt(req.params.id);
      const fields = insertLiveSpreadsheetSchema.partial().parse(req.body);
      const sheet = await storage.updateLiveSpreadsheet(id, companyId, fields);
      if (!sheet) return res.status(404).json({ message: "Not found" });
      res.json(sheet);
    } catch (error: unknown) {
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  app.delete("/api/live-spreadsheets/:id", requireAuth, requireNonPOS, async (req: Request, res: Response) => {
    try {
      const role = req.session?.currentRole;
      if (role !== "Admin" && role !== "Owner" && role !== "Developer") {
        return res.status(403).json({ message: "Admin or Owner role required" });
      }
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const id = parseInt(req.params.id);
      await storage.deleteLiveSpreadsheet(id, companyId);
      res.json({ message: "Deleted" });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
