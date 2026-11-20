// Extracted from ./baleRoutes.ts to keep that module under the source-size cap.
import type { Express } from "express";
import { z } from "zod";
import { getErrorMessage } from "../lib/httpHandlers";
import { logger } from "../lib/logger";
import { storage } from "../storage";
import { requireAuth } from "../auth";
import { insertBaleSchema } from "@shared/schema";
import { registerBaleProductRoutes } from "./baleProductRoutes";
import { parseMoneyInput, toMoney } from "../lib/money";
import {
  emptyBody,
  emptyQuery,
  stringParam,
  validateRequest,
  validatedInput,
  type RequestSchemas,
} from "../lib/validateRequest";

const baleIdParams = z.strictObject({ id: stringParam });
const numberOrString = z.union([z.number(), z.string()]);
// The handlers still run insertBaleSchema.parse with the session's companyId.
const baleCreateBody = insertBaleSchema.omit({ companyId: true }).strict();

const createBaleInput = { query: emptyQuery, body: baleCreateBody } satisfies RequestSchemas;

// The PATCH writes whatever columns it is given (no enum checks), so the types
// follow the bale columns rather than insertBaleSchema.
const updateBaleInput = {
  params: baleIdParams,
  query: emptyQuery,
  body: z.strictObject({
    // Stripped by the handler; the body company-scope middleware checks it first.
    companyId: z.unknown().optional(),
    containerId: z.number().nullable().optional(),
    barcode: z.string().optional(),
    category: z.string().optional(),
    grade: z.string().optional(),
    origin: z.string().optional(),
    weight: numberOrString.optional(),
    datePressed: z.string().optional(),
    price: numberOrString.nullable().optional(),
    currency: z.string().nullable().optional(),
    customerId: z.number().nullable().optional(),
    soldDate: z.null().optional(),
    status: z.string().optional(),
  }),
} satisfies RequestSchemas;

const deleteBaleInput = { params: baleIdParams, query: emptyQuery, body: emptyBody } satisfies RequestSchemas;

const importBalesInput = {
  query: emptyQuery,
  body: z.strictObject({ bales: z.array(baleCreateBody).optional() }),
} satisfies RequestSchemas;

const priceImportPreviewInput = {
  query: emptyQuery,
  body: z.strictObject({
    rows: z
      .array(
        z.strictObject({ barcode: numberOrString.nullable().optional(), price: numberOrString.nullable().optional() })
      )
      .optional(),
  }),
} satisfies RequestSchemas;

const priceImportApplyInput = {
  query: emptyQuery,
  body: z.strictObject({
    rows: z.array(z.strictObject({ id: numberOrString, price: numberOrString })).optional(),
  }),
} satisfies RequestSchemas;

// Module-level bwip-js cache — loaded once on first barcode request, then reused.
// This avoids the cold-start latency of re-importing the library on every request.
type BwipJsModule = typeof import("bwip-js");

let _bwipjs: BwipJsModule | null = null;

async function getBwipjs(): Promise<BwipJsModule> {
  if (!_bwipjs) {
    _bwipjs = await import("bwip-js");
  }
  return _bwipjs;
}

export class LabelPrintRequestError extends Error {}

