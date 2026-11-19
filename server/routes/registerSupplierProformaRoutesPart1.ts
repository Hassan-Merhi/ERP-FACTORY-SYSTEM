// Extracted from ./supplierProformaRoutes.ts to keep that module under the source-size cap.
import { parseId } from "../lib/parseId";
import { getErrorMessage } from "../lib/httpHandlers";
import { logAudit } from "./_helpers";
import { Express, type Request, type RequestHandler, type Response } from "express";
import { db } from "../db";
import { and, eq, sql } from "drizzle-orm";
import { registerContainerLoadedItemsRoutes } from "./container-loaded-items";
import { importSupplierProformaLines } from "./helpers/supplierProformaImport";
import { supplierProformaLines, supplierProformas } from "@shared/schema";
import { registerSupplierProformaRoutesPart4 } from "./registerSupplierProformaRoutesPart4";
import { z } from "zod";
import {
  emptyBody,
  emptyQuery,
  positiveIntParam,
  stringParam,
  validateRequest,
  type RequestSchemas,
} from "../lib/validateRequest";

// The handlers parseId the proforma/line id themselves; supplierId is only checked by import-lines.
const proformaParams = z.strictObject({ supplierId: stringParam, proformaId: positiveIntParam });
const lineParams = z.strictObject({ lineId: positiveIntParam });
const numericText = z.union([z.number(), z.string()]).nullable().optional();

const updateProformaInput = {
  params: proformaParams,
  query: emptyQuery,
  body: z.strictObject({
    reference: z.string().nullable().optional(),
    notes: z.string().nullable().optional(),
    destinationCompanyId: z.union([z.number(), z.string()]).optional(),
  }),
} satisfies RequestSchemas;

const deleteProformaInput = { params: proformaParams, query: emptyQuery, body: emptyBody } satisfies RequestSchemas;

const lineFields = {
  barcode: z.string().nullable().optional(),
  itemName: z.string().nullable().optional(),
  qty: numericText,
  weightPerBale: numericText,
  pricePerBale: numericText,
};

const addLineInput = {
  params: proformaParams,
  query: emptyQuery,
  body: z.strictObject(lineFields),
} satisfies RequestSchemas;
const updateLineInput = {
  params: lineParams,
  query: emptyQuery,
  body: z.strictObject(lineFields),
} satisfies RequestSchemas;
const deleteLineInput = { params: lineParams, query: emptyQuery, body: emptyBody } satisfies RequestSchemas;

/** Rows are spreadsheet records under several header spellings; normalizeProformaImportLines reads them. */
const importLinesInput = {
  params: z.strictObject({ supplierId: positiveIntParam, proformaId: positiveIntParam }),
  query: emptyQuery,
  body: z.strictObject({ lines: z.array(z.record(z.string(), z.unknown())).optional() }),
} satisfies RequestSchemas;

