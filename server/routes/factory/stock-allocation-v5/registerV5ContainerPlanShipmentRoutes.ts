// Extracted from ./container-plan-shipment.ts to keep that module under the source-size cap.
import type { Express, Request, Response } from "express";
import { pool } from "../../../db";
import { requireAuth } from "../../../auth";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { isContainerDocumentType, normalizeShipmentDate, normalizeShipmentReference } from "@shared/containerShipment";
import type { PlannerQueryable } from "./container-planner-source";
import { buildSummary, companyIdFor, loadPlanHeader, positiveInt } from "./loadShipmentRows";
import { registerV5ContainerPlanShipmentRoutesPart1 } from "./registerV5ContainerPlanShipmentRoutesPart1";
import { validateRequest, validatedInput } from "../../../lib/validateRequest";
import { createDocumentInput, deleteDocumentInput } from "./registerV5ContainerPlanShipmentRoutesSchemas";

export function registerV5ContainerPlanShipmentRoutes(app: Express): void {
  // Shipment board for the whole plan.
  app.get("/api/factory/v5/container-plans/:planId/shipments", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = companyIdFor(req);
      const planId = positiveInt(req.params.planId);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      if (!planId) return res.status(400).json({ message: "Invalid plan id" });

      const client = pool as unknown as PlannerQueryable;
      const header = await loadPlanHeader(client, companyId, planId, false);
      if (!header) return res.status(404).json({ message: "Container plan not found" });

      return res.json({
        planId,
        planName: header.name,
        checkedAt: new Date().toISOString(),
        summary: await buildSummary(client, companyId, planId),
      });
    } catch (error: unknown) {
      logger.error("[V5] container plan shipment read error", { error });
      return res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  registerV5ContainerPlanShipmentRoutesPart1(app);

  app.get(
    "/api/factory/v5/container-plans/:planId/containers/:containerId/shipment/timeline",
    requireAuth,
    async (req: Request, res: Response) => {
      try {
        const companyId = companyIdFor(req);
        const planId = positiveInt(req.params.planId);
        const containerId = positiveInt(req.params.containerId);
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        if (!planId || !containerId) return res.status(400).json({ message: "Invalid plan or container id" });

        const result = await pool.query(
          `SELECT id, from_status AS "fromStatus", to_status AS "toStatus", note,
                  created_by_name AS "createdByName", created_at AS "createdAt"
           FROM factory_container_plan_container_events
           WHERE company_id = $1 AND plan_id = $2 AND plan_container_id = $3
           ORDER BY created_at DESC, id DESC
           LIMIT 200`,
          [companyId, planId, containerId]
        );

        return res.json({ planId, containerId, events: result.rows });
      } catch (error: unknown) {
        logger.error("[V5] container plan shipment timeline error", { error });
        return res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  // Shipping paperwork attached to a container.
  app.get(
    "/api/factory/v5/container-plans/:planId/containers/:containerId/documents",
    requireAuth,
    async (req: Request, res: Response) => {
      try {
        const companyId = companyIdFor(req);
        const planId = positiveInt(req.params.planId);
        const containerId = positiveInt(req.params.containerId);
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        if (!planId || !containerId) return res.status(400).json({ message: "Invalid plan or container id" });

        const result = await pool.query(
          `SELECT id, document_type AS "documentType", title, reference, file_url AS "fileUrl",
                  issued_on AS "issuedOn", uploaded_by_name AS "uploadedByName", created_at AS "createdAt"
           FROM factory_container_plan_documents
           WHERE company_id = $1 AND plan_id = $2 AND plan_container_id = $3
           ORDER BY document_type, id`,
          [companyId, planId, containerId]
        );

        return res.json({ planId, containerId, documents: result.rows });
      } catch (error: unknown) {
        logger.error("[V5] container plan document read error", { error });
        return res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  app.post(
    "/api/factory/v5/container-plans/:planId/containers/:containerId/documents",
    requireAuth,
    validateRequest(createDocumentInput),
    async (req: Request, res: Response) => {
      try {
        const companyId = companyIdFor(req);
        const { params } = validatedInput(req, createDocumentInput);
        const planId = positiveInt(params.planId);
        const containerId = positiveInt(params.containerId);
        const documentType = req.body?.documentType;
        const title = normalizeShipmentReference(req.body?.title, 200);

        if (!companyId) return res.status(400).json({ message: "No company selected" });
        if (!planId || !containerId) return res.status(400).json({ message: "Invalid plan or container id" });
        if (!isContainerDocumentType(documentType)) {
          return res.status(400).json({ message: "Unknown document type" });
        }
        if (!title) return res.status(400).json({ message: "Document title is required" });
        if (req.body?.issuedOn != null && normalizeShipmentDate(req.body.issuedOn) === null) {
          return res.status(400).json({ message: "Issue date must be a date in YYYY-MM-DD form." });
        }

        const container = await pool.query<{ id: number }>(
          `SELECT id FROM factory_container_plan_containers
           WHERE id = $1 AND plan_id = $2 AND company_id = $3`,
          [containerId, planId, companyId]
        );
        if (container.rows.length === 0) {
          return res.status(404).json({ message: "Container not found in this plan" });
        }

        const inserted = await pool.query(
          `INSERT INTO factory_container_plan_documents
             (company_id, plan_id, plan_container_id, document_type, title, reference, file_url,
              issued_on, uploaded_by, uploaded_by_name, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::date, $9, $10, NOW(), NOW())
           RETURNING id, document_type AS "documentType", title, reference, file_url AS "fileUrl",
                     issued_on AS "issuedOn", created_at AS "createdAt"`,
          [
            companyId,
            planId,
            containerId,
            documentType,
            title,
            normalizeShipmentReference(req.body?.reference, 120),
            normalizeShipmentReference(req.body?.fileUrl, 2000),
            normalizeShipmentDate(req.body?.issuedOn),
            req.session.userId || null,
            req.session.username || null,
          ]
        );

        return res.status(201).json({ success: true, document: inserted.rows[0] });
      } catch (error: unknown) {
        logger.error("[V5] container plan document create error", { error });
        return res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  app.delete(
    "/api/factory/v5/container-plans/:planId/containers/:containerId/documents/:documentId",
    requireAuth,
    validateRequest(deleteDocumentInput),
    async (req: Request, res: Response) => {
      try {
        const companyId = companyIdFor(req);
        const { params } = validatedInput(req, deleteDocumentInput);
        const planId = positiveInt(params.planId);
        const containerId = positiveInt(params.containerId);
        const documentId = positiveInt(params.documentId);
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        if (!planId || !containerId || !documentId) {
          return res.status(400).json({ message: "Invalid plan, container or document id" });
        }

        const deleted = await pool.query<{ id: number }>(
          `DELETE FROM factory_container_plan_documents
           WHERE id = $1 AND company_id = $2 AND plan_id = $3 AND plan_container_id = $4
           RETURNING id`,
          [documentId, companyId, planId, containerId]
        );
        if (deleted.rows.length === 0) return res.status(404).json({ message: "Document not found" });

        return res.json({ success: true, deletedId: documentId });
      } catch (error: unknown) {
        logger.error("[V5] container plan document delete error", { error });
        return res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );
}