export function registerBaleRoutesPart1(app: Express) {
  // Pre-warm bwip-js at server startup so the first barcode render is instant.
  getBwipjs().catch(() => {});
  app.get("/api/bales", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const bales = await storage.getAllBales(companyId);
      res.json(bales);
    } catch (error: unknown) {
      logger.error("Error fetching bales:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/bales/:id", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ message: "Invalid bale ID" });
      const bale = await storage.getBaleById(id);

      if (!bale) {
        return res.status(404).json({ message: "Bale not found" });
      }

      // Check company ownership
      if (bale.companyId !== companyId) {
        return res.status(403).json({ message: "Access denied" });
      }

      res.json(bale);
    } catch (error: unknown) {
      logger.error("Error fetching bale:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/bales/barcode/:barcode", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const barcode = req.params.barcode;
      const bale = await storage.getBaleByBarcode(barcode, companyId);

      if (!bale) {
        return res.status(404).json({ message: "Bale not found" });
      }

      res.json(bale);
    } catch (error: unknown) {
      logger.error("Error fetching bale by barcode:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/bales", requireAuth, validateRequest(createBaleInput), async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) {
        return res.status(400).json({ message: "No company selected" });
      }
      const data = insertBaleSchema.parse({ ...req.body, companyId });

      // Check for duplicate barcode
      const existing = await storage.getBaleByBarcode(data.barcode, companyId);
      if (existing) {
        return res.status(409).json({ message: "Barcode already exists" });
      }

      const bale = await storage.createBale(data);
      res.json(bale);
    } catch (error: unknown) {
      logger.error("Error creating bale:", { error: error });
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  app.patch("/api/bales/:id", requireAuth, validateRequest(updateBaleInput), async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const id = parseInt(validatedInput(req, updateBaleInput).params.id, 10);
      if (isNaN(id)) return res.status(400).json({ message: "Invalid bale ID" });
      const existing = await storage.getBaleById(id);

      if (!existing) {
        return res.status(404).json({ message: "Bale not found" });
      }

      // Check company ownership
      if (existing.companyId !== companyId) {
        return res.status(403).json({ message: "Access denied" });
      }

      // Prevent companyId changes
      const { companyId: _, ...updateData } = req.body;
      const bale = await storage.updateBale(id, updateData);
      res.json(bale);
    } catch (error: unknown) {
      logger.error("Error updating bale:", { error: error });
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  app.delete("/api/bales/:id", requireAuth, validateRequest(deleteBaleInput), async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const id = parseInt(validatedInput(req, deleteBaleInput).params.id, 10);
      if (isNaN(id)) return res.status(400).json({ message: "Invalid bale ID" });
      const existing = await storage.getBaleById(id);

      if (!existing) {
        return res.status(404).json({ message: "Bale not found" });
      }

      // Check company ownership
      if (existing.companyId !== companyId) {
        return res.status(403).json({ message: "Access denied" });
      }

      await storage.deleteBale(id);
      res.json({ success: true });
    } catch (error: unknown) {
      logger.error("Error deleting bale:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/bales/import", requireAuth, validateRequest(importBalesInput), async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) {
        return res.status(400).json({ message: "No company selected" });
      }
      const balesData = req.body.bales || [];

      if (!Array.isArray(balesData)) {
        return res.status(400).json({ message: "Invalid data format" });
      }

      const validatedBales = balesData.map((b) => insertBaleSchema.parse({ ...b, companyId }));

      const created = await storage.bulkCreateBales(validatedBales);
      res.json({ success: true, count: created.length, bales: created });
    } catch (error: unknown) {
      logger.error("Error importing bales:", { error: error });
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  // Price import from Excel: preview + apply
  app.post(
    "/api/bales/price-import/preview",
    requireAuth,
    validateRequest(priceImportPreviewInput),
    async (req, res) => {
      try {
        const companyId = req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        const rows: { barcode: string; price: string }[] = req.body.rows || [];
        if (!Array.isArray(rows) || rows.length === 0) {
          return res.status(400).json({ message: "No rows provided" });
        }

        const preview = await Promise.all(
          rows.map(async (row) => {
            const barcode = String(row.barcode || "").trim();
            const newPrice = parseMoneyInput(String(row.price || ""))?.toNumber() ?? NaN;
            if (!barcode) return { barcode, status: "invalid", currentPrice: null, newPrice: null };
            if (isNaN(newPrice) || newPrice < 0)
              return { barcode, status: "invalid_price", currentPrice: null, newPrice: null };
            const bale = await storage.getBaleByBarcode(barcode, companyId);
            if (!bale) return { barcode, status: "not_found", currentPrice: null, newPrice };
            const currentPrice = bale.price ? toMoney(bale.price).toNumber() : null;
            const noChange = currentPrice !== null && Math.abs(currentPrice - newPrice) < 0.001;
            return {
              id: bale.id,
              barcode,
              category: bale.category,
              grade: bale.grade,
              status: noChange ? "no_change" : "will_update",
              currentPrice,
              newPrice,
            };
          })
        );

        res.json({ preview });
      } catch (error: unknown) {
        logger.error("Error in price-import preview:", { error: error });
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  app.post("/api/bales/price-import/apply", requireAuth, validateRequest(priceImportApplyInput), async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const rows: { id: number; price: string }[] = req.body.rows || [];
      if (!Array.isArray(rows) || rows.length === 0) {
        return res.status(400).json({ message: "No rows provided" });
      }

      let updated = 0;
      for (const row of rows) {
        const id = parseInt(String(row.id));
        const price = parseMoneyInput(String(row.price))?.toNumber() ?? NaN;
        if (isNaN(id) || isNaN(price) || price < 0) continue;
        const bale = await storage.getBaleById(id);
        if (!bale || bale.companyId !== companyId) continue;
        await storage.updateBale(id, { price: String(price) });
        updated++;
      }

      res.json({ success: true, updated });
    } catch (error: unknown) {
      logger.error("Error in price-import apply:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  registerBaleProductRoutes(app);
}