export function registerSupplierProformaRoutesPart1(app: Express, requireAuth: RequestHandler) {
  registerSupplierProformaRoutesPart4(app, requireAuth);

  app.patch(
    "/api/suppliers/:supplierId/proformas/:proformaId",
    requireAuth,
    validateRequest(updateProformaInput),
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const proformaId = parseId(req.params.proformaId);
        if (proformaId === null) return res.status(400).json({ message: "Invalid id" });
        const { reference, notes, destinationCompanyId } = req.body;
        if (destinationCompanyId !== undefined) {
          const destinationId = parseId(String(destinationCompanyId));
          if (destinationId === null) return res.status(400).json({ message: "Invalid destination company" });
          const allowed = await db.execute(
            sql`SELECT 1 FROM companies WHERE id = ${destinationId} AND (id = ${companyId} OR parent_company_id = ${companyId}) LIMIT 1`
          );
          if (!allowed.rows.length) return res.status(403).json({ message: "Destination not linked to company" });
          const [existing] = await db
            .select()
            .from(supplierProformas)
            .where(and(eq(supplierProformas.id, proformaId), eq(supplierProformas.companyId, companyId)));
          if (existing?.isStarred && (existing.destinationCompanyId ?? companyId) !== destinationId)
            return res.status(409).json({ message: "Unstar this proforma before changing its destination" });
        }
        const updates: Partial<typeof supplierProformas.$inferInsert> = { updatedAt: new Date() };
        if (reference !== undefined) updates.reference = reference;
        if (notes !== undefined) updates.notes = notes;
        if (destinationCompanyId !== undefined) updates.destinationCompanyId = Number(destinationCompanyId);
        const [updated] = await db
          .update(supplierProformas)
          .set(updates)
          .where(and(eq(supplierProformas.id, proformaId), eq(supplierProformas.companyId, companyId)))
          .returning();
        if (!updated) return res.status(404).json({ message: "Proforma not found" });
        res.json(updated);
      } catch (error: unknown) {
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  app.delete(
    "/api/suppliers/:supplierId/proformas/:proformaId",
    requireAuth,
    validateRequest(deleteProformaInput),
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const proformaId = parseId(req.params.proformaId);
        if (proformaId === null) return res.status(400).json({ message: "Invalid id" });
        // Lines are removed only once the proforma is confirmed to belong to the
        // company; they used to be deleted first, for any proforma id.
        const [owned] = await db
          .select({ id: supplierProformas.id })
          .from(supplierProformas)
          .where(and(eq(supplierProformas.id, proformaId), eq(supplierProformas.companyId, companyId)));
        if (!owned) return res.status(404).json({ message: "Proforma not found" });
        // Phase 21 (B): the delete and its audit commit together.
        await db.transaction(async (tx) => {
          await tx.delete(supplierProformaLines).where(eq(supplierProformaLines.proformaId, proformaId));
          await tx
            .delete(supplierProformas)
            .where(and(eq(supplierProformas.id, proformaId), eq(supplierProformas.companyId, companyId)));
          await logAudit(
            {
              userId: req.session.userId!,
              username: req.session.username || "unknown",
              companyId,
              action: "delete",
              tableName: "supplier_proformas",
              recordId: proformaId,
              recordIdentifier: `Proforma#${proformaId}`,
              changes: { deleted: { old: false, new: true } },
            },
            tx
          );
        });
        res.json({ success: true });
      } catch (error: unknown) {
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  app.post(
    "/api/suppliers/:supplierId/proformas/:proformaId/lines",
    requireAuth,
    validateRequest(addLineInput),
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const proformaId = parseId(req.params.proformaId);
        if (proformaId === null) return res.status(400).json({ message: "Invalid id" });
        const [proforma] = await db
          .select()
          .from(supplierProformas)
          .where(and(eq(supplierProformas.id, proformaId), eq(supplierProformas.companyId, companyId)));
        if (!proforma) return res.status(403).json({ message: "Access denied" });
        const { barcode, itemName, qty, weightPerBale, pricePerBale } = req.body;
        const [line] = await db
          .insert(supplierProformaLines)
          .values({
            proformaId,
            barcode: barcode || "",
            itemName: itemName || "",
            qty: parseInt(qty) || 0,
            weightPerBale: weightPerBale || "0",
            pricePerBale: pricePerBale || "0",
          })
          .returning();
        await db.update(supplierProformas).set({ updatedAt: new Date() }).where(eq(supplierProformas.id, proformaId));
        res.json(line);
      } catch (error: unknown) {
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  app.patch(
    "/api/supplier-proforma-lines/:lineId",
    requireAuth,
    validateRequest(updateLineInput),
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const lineId = parseId(req.params.lineId);
        if (lineId === null) return res.status(400).json({ message: "Invalid id" });
        const [line] = await db.select().from(supplierProformaLines).where(eq(supplierProformaLines.id, lineId));
        if (!line) return res.status(404).json({ message: "Line not found" });
        const [proforma] = await db
          .select()
          .from(supplierProformas)
          .where(and(eq(supplierProformas.id, line.proformaId), eq(supplierProformas.companyId, companyId)));
        if (!proforma) return res.status(403).json({ message: "Access denied" });
        const updates: Partial<typeof supplierProformaLines.$inferInsert> = {};
        if (req.body.barcode !== undefined) updates.barcode = req.body.barcode;
        if (req.body.itemName !== undefined) updates.itemName = req.body.itemName;
        if (req.body.qty !== undefined) updates.qty = parseInt(req.body.qty) || 0;
        if (req.body.weightPerBale !== undefined) updates.weightPerBale = req.body.weightPerBale;
        if (req.body.pricePerBale !== undefined) updates.pricePerBale = req.body.pricePerBale;
        const [updated] = await db
          .update(supplierProformaLines)
          .set(updates)
          .where(eq(supplierProformaLines.id, lineId))
          .returning();
        await db.update(supplierProformas).set({ updatedAt: new Date() }).where(eq(supplierProformas.id, proforma.id));
        res.json(updated);
      } catch (error: unknown) {
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  app.delete(
    "/api/supplier-proforma-lines/:lineId",
    requireAuth,
    validateRequest(deleteLineInput),
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const lineId = parseId(req.params.lineId);
        if (lineId === null) return res.status(400).json({ message: "Invalid id" });
        const [line] = await db.select().from(supplierProformaLines).where(eq(supplierProformaLines.id, lineId));
        if (!line) return res.status(404).json({ message: "Line not found" });
        const [proforma] = await db
          .select()
          .from(supplierProformas)
          .where(and(eq(supplierProformas.id, line.proformaId), eq(supplierProformas.companyId, companyId)));
        if (!proforma) return res.status(403).json({ message: "Access denied" });
        await db.delete(supplierProformaLines).where(eq(supplierProformaLines.id, lineId));
        await db.update(supplierProformas).set({ updatedAt: new Date() }).where(eq(supplierProformas.id, proforma.id));
        res.json({ success: true });
      } catch (error: unknown) {
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  app.post(
    "/api/suppliers/:supplierId/proformas/:proformaId/import-lines",
    requireAuth,
    validateRequest(importLinesInput),
    async (req: Request, res: Response) => {
      await importSupplierProformaLines(req, res);
    }
  );

  registerContainerLoadedItemsRoutes(app, requireAuth);
}
