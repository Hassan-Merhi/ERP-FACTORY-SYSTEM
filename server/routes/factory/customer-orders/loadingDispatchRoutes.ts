/**
 * Factory container-loading dispatch foundation.
 *
 * Each trip is owned by ONE customer loading order in the active company.
 * Option A: create/list/read trips only; no mutations to loaded bales, stock,
 * invoices, proformas or accounting. Scanner/compare/close are later phases.
 */
import type { Express, Request, Response } from "express";
import { sql } from "drizzle-orm";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { requireFactoryTabAccess, getFactoryAccessState } from "../../../lib/factoryAccessControl";
import { parseId } from "../../../lib/parseId";
import { resultRows } from "../../../lib/queryResult";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";

const loadingAccess = requireFactoryTabAccess("factory/invoicing", "hide_invoicing_loadings_tab");

function parseOptionalText(raw: unknown, field: string, maxLength: number): string | null {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string") throw new Error(`${field} must be text`);
  const value = raw.trim();
  if (value.length > maxLength) throw new Error(`${field} must be at most ${maxLength} characters`);
  return value || null;
}

function parseTripNumber(raw: unknown): number {
  const textValue = typeof raw === "number" ? String(raw) : raw;
  if (typeof textValue !== "string" || !/^[1-9][0-9]*$/.test(textValue.trim())) {
    throw new Error("Trip number must be a positive whole number");
  }
  const number = Number(textValue.trim());
  if (!Number.isSafeInteger(number) || number > 2147483647) {
    throw new Error("Trip number must be between 1 and 2147483647");
  }
  return number;
}

function isUniqueViolation(error: unknown): boolean {
  const candidate = error as { code?: string; cause?: { code?: string } } | null;
  return candidate?.code === "23505" || candidate?.cause?.code === "23505";
}

async function resolveOrder(req: Request, res: Response) {
  const state = await getFactoryAccessState(req);
  if (!state) {
    res.status(403).json({ message: "Factory company access is unavailable" });
    return null;
  }

  const orderId = parseId(req.params.id);
  if (orderId === null) {
    res.status(400).json({ message: "Invalid loading order ID" });
    return null;
  }

  const result = await db.execute(sql`
    SELECT id, status, container_number AS "containerNumber",
           customer_id AS "customerId", proforma_id_used AS "proformaIdUsed",
           deleted_at AS "deletedAt"
      FROM customer_orders
     WHERE id = ${orderId} AND company_id = ${state.companyId}
     LIMIT 1
  `);
  const order = resultRows(result)[0];
  if (!order) {
    res.status(404).json({ message: "Loading order not found in this company" });
    return null;
  }
  return { state, orderId, order };
}

