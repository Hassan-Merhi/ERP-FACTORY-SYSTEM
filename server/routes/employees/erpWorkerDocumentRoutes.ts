import type { Express } from "express";
import { and, desc, eq } from "drizzle-orm";

import { requireAuth, requireNonPOS } from "../../auth";
import { db } from "../../db";
import { z } from "zod";
import { getErrorMessage } from "../../lib/httpHandlers";
import { emptyBody, emptyQuery, stringParam, validateRequest, type RequestSchemas } from "../../lib/validateRequest";
import { erpWorkerDocs, insertErpWorkerDocSchema } from "@shared/schema";

// The handlers parse ids with parseInt, so the ids stay strings here.
const docIdParams = z.strictObject({ id: stringParam });

const createDocInput = {
  params: docIdParams,
  query: emptyQuery,
  // companyId and employeeId come from the session and the path.
  body: insertErpWorkerDocSchema.omit({ companyId: true, employeeId: true }).strict(),
} satisfies RequestSchemas;

const updateDocInput = {
  params: docIdParams,
  query: emptyQuery,
  body: z.strictObject({
    description: z.string().nullable().optional(),
    fileName: z.string().optional(),
  }),
} satisfies RequestSchemas;

const deleteDocInput = { params: docIdParams, query: emptyQuery, body: emptyBody } satisfies RequestSchemas;

export function registerErpWorkerDocumentRoutes(app: Express): void {
  app.get("/api/employees/:id/docs", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const employeeId = parseInt(req.params.id);
      if (isNaN(employeeId)) return res.status(400).json({ message: "Invalid employee ID" });
      const docs = await db
        .select({
          id: erpWorkerDocs.id,
          employeeId: erpWorkerDocs.employeeId,
          companyId: erpWorkerDocs.companyId,
          fileName: erpWorkerDocs.fileName,
          fileType: erpWorkerDocs.fileType,
          fileSize: erpWorkerDocs.fileSize,
          description: erpWorkerDocs.description,
          uploadedBy: erpWorkerDocs.uploadedBy,
          uploadedAt: erpWorkerDocs.uploadedAt,
        })
        .from(erpWorkerDocs)
        .where(and(eq(erpWorkerDocs.companyId, companyId), eq(erpWorkerDocs.employeeId, employeeId)))
        .orderBy(desc(erpWorkerDocs.uploadedAt));
      res.json(docs);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/employees/:id/docs", requireAuth, requireNonPOS, validateRequest(createDocInput), async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const employeeId = parseInt(req.params.id);
      if (isNaN(employeeId)) return res.status(400).json({ message: "Invalid employee ID" });
      const parsed = insertErpWorkerDocSchema.parse({ ...req.body, companyId, employeeId });
      const [doc] = await db.insert(erpWorkerDocs).values(parsed).returning();
      res.status(201).json(doc);
    } catch (error: unknown) {
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  app.patch(
    "/api/erp-worker-docs/:id",
    requireAuth,
    requireNonPOS,
    validateRequest(updateDocInput),
    async (req, res) => {
      try {
        const companyId = req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const docId = parseInt(req.params.id);
        if (isNaN(docId)) return res.status(400).json({ message: "Invalid doc ID" });
        const [existing] = await db
          .select()
          .from(erpWorkerDocs)
          .where(and(eq(erpWorkerDocs.id, docId), eq(erpWorkerDocs.companyId, companyId)));
        if (!existing) return res.status(404).json({ message: "Document not found" });
        const { description, fileName } = req.body;
        const [updated] = await db
          .update(erpWorkerDocs)
          .set({ description, fileName })
          .where(eq(erpWorkerDocs.id, docId))
          .returning();
        res.json(updated);
      } catch (error: unknown) {
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  app.delete(
    "/api/erp-worker-docs/:id",
    requireAuth,
    requireNonPOS,
    validateRequest(deleteDocInput),
    async (req, res) => {
      try {
        const companyId = req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const docId = parseInt(req.params.id);
        if (isNaN(docId)) return res.status(400).json({ message: "Invalid doc ID" });
        const [existing] = await db
          .select()
          .from(erpWorkerDocs)
          .where(and(eq(erpWorkerDocs.id, docId), eq(erpWorkerDocs.companyId, companyId)));
        if (!existing) return res.status(404).json({ message: "Document not found" });
        await db.delete(erpWorkerDocs).where(eq(erpWorkerDocs.id, docId));
        res.json({ message: "Document deleted" });
      } catch (error: unknown) {
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  app.get("/api/erp-worker-docs/:id/download", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const docId = parseInt(req.params.id);
      if (isNaN(docId)) return res.status(400).json({ message: "Invalid doc ID" });
      const [doc] = await db
        .select()
        .from(erpWorkerDocs)
        .where(and(eq(erpWorkerDocs.id, docId), eq(erpWorkerDocs.companyId, companyId)));
      if (!doc) return res.status(404).json({ message: "Document not found" });
      const base64Data = doc.fileData.split(",").pop() || doc.fileData;
      const buffer = Buffer.from(base64Data, "base64");
      res.set("Content-Type", doc.fileType);
      res.set("Content-Disposition", `attachment; filename="${doc.fileName}"`);
      res.send(buffer);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
