/**
 * Phase 3: physical truck verification on an existing Factory loading.
 *
 * These routes write ONLY factory_loading_dispatch_scans/events. They never
 * change customer_order_bales, factory_bales, invoices, stock or accounting.
 */
import type { Express } from "express";
import { sql } from "drizzle-orm";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { parseId } from "../../../lib/parseId";
import { resultRows } from "../../../lib/queryResult";
import { logger } from "../../../lib/logger";
import { canCorrect, readContext } from "./loadingDispatchScanRoutesHelpers";
import {
  registerFactoryLoadingDispatchScanRoutesPart1,
  loadingAccess,
} from "./registerFactoryLoadingDispatchScanRoutesPart1";

export function registerFactoryLoadingDispatchScanRoutes(app: Express): void {
  registerFactoryLoadingDispatchScanRoutesPart1(app);

  // Remove many scans in one atomic, audited correction. "all" is resolved on
  // the server under the trip lock, never from a paginated browser snapshot.
  app.post(
    "/api/factory/customer-orders/:id/loading-dispatches/:dispatchId/scans/bulk-remove",
    requireAuth,
    loadingAccess,
    async (req, res) => {
      try {
        const context = await readContext(req, res);
        if (!context) return;
        const { companyId, orderId, dispatchId, role, userId, username } = context;
        if (!canCorrect(role)) {
          return res.status(403).json({ message: "Only Admin, Owner or Developer may remove dispatch scans" });
        }
        const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
        if (reason.length < 3 || reason.length > 500) {
          return res.status(400).json({ message: "Enter a correction reason (3–500 characters)" });
        }
        const all = req.body?.all === true;
        const rawIds: unknown = req.body?.scanIds;
        if (!all && (!Array.isArray(rawIds) || rawIds.length < 1 || rawIds.length > 10000)) {
          return res.status(400).json({ message: "Select between 1 and 10,000 active scans" });
        }
        if (all && rawIds !== undefined) {
          return res.status(400).json({ message: "Choose either all scans or selected scans" });
        }
        const ids = all ? [] : (rawIds as unknown[]).map((id) => String(id));
        if (ids.some((id) => !/^[1-9][0-9]{0,18}$/.test(id)) || new Set(ids).size !== ids.length) {
          return res.status(400).json({ message: "Scan IDs must be unique positive integers" });
        }

        const outcome = await db.transaction(async (tx) => {
          // Match scanner and financial posting lock order: order -> dispatch.
          const order = resultRows(
            await tx.execute(sql`
            SELECT id FROM customer_orders
             WHERE id = ${orderId} AND company_id = ${companyId} FOR UPDATE
          `)
          )[0];
          if (!order) return { status: 404, message: "Loading not found" };
          const trip = resultRows(
            await tx.execute(sql`
            SELECT id, status FROM factory_loading_dispatches
             WHERE id = ${dispatchId} AND company_id = ${companyId}
               AND order_id = ${orderId} FOR UPDATE
          `)
          )[0];
          if (!trip) return { status: 404, message: "Dispatch not found" };
          if (trip.status !== "OPEN") {
            return { status: 409, message: "Only open, non-finalized dispatches can be corrected" };
          }
          const requestedIdsJson = JSON.stringify(ids);
          const found = resultRows(
            await tx.execute(sql`
            SELECT id::text AS id, bale_id AS "baleId", bale_reference AS "baleReference"
              FROM factory_loading_dispatch_scans
             WHERE company_id = ${companyId} AND order_id = ${orderId}
               AND dispatch_id = ${dispatchId} AND removed_at IS NULL
               ${
                 all
                   ? sql``
                   : sql`AND id IN (
                 SELECT value::bigint FROM jsonb_array_elements_text(${requestedIdsJson}::jsonb)
               )`
               }
             ORDER BY id FOR UPDATE
          `)
          );
          if (!found.length) return { status: 409, message: "There are no matching active scans to remove" };
          if (!all && found.length !== ids.length) {
            return {
              status: 409,
              message: "One or more selected scans changed. Refresh and select again; nothing was removed.",
            };
          }
          const targetIds = found.map((item) => String(item.id));
          const targetJson = JSON.stringify(targetIds);
          const updated = resultRows(
            await tx.execute(sql`
            UPDATE factory_loading_dispatch_scans
               SET removed_at = NOW(), removed_by_user_id = ${userId},
                   removal_reason = ${reason}
             WHERE company_id = ${companyId} AND order_id = ${orderId}
               AND dispatch_id = ${dispatchId} AND removed_at IS NULL
               AND id IN (
                 SELECT value::bigint FROM jsonb_array_elements_text(${targetJson}::jsonb)
               )
             RETURNING id
          `)
          );
          if (updated.length !== found.length) throw new Error("Concurrent scan correction changed the batch");
          await tx.execute(sql`
            INSERT INTO factory_loading_dispatch_events
              (company_id, order_id, dispatch_id, event_type,
               actor_user_id, actor_username, event_data)
            VALUES (${companyId}, ${orderId}, ${dispatchId}, 'BALE_SCANS_BULK_REMOVED',
                    ${userId}, ${username},
                    ${JSON.stringify({
                      reason,
                      all,
                      scanIds: targetIds,
                      baleReferences: found.map((item) => String(item.baleReference)),
                    })}::jsonb)
          `);
          return { count: found.length, scanIds: targetIds };
        });
        if ("status" in outcome && typeof outcome.status === "number") {
          return res.status(outcome.status).json({ message: outcome.message });
        }
        if (!("count" in outcome) || !("scanIds" in outcome)) {
          throw new Error("Bulk correction did not return a completed batch");
        }
        return res.json({ success: true, count: outcome.count, scanIds: outcome.scanIds });
      } catch (error) {
        logger.error("Error bulk correcting truck dispatch scans", { error });
        return res.status(500).json({ message: "Bulk correction failed; no partial removal was committed" });
      }
    }
  );

  // Correction is only available to supervisors on OPEN trips. Never DELETE;
  // the original evidence and actor/reason remain in the permanent history.
  app.post(
    "/api/factory/customer-orders/:id/loading-dispatches/:dispatchId/scans/:scanId/remove",
    requireAuth,
    loadingAccess,
    async (req, res) => {
      try {
        const context = await readContext(req, res);
        if (!context) return;
        const { companyId, orderId, dispatchId, role, userId, username } = context;
        if (!canCorrect(role)) {
          return res.status(403).json({ message: "Only Admin, Owner or Developer may correct dispatch scans" });
        }
        const scanId = parseId(req.params.scanId);
        if (scanId === null) return res.status(400).json({ message: "Invalid scan ID" });
        const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
        if (reason.length < 3 || reason.length > 500) {
          return res.status(400).json({ message: "Enter a correction reason (3–500 characters)" });
        }

        const result = await db.transaction(async (tx) => {
          await tx.execute(sql`
            SELECT id FROM customer_orders WHERE company_id = ${companyId}
              AND id = ${orderId} FOR UPDATE
          `);
          const tripRows = await tx.execute(sql`
            SELECT id, status FROM factory_loading_dispatches
             WHERE id = ${dispatchId} AND company_id = ${companyId}
               AND order_id = ${orderId} FOR UPDATE
          `);
          const trip = resultRows(tripRows)[0];
          if (!trip) return { status: 404, message: "Dispatch not found" };
          if (trip.status !== "OPEN") return { status: 409, message: "Cannot correct a closed dispatch" };

          const deleted = await tx.execute(sql`
            UPDATE factory_loading_dispatch_scans
               SET removed_at = NOW(), removed_by_user_id = ${userId}, removal_reason = ${reason}
             WHERE id = ${scanId} AND company_id = ${companyId}
               AND order_id = ${orderId} AND dispatch_id = ${dispatchId}
               AND removed_at IS NULL
            RETURNING id, bale_id AS "baleId", bale_reference AS "baleReference",
                      removed_at AS "removedAt"
          `);
          const scan = resultRows(deleted)[0];
          if (!scan) return { status: 404, message: "Active scan not found for this dispatch" };

          await tx.execute(sql`
            INSERT INTO factory_loading_dispatch_events
              (company_id, order_id, dispatch_id, event_type,
               actor_user_id, actor_username, event_data)
            VALUES (${companyId}, ${orderId}, ${dispatchId}, 'BALE_SCAN_REMOVED',
                    ${userId}, ${username},
                    ${JSON.stringify({
                      scanId: String(scan.id),
                      baleId: Number(scan.baleId),
                      baleReference: String(scan.baleReference),
                      reason,
                    })}::jsonb)
          `);
          return { scan };
        });
        if ("status" in result && typeof result.status === "number") {
          return res.status(result.status).json({ message: result.message });
        }
        if (!("scan" in result) || !result.scan) {
          throw new Error("Dispatch scan correction returned no record");
        }
        return res.json({ success: true, scan: result.scan });
      } catch (error) {
        logger.error("Error correcting truck dispatch scan", { error });
        return res.status(500).json({ message: "Could not remove this dispatch verification" });
      }
    }
  );
}
