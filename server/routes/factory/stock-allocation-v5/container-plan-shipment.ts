import type { Express, Request, Response } from "express";
import { pool } from "../../../db";
import { requireAuth } from "../../../auth";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import {
  buildPlanShipmentSummary,
  checkLifecycleTransition,
  isContainerDocumentType,
  isContainerLifecycleStatus,
  isShipmentCommitted,
  normalizeShipmentDate,
  normalizeShipmentReference,
  type ContainerLifecycleStatus,
  type ContainerShipmentState,
} from "@shared/containerShipment";
import type { PlannerQueryable } from "./container-planner-source";

function companyIdFor(req: Request): number | null {
  const value = req.session.factoryCompanyId || req.session.currentCompanyId;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function positiveInt(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

async function loadPlanHeader(client: PlannerQueryable, companyId: number, planId: number, forUpdate: boolean) {
  const result = await client.query<{ id: number; name: string }>(
    `SELECT id, name FROM factory_container_plans
     WHERE id = $1 AND company_id = $2
     ${forUpdate ? "FOR UPDATE" : ""}`,
    [planId, companyId]
  );
  return result.rows[0] ?? null;
}

type ShipmentRow = {
  container_id: number | string;
  container_name: string;
  position: number | string;
  lifecycle_status: string;
  container_number: string | null;
  carrier: string | null;
  booking_number: string | null;
  vessel_name: string | null;
  destination: string | null;
  etd: string | Date | null;
  eta: string | Date | null;
  planned_qty: number | string;
  assigned_qty: number | string;
  allocated_qty: number | string;
  document_count: number | string;
};

function isoDate(value: string | Date | null): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

/**
 * One query gives the shipment board everything it needs: lifecycle, carrier
 * details, and the Phase 4/5 readiness counts a forward transition is gated on.
 */
async function loadShipmentRows(
  client: PlannerQueryable,
  companyId: number,
  planId: number,
  forUpdateContainerId?: number
): Promise<ShipmentRow[]> {
  if (forUpdateContainerId) {
    await client.query(
      `SELECT id FROM factory_container_plan_containers
       WHERE id = $1 AND plan_id = $2 AND company_id = $3
       FOR UPDATE`,
      [forUpdateContainerId, planId, companyId]
    );
  }

  const result = await client.query<ShipmentRow>(
    `SELECT c.id AS container_id, c.name AS container_name, c.position,
            c.lifecycle_status, c.container_number, c.carrier, c.booking_number,
            c.vessel_name, c.destination, c.etd, c.eta,
            COALESCE((SELECT SUM(l.planned_qty) FROM factory_container_plan_lines l
                      WHERE l.plan_container_id = c.id AND l.company_id = c.company_id), 0)::int AS planned_qty,
            COALESCE((SELECT COUNT(*) FROM factory_container_plan_bales b
                      WHERE b.plan_container_id = c.id AND b.company_id = c.company_id), 0)::int AS assigned_qty,
            COALESCE((SELECT SUM(a.allocated_qty) FROM factory_container_plan_allocations a
                      WHERE a.plan_container_id = c.id AND a.company_id = c.company_id), 0)::int AS allocated_qty,
            COALESCE((SELECT COUNT(*) FROM factory_container_plan_documents d
                      WHERE d.plan_container_id = c.id AND d.company_id = c.company_id), 0)::int AS document_count
     FROM factory_container_plan_containers c
     WHERE c.company_id = $1 AND c.plan_id = $2
     ORDER BY c.position, c.id`,
    [companyId, planId]
  );
  return result.rows;
}

function toShipmentState(row: ShipmentRow): ContainerShipmentState & {
  containerId: number;
  containerName: string;
  position: number;
  documentCount: number;
} {
  return {
    containerId: Number(row.container_id),
    containerName: String(row.container_name),
    position: Number(row.position),
    lifecycleStatus: (isContainerLifecycleStatus(row.lifecycle_status)
      ? row.lifecycle_status
      : "PLANNED") as ContainerLifecycleStatus,
    containerNumber: row.container_number,
    carrier: row.carrier,
    bookingNumber: row.booking_number,
    vesselName: row.vessel_name,
    destination: row.destination,
    etd: isoDate(row.etd),
    eta: isoDate(row.eta),
    plannedQty: Number(row.planned_qty || 0),
    assignedQty: Number(row.assigned_qty || 0),
    allocatedQty: Number(row.allocated_qty || 0),
    documentCount: Number(row.document_count || 0),
  };
}

async function buildSummary(client: PlannerQueryable, companyId: number, planId: number) {
  const rows = await loadShipmentRows(client, companyId, planId);
  return buildPlanShipmentSummary(rows.map(toShipmentState));
}

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

  // Carrier, booking, vessel, destination, ETD/ETA.
  app.patch(
    "/api/factory/v5/container-plans/:planId/containers/:containerId/shipment",
    requireAuth,
    async (req: Request, res: Response) => {
      const client = await pool.connect();
      try {
        const companyId = companyIdFor(req);
        const planId = positiveInt(req.params.planId);
        const containerId = positiveInt(req.params.containerId);
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        if (!planId || !containerId) return res.status(400).json({ message: "Invalid plan or container id" });

        const hasDate = (key: string) => Object.prototype.hasOwnProperty.call(req.body ?? {}, key);
        for (const key of ["etd", "eta"] as const) {
          if (hasDate(key) && req.body[key] != null && normalizeShipmentDate(req.body[key]) === null) {
            return res.status(400).json({ message: `${key.toUpperCase()} must be a date in YYYY-MM-DD form.` });
          }
        }

        const fields = {
          containerNumber: normalizeShipmentReference(req.body?.containerNumber),
          carrier: normalizeShipmentReference(req.body?.carrier, 120),
          bookingNumber: normalizeShipmentReference(req.body?.bookingNumber),
          vesselName: normalizeShipmentReference(req.body?.vesselName, 120),
          destination: normalizeShipmentReference(req.body?.destination, 160),
          etd: normalizeShipmentDate(req.body?.etd),
          eta: normalizeShipmentDate(req.body?.eta),
        };

        await client.query("BEGIN");
        const header = await loadPlanHeader(client, companyId, planId, true);
        if (!header) {
          await client.query("ROLLBACK");
          return res.status(404).json({ message: "Container plan not found" });
        }

        const updated = await client.query<{ id: number }>(
          `UPDATE factory_container_plan_containers
           SET container_number = $1, carrier = $2, booking_number = $3, vessel_name = $4,
               destination = $5, etd = $6::date, eta = $7::date, updated_at = NOW()
           WHERE id = $8 AND plan_id = $9 AND company_id = $10
           RETURNING id`,
          [
            fields.containerNumber,
            fields.carrier,
            fields.bookingNumber,
            fields.vesselName,
            fields.destination,
            fields.etd,
            fields.eta,
            containerId,
            planId,
            companyId,
          ]
        );
        if (updated.rows.length === 0) {
          await client.query("ROLLBACK");
          return res.status(404).json({ message: "Container not found in this plan" });
        }

        await client.query(
          `INSERT INTO audit_log
             (user_id, username, company_id, action, table_name, record_id, record_identifier, changes, created_at)
           VALUES ($1, $2, $3, 'update', 'factory_container_plan_containers', $4, $5, $6::jsonb, NOW())`,
          [
            req.session.userId || "system",
            req.session.username || "unknown",
            companyId,
            planId,
            header.name,
            JSON.stringify({ shipmentDetails: { containerId, ...fields } }),
          ]
        );

        const summary = await buildSummary(client, companyId, planId);
        await client.query("COMMIT");
        return res.json({ success: true, planId, containerId, summary });
      } catch (error: unknown) {
        await client.query("ROLLBACK").catch(() => undefined);
        logger.error("[V5] container plan shipment update error", { error });
        return res.status(500).json({ message: getErrorMessage(error) });
      } finally {
        client.release();
      }
    }
  );

  // Advance (or correct) one container's lifecycle status.
  app.post(
    "/api/factory/v5/container-plans/:planId/containers/:containerId/shipment/status",
    requireAuth,
    async (req: Request, res: Response) => {
      const client = await pool.connect();
      try {
        const companyId = companyIdFor(req);
        const planId = positiveInt(req.params.planId);
        const containerId = positiveInt(req.params.containerId);
        const toStatus = req.body?.toStatus;
        const note = typeof req.body?.note === "string" ? req.body.note.trim().slice(0, 500) || null : null;

        if (!companyId) return res.status(400).json({ message: "No company selected" });
        if (!planId || !containerId) return res.status(400).json({ message: "Invalid plan or container id" });
        if (!isContainerLifecycleStatus(toStatus)) {
          return res.status(400).json({ message: "Unknown container status" });
        }

        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock($1, $2)", [731207, companyId]);

        const header = await loadPlanHeader(client, companyId, planId, true);
        if (!header) {
          await client.query("ROLLBACK");
          return res.status(404).json({ message: "Container plan not found" });
        }

        const rows = await loadShipmentRows(client, companyId, planId, containerId);
        const row = rows.find((entry) => Number(entry.container_id) === containerId);
        if (!row) {
          await client.query("ROLLBACK");
          return res.status(404).json({ message: "Container not found in this plan" });
        }

        const state = toShipmentState(row);
        const check = checkLifecycleTransition(state, toStatus);
        if (!check.allowed) {
          await client.query("ROLLBACK");
          return res.status(409).json({
            code: check.code,
            message: check.message,
            missingFields: check.missingFields,
          });
        }

        // Leaving PLANNED commits the container physically, so it is locked;
        // coming back to PLANNED hands it to the planner again.
        const committed = isShipmentCommitted(toStatus);
        await client.query(
          `UPDATE factory_container_plan_containers
           SET lifecycle_status = $1,
               status_changed_at = NOW(),
               status_changed_by = $2,
               is_locked = $3,
               locked_at = CASE WHEN $3 THEN COALESCE(locked_at, NOW()) ELSE NULL END,
               locked_by = CASE WHEN $3 THEN COALESCE(locked_by, $2) ELSE NULL END,
               locked_by_name = CASE WHEN $3 THEN COALESCE(locked_by_name, $4) ELSE NULL END,
               updated_at = NOW()
           WHERE id = $5 AND plan_id = $6 AND company_id = $7`,
          [
            toStatus,
            req.session.userId || null,
            committed,
            req.session.username || null,
            containerId,
            planId,
            companyId,
          ]
        );

        await client.query(
          `INSERT INTO factory_container_plan_container_events
             (company_id, plan_id, plan_container_id, from_status, to_status, note,
              created_by, created_by_name, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
          [
            companyId,
            planId,
            containerId,
            state.lifecycleStatus,
            toStatus,
            note,
            req.session.userId || null,
            req.session.username || null,
          ]
        );

        await client.query(
          `UPDATE factory_container_plans SET revision = revision + 1, updated_at = NOW()
           WHERE id = $1 AND company_id = $2`,
          [planId, companyId]
        );

        const summary = await buildSummary(client, companyId, planId);
        await client.query("COMMIT");
        return res.json({
          success: true,
          planId,
          containerId,
          fromStatus: state.lifecycleStatus,
          toStatus,
          summary,
        });
      } catch (error: unknown) {
        await client.query("ROLLBACK").catch(() => undefined);
        logger.error("[V5] container plan shipment status error", { error });
        return res.status(500).json({ message: getErrorMessage(error) });
      } finally {
        client.release();
      }
    }
  );

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
    async (req: Request, res: Response) => {
      try {
        const companyId = companyIdFor(req);
        const planId = positiveInt(req.params.planId);
        const containerId = positiveInt(req.params.containerId);
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
    async (req: Request, res: Response) => {
      try {
        const companyId = companyIdFor(req);
        const planId = positiveInt(req.params.planId);
        const containerId = positiveInt(req.params.containerId);
        const documentId = positiveInt(req.params.documentId);
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
