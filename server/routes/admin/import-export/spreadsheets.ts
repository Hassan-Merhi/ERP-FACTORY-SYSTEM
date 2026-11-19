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
import { z } from "zod";
import {
  emptyBody,
  emptyQuery,
  stringIdParams,
  validateRequest,
  type RequestSchemas,
} from "../../../lib/validateRequest";

// The handlers parseInt the id; an id that matches no row answers 404 (or is a no-op delete).
/** Stored Fortune Sheet blob: an array of sheets, or { mode: "excel", rawXlsx, sheets }. */
const sheetData = z.union([z.array(z.unknown()), z.record(z.string(), z.unknown())]);

const createSpreadsheetInput = {
  query: emptyQuery,
  body: z.strictObject({ name: z.string().nullable().optional(), data: sheetData.nullable().optional() }),
} satisfies RequestSchemas;

const updateSpreadsheetInput = {
  params: stringIdParams,
  query: emptyQuery,
  body: z.strictObject({ name: z.string().optional(), data: sheetData.optional() }),
} satisfies RequestSchemas;

const deleteByIdInput = { params: stringIdParams, query: emptyQuery, body: emptyBody } satisfies RequestSchemas;

// companyId always comes from the session on create; the handler re-parses with it added.
const createLiveSpreadsheetInput = {
  query: emptyQuery,
  body: insertLiveSpreadsheetSchema.omit({ companyId: true }).strict(),
} satisfies RequestSchemas;

// Same schema the handler parses with. It still lets a body companyId through (see report).
const updateLiveSpreadsheetInput = {
  params: stringIdParams,
  query: emptyQuery,
  body: insertLiveSpreadsheetSchema.partial().strict(),
} satisfies RequestSchemas;

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

  app.post(
    "/api/spreadsheets",
    requireAuth,
    requireNonPOS,
    validateRequest(createSpreadsheetInput),
    async (req: Request, res: Response) => {
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
    }
  );

  app.patch(
    "/api/spreadsheets/:id",
    requireAuth,
    requireNonPOS,
    validateRequest(updateSpreadsheetInput),
    async (req: Request, res: Response) => {
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
    }
  );

  app.delete(
    "/api/spreadsheets/:id",
    requireAuth,
    requireNonPOS,
    validateRequest(deleteByIdInput),
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const id = parseInt(req.params.id);
        await storage.deleteSpreadsheet(id, companyId);
        res.json({ message: "Spreadsheet deleted" });
      } catch (error: unknown) {
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

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

  app.post(
    "/api/live-spreadsheets",
    requireAuth,
    requireNonPOS,
    validateRequest(createLiveSpreadsheetInput),
    async (req: import("express").Request, res) => {
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
    }
  );

  app.patch(
    "/api/live-spreadsheets/:id",
    requireAuth,
    requireNonPOS,
    validateRequest(updateLiveSpreadsheetInput),
    async (req: Request, res: Response) => {
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
    }
  );

  app.delete(
    "/api/live-spreadsheets/:id",
    requireAuth,
    requireNonPOS,
    validateRequest(deleteByIdInput),
    async (req: Request, res: Response) => {
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
    }
  );
}
