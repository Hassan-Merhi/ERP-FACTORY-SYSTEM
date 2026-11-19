// Extracted from ./registerV5ContainerPlanShipmentRoutes.ts
import type { Express, Request, Response } from "express";
import { pool } from "../../../db";
import { requireAuth } from "../../../auth";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import {
  checkLifecycleTransition,
  isContainerLifecycleStatus,
  isShipmentCommitted,
  normalizeShipmentDate,
  normalizeShipmentReference,
} from "@shared/containerShipment";
import {
  buildSummary,
  companyIdFor,
  loadPlanHeader,
  loadShipmentRows,
  positiveInt,
  toShipmentState,
} from "./loadShipmentRows";
import { validateRequest, validatedInput } from "../../../lib/validateRequest";
import { shipmentStatusInput, updateShipmentInput } from "./registerV5ContainerPlanShipmentRoutesSchemas";

export function registerV5ContainerPlanShipmentRoutesPart1(app: Express) {
  // Carrier, booking, vessel, destination, ETD/ETA.
  app.patch(
    "/api/factory/v5/container-plans/:planId/containers/:containerId/shipment",
    requireAuth,
    validateRequest(updateShipmentInput),
    async (req: Request, res: Response) => {
      const client = await pool.connect();
      try {
        const companyId = companyIdFor(req);
        const { params } = validatedInput(req, updateShipmentInput);
        const planId = positiveInt(params.planId);
        const containerId = positiveInt(params.containerId);
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
    validateRequest(shipmentStatusInput),
    async (req: Request, res: Response) => {
      const client = await pool.connect();
      try {
        const companyId = companyIdFor(req);
        const { params } = validatedInput(req, shipmentStatusInput);
        const planId = positiveInt(params.planId);
        const containerId = positiveInt(params.containerId);
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
}