export function registerFactoryLoadingDispatchRoutes(app: Express): void {
  // List every independent truck trip linked to this exact loading/order.
  app.get("/api/factory/customer-orders/:id/loading-dispatches", requireAuth, loadingAccess, async (req, res) => {
    try {
      const scope = await resolveOrder(req, res);
      if (!scope) return;

      const rows = await db.execute(sql`
        SELECT d.id, d.company_id AS "companyId", d.order_id AS "orderId",
               d.dispatch_number AS "dispatchNumber", d.status,
               d.container_number_snapshot AS "containerNumberSnapshot",
               d.truck_plate AS "truckPlate", d.driver_name AS "driverName",
               d.destination, d.notes,
               d.created_by_user_id AS "createdByUserId",
               d.created_by_username AS "createdByUsername",
               d.created_at AS "createdAt", d.updated_at AS "updatedAt",
               d.closed_at AS "closedAt",
               (SELECT COUNT(*)::integer FROM factory_loading_dispatch_scans s
                 WHERE s.dispatch_id = d.id AND s.company_id = d.company_id
                   AND s.order_id = d.order_id AND s.removed_at IS NULL) AS "scannedBales",
               (SELECT COALESCE(SUM(s.weight_kg), 0)::text FROM factory_loading_dispatch_scans s
                 WHERE s.dispatch_id = d.id AND s.company_id = d.company_id
                   AND s.order_id = d.order_id AND s.removed_at IS NULL) AS "scannedWeightKg"
          FROM factory_loading_dispatches d
         WHERE d.company_id = ${scope.state.companyId}
           AND d.order_id = ${scope.orderId}
           AND d.status <> 'CANCELLED'
         ORDER BY d.dispatch_number DESC
      `);
      res.set("Cache-Control", "private, no-store");
      res.set("X-Factory-Dispatch-API", "v1");
      res.json({
        orderId: scope.orderId,
        containerNumber: scope.order.containerNumber,
        dispatches: resultRows(rows),
      });
    } catch (error) {
      logger.error("Error listing Factory loading dispatches", { error });
      res.status(500).json({ message: "Could not load dispatch trips" });
    }
  });

  // Read one trip without exposing trips linked to other companies/orders.
  app.get("/api/factory/customer-orders/:id/loading-dispatches/:dispatchId", requireAuth, loadingAccess, async (req, res) => {
    try {
      const scope = await resolveOrder(req, res);
      if (!scope) return;
      const dispatchId = parseId(req.params.dispatchId);
      if (dispatchId === null) return res.status(400).json({ message: "Invalid dispatch ID" });

      const rows = await db.execute(sql`
        SELECT d.id, d.company_id AS "companyId", d.order_id AS "orderId",
               d.dispatch_number AS "dispatchNumber", d.status,
               d.truck_plate AS "truckPlate", d.driver_name AS "driverName",
               d.destination, d.notes, d.created_by_user_id AS "createdByUserId",
               d.created_by_username AS "createdByUsername",
               d.created_at AS "createdAt", d.updated_at AS "updatedAt",
               d.closed_at AS "closedAt", d.closed_by_user_id AS "closedByUserId",
               d.reopened_at AS "reopenedAt", d.reopen_reason AS "reopenReason"
          FROM factory_loading_dispatches d
         WHERE d.id = ${dispatchId} AND d.company_id = ${scope.state.companyId}
           AND d.order_id = ${scope.orderId}
           AND d.status <> 'CANCELLED'
         LIMIT 1
      `);
      const dispatch = resultRows(rows)[0];
      if (!dispatch) return res.status(404).json({ message: "Dispatch not found for this loading" });
      return res.json({ ...dispatch, containerNumber: scope.order.containerNumber });
    } catch (error) {
      logger.error("Error reading Factory loading dispatch", { error });
      return res.status(500).json({ message: "Could not load dispatch trip" });
    }
  });


  // Phase 2: update trip metadata only. Never touch main loading, bale
  // inventory, accounting, status/finalization or another company's trips.
  app.patch("/api/factory/customer-orders/:id/loading-dispatches/:dispatchId", requireAuth, loadingAccess, async (req, res) => {
    try {
      const scope = await resolveOrder(req, res);
      if (!scope) return;
      if (["View Only", "Create Only"].includes(scope.state.role)) {
        return res.status(403).json({ message: "This Factory role cannot modify dispatch trips" });
      }
      const dispatchId = parseId(req.params.dispatchId);
      if (dispatchId === null) return res.status(400).json({ message: "Invalid dispatch ID" });

      const editable = ["tripNumber", "notes"] as const;
      const body: Record<string, unknown> =
        req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
      const provided = Object.keys(body);
      if (provided.length === 0 || provided.some((key) => !editable.includes(key as (typeof editable)[number]))) {
        return res.status(400).json({ message: "Only tripNumber and notes may be updated" });
      }
      let tripNumber: number | undefined;
      let notes: string | null | undefined;
      try {
        if (Object.prototype.hasOwnProperty.call(body, "tripNumber")) {
          tripNumber = parseTripNumber(body.tripNumber);
        }
        if (Object.prototype.hasOwnProperty.call(body, "notes")) {
          notes = parseOptionalText(body.notes, "notes", 3000);
        }
      } catch (error) {
        return res.status(400).json({ message: getErrorMessage(error) });
      }

      const actorUserId = String(scope.state.userId);
      const actorUsername = String(req.session.username || actorUserId);
      const result = await db.transaction(async (tx) => {
        // Serialize number edits with creates for this loading.
        await tx.execute(sql`
          SELECT id FROM customer_orders
           WHERE id = ${scope.orderId} AND company_id = ${scope.state.companyId}
           FOR UPDATE
        `);
        const locked = await tx.execute(sql`
          SELECT id, status, dispatch_number AS "dispatchNumber", notes
            FROM factory_loading_dispatches
           WHERE id = ${dispatchId} AND company_id = ${scope.state.companyId}
             AND order_id = ${scope.orderId}
           FOR UPDATE
        `);
        const previous = resultRows(locked)[0];
        if (!previous) return { httpStatus: 404, message: "Dispatch not found for this loading" };
        if (previous.status !== "OPEN") return { httpStatus: 409, message: "Only open dispatches may be edited" };

        const nextNumber = tripNumber ?? Number(previous.dispatchNumber);
        const nextNotes = notes !== undefined ? notes : previous.notes;
        const changes: Record<string, { old: unknown; new: unknown }> = {};
        if (tripNumber !== undefined && nextNumber !== Number(previous.dispatchNumber)) {
          const collision = await tx.execute(sql`
            SELECT id FROM factory_loading_dispatches
             WHERE company_id = ${scope.state.companyId} AND order_id = ${scope.orderId}
               AND dispatch_number = ${nextNumber} AND id <> ${dispatchId}
             LIMIT 1
          `);
          if (resultRows(collision).length > 0) {
            return { httpStatus: 409, message: "Trip number already exists for this loading" };
          }
          changes.tripNumber = { old: Number(previous.dispatchNumber), new: nextNumber };
        }
        if (notes !== undefined && nextNotes !== previous.notes) {
          changes.notes = { old: previous.notes ?? null, new: nextNotes ?? null };
        }
        if (Object.keys(changes).length === 0) return { trip: previous };

        const updated = await tx.execute(sql`
          UPDATE factory_loading_dispatches
             SET dispatch_number = ${nextNumber}, notes = ${nextNotes}, updated_at = NOW()
           WHERE id = ${dispatchId} AND company_id = ${scope.state.companyId}
             AND order_id = ${scope.orderId} AND status = 'OPEN'
          RETURNING id, order_id AS "orderId", dispatch_number AS "dispatchNumber",
                    status, notes, updated_at AS "updatedAt"
        `);
        const trip = resultRows(updated)[0];
        if (!trip) throw new Error("Dispatch metadata update lost concurrent status lock");
        await tx.execute(sql`
          INSERT INTO factory_loading_dispatch_events
            (company_id, order_id, dispatch_id, event_type,
             actor_user_id, actor_username, event_data)
          VALUES (${scope.state.companyId}, ${scope.orderId}, ${dispatchId},
                  'DETAILS_UPDATED', ${actorUserId}, ${actorUsername},
                  ${JSON.stringify(changes)}::jsonb)
        `);
        return { trip };
      });
      if ("httpStatus" in result && typeof result.httpStatus === "number") {
        return res.status(result.httpStatus).json({ message: result.message });
      }
      return res.json(result.trip);
    } catch (error) {
      logger.error("Error updating Factory loading dispatch metadata", { error });
      if (isUniqueViolation(error)) return res.status(409).json({ message: "Trip number already exists for this loading" });
      return res.status(500).json({ message: "Could not update dispatch details" });
    }
  });


  // "Delete Dispatch" archives a never-finalized open trip. Keep the parent
  // and append-only evidence for audit/FK integrity; release active verification
  // and expected reservations without touching the main loading or accounting.
  app.post("/api/factory/customer-orders/:id/loading-dispatches/:dispatchId/cancel",
    requireAuth, loadingAccess, async (req, res) => {
      try {
        const scope = await resolveOrder(req, res);
        if (!scope) return;
        if (!["admin", "owner", "developer"].includes(scope.state.role.trim().toLowerCase())) {
          return res.status(403).json({ message: "Only Admin, Owner or Developer may delete dispatches" });
        }
        const dispatchId = parseId(req.params.dispatchId);
        if (dispatchId === null) return res.status(400).json({ message: "Invalid dispatch ID" });
        const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
        if (reason.length < 3 || reason.length > 500) {
          return res.status(400).json({ message: "Enter a deletion reason (3–500 characters)" });
        }
        const actorUserId = String(scope.state.userId);
        const actorUsername = String(req.session.username || actorUserId);
        const companyId = scope.state.companyId;
        const orderId = scope.orderId;
        const outcome = await db.transaction(async (tx) => {
          const order = resultRows(await tx.execute(sql`
            SELECT id, status, deleted_at AS "deletedAt", invoice_number AS "invoiceNumber"
              FROM customer_orders WHERE company_id = ${companyId}
              AND id = ${orderId} FOR UPDATE
          `))[0];
          if (!order) return { status: 404, message: "Loading not found" };
          if (order.deletedAt || order.invoiceNumber ||
              !["DRAFT", "LOADING", "PENDING_VERIFICATION"].includes(String(order.status))) {
            return { status: 409, message: "This loading is already finalized or inactive" };
          }
          const trip = resultRows(await tx.execute(sql`
            SELECT id, status, dispatch_number AS "dispatchNumber"
              FROM factory_loading_dispatches
             WHERE id = ${dispatchId} AND company_id = ${companyId}
               AND order_id = ${orderId} FOR UPDATE
          `))[0];
          if (!trip) return { status: 404, message: "Dispatch not found" };
          if (trip.status !== "OPEN") {
            return { status: 409, message: "Only open, unfinalized dispatches can be deleted" };
          }
          const closed = resultRows(await tx.execute(sql`
            SELECT id FROM factory_loading_dispatch_closure_history
             WHERE company_id = ${companyId} AND order_id = ${orderId}
               AND dispatch_id = ${dispatchId} LIMIT 1
          `));
          if (closed.length) {
            return { status: 409, message: "This dispatch has signed closure history and cannot be deleted" };
          }
          // Any financial draft, posted or reversed record must be resolved
          // through the financial workflow; never orphan its accounting links.
          const schema = resultRows(await tx.execute(sql`
            SELECT to_regclass('public.factory_dispatch_trip_financials') IS NOT NULL AS installed
          `))[0];
          if (schema?.installed === true) {
            const finances = resultRows(await tx.execute(sql`
              SELECT id FROM factory_dispatch_trip_financials
               WHERE company_id = ${companyId} AND order_id = ${orderId}
                 AND dispatch_id = ${dispatchId} LIMIT 1
            `));
            if (finances.length) {
              return { status: 409, message: "This dispatch has financial records and cannot be deleted" };
            }
          }

          const removedScans = resultRows(await tx.execute(sql`
            UPDATE factory_loading_dispatch_scans
               SET removed_at = NOW(), removed_by_user_id = ${actorUserId},
                   removal_reason = ${"Dispatch deleted: " + reason}
             WHERE company_id = ${companyId} AND order_id = ${orderId}
               AND dispatch_id = ${dispatchId} AND removed_at IS NULL
             RETURNING id::text AS id
          `));
          const releasedBales = resultRows(await tx.execute(sql`
            UPDATE factory_loading_dispatch_expected_bales
               SET removed_at = NOW(), removed_by_user_id = ${actorUserId},
                   removal_reason = ${"Dispatch deleted: " + reason}
             WHERE company_id = ${companyId} AND order_id = ${orderId}
               AND dispatch_id = ${dispatchId} AND removed_at IS NULL
             RETURNING id::text AS id
          `));
          const removedTargets = resultRows(await tx.execute(sql`
            DELETE FROM factory_loading_dispatch_expected_articles
             WHERE company_id = ${companyId} AND order_id = ${orderId}
               AND dispatch_id = ${dispatchId} RETURNING id
          `));
          const updated = resultRows(await tx.execute(sql`
            UPDATE factory_loading_dispatches
               SET status = 'CANCELLED', updated_at = NOW()
             WHERE id = ${dispatchId} AND company_id = ${companyId}
               AND order_id = ${orderId} AND status = 'OPEN'
             RETURNING id
          `));
          if (!updated.length) throw new Error("Dispatch changed during cancellation");
          await tx.execute(sql`
            INSERT INTO factory_loading_dispatch_events
              (company_id, order_id, dispatch_id, event_type,
               actor_user_id, actor_username, event_data)
            VALUES (${companyId}, ${orderId}, ${dispatchId},
              'DISPATCH_CANCELLED', ${actorUserId}, ${actorUsername},
              ${JSON.stringify({ reason, dispatchNumber: Number(trip.dispatchNumber),
                removedScanIds: removedScans.map((s) => String(s.id)),
                releasedExpectedBales: releasedBales.length,
                removedArticleTargets: removedTargets.length })}::jsonb)
          `);
          return { success: true, removedScans: removedScans.length };
        });
        if ("status" in outcome && typeof outcome.status === "number") {
          return res.status(outcome.status).json({ message: outcome.message });
        }
        return res.json(outcome);
      } catch (error) {
        logger.error("Error cancelling Factory loading dispatch", { error });
        return res.status(500).json({ message: "Dispatch deletion failed; no partial changes were committed" });
      }
    }
  );

  // Phase 1 create endpoint. Serializing by order-row lock assigns unique,
  // gap-safe trip numbers even when multiple dispatchers create at once.
  app.post("/api/factory/customer-orders/:id/loading-dispatches", requireAuth, loadingAccess, async (req, res) => {
    try {
      const scope = await resolveOrder(req, res);
      if (!scope) return;
      if (["View Only", "Create Only"].includes(scope.state.role)) {
        return res.status(403).json({ message: "This Factory role cannot create truck dispatch trips" });
      }
      let requestedTripNumber: number | null;
      let notes: string | null;
      try {
        // Legacy clients can omit tripNumber and retain automatic numbering.
        requestedTripNumber = req.body?.tripNumber === undefined
          ? null
          : parseTripNumber(req.body.tripNumber);
        notes = parseOptionalText(req.body?.notes, "notes", 3000);
      } catch (error) {
        return res.status(400).json({ message: getErrorMessage(error) });
      }

      const actorUserId = String(scope.state.userId);
      const actorUsername = String(req.session.username || actorUserId);
      const created = await db.transaction(async (tx) => {
        // A row lock prevents concurrent trips from receiving the same number.
        const orderRows = await tx.execute(sql`
          SELECT id, status, container_number AS "containerNumber" FROM customer_orders
           WHERE id = ${scope.orderId} AND company_id = ${scope.state.companyId}
             AND deleted_at IS NULL
           FOR UPDATE
        `);
        const order = resultRows(orderRows)[0];
        if (!order) return { code: 404, message: "Loading not found" };
        if (!["DRAFT", "LOADING", "PENDING_VERIFICATION"].includes(String(order.status))) {
          return { code: 409, message: "Dispatch creation requires an active loading order" };
        }

        const nextRows = await tx.execute(sql`
          SELECT COALESCE(MAX(dispatch_number), 0) + 1 AS "nextNumber"
            FROM factory_loading_dispatches
           WHERE company_id = ${scope.state.companyId} AND order_id = ${scope.orderId}
        `);
        const nextNumber = requestedTripNumber ?? Number(resultRows(nextRows)[0]?.nextNumber || 1);
        const duplicateRows = await tx.execute(sql`
          SELECT id FROM factory_loading_dispatches
           WHERE company_id = ${scope.state.companyId} AND order_id = ${scope.orderId}
             AND dispatch_number = ${nextNumber}
           LIMIT 1
        `);
        if (resultRows(duplicateRows).length > 0) {
          return { code: 409, message: "Trip number already exists for this loading" };
        }
        const rows = await tx.execute(sql`
          INSERT INTO factory_loading_dispatches
            (company_id, order_id, container_number_snapshot, dispatch_number, status, notes,
             created_by_user_id, created_by_username)
          VALUES (${scope.state.companyId}, ${scope.orderId}, ${order.containerNumber ?? null}, ${nextNumber}, 'OPEN',
                  ${notes}, ${actorUserId}, ${actorUsername})
          RETURNING id, order_id AS "orderId", dispatch_number AS "dispatchNumber",
                    container_number_snapshot AS "containerNumberSnapshot",
                    status, truck_plate AS "truckPlate", driver_name AS "driverName",
                    destination, notes, created_at AS "createdAt"
        `);
        const dispatch = resultRows(rows)[0];
        if (!dispatch) throw new Error("Dispatch insert returned no record");
        await tx.execute(sql`
          INSERT INTO factory_loading_dispatch_events
            (company_id, order_id, dispatch_id, event_type,
             actor_user_id, actor_username, event_data)
          VALUES (${scope.state.companyId}, ${scope.orderId}, ${dispatch.id},
                  'CREATED', ${actorUserId}, ${actorUsername},
                  ${JSON.stringify({ dispatchNumber: nextNumber })}::jsonb)
        `);
        return { dispatch };
      });
      if ("code" in created && typeof created.code === "number") {
        return res.status(created.code).json({ message: created.message });
      }
      if (!("dispatch" in created) || !created.dispatch) {
        return res.status(500).json({ message: "Dispatch could not be created" });
      }
      return res.status(201).json(created.dispatch);
    } catch (error) {
      logger.error("Error creating Factory loading dispatch", { error });
      if (isUniqueViolation(error)) return res.status(409).json({ message: "Trip number already exists for this loading" });
      return res.status(500).json({ message: "Could not create dispatch trip" });
    }
  });
}
