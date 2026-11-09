/**
 * Phase 3: physical truck verification on an existing Factory loading.
 *
 * These routes write ONLY factory_loading_dispatch_scans/events. They never
 * change customer_order_bales, factory_bales, invoices, stock or accounting.
 */
import type { Express, Request, Response } from "express";
import { sql } from "drizzle-orm";
import { db, type DbTransaction } from "../../../db";
import { requireAuth } from "../../../auth";
import { getFactoryAccessState, requireFactoryTabAccess } from "../../../lib/factoryAccessControl";
import { parseId } from "../../../lib/parseId";
import { resultRows } from "../../../lib/queryResult";
import { logger } from "../../../lib/logger";

const loadingAccess = requireFactoryTabAccess("factory/invoicing", "hide_invoicing_loadings_tab");

function canWrite(role: string): boolean {
  return !["view only", "create only"].includes(role.trim().toLowerCase());
}
function canCorrect(role: string): boolean {
  return ["admin", "owner", "developer"].includes(role.trim().toLowerCase());
}
function validBarcode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 120 ? trimmed : null;
}

async function readContext(req: Request, res: Response) {
  const state = await getFactoryAccessState(req);
  if (!state) {
    res.status(403).json({ message: "Active Factory company access is unavailable" });
    return null;
  }
  const orderId = parseId(req.params.id);
  const dispatchId = parseId(req.params.dispatchId);
  if (orderId === null || dispatchId === null) {
    res.status(400).json({ message: "Valid order and dispatch IDs are required" });
    return null;
  }
  return { companyId: state.companyId, orderId, dispatchId, role: state.role,
    userId: String(state.userId), username: String(req.session.username || state.userId) };
}

async function readDuplicate(
  tx: DbTransaction,
  companyId: number, orderId: number, baleId: number
) {
  const rows = await tx.execute(sql`
    SELECT s.id, s.bale_reference AS "baleReference",
           s.scanned_by_username AS "scannedByUsername",
           s.scanned_at AS "scannedAt",
           d.id AS "dispatchId", d.dispatch_number AS "dispatchNumber"
      FROM factory_loading_dispatch_scans s
      JOIN factory_loading_dispatches d ON d.id = s.dispatch_id
       AND d.company_id = s.company_id AND d.order_id = s.order_id
     WHERE s.company_id = ${companyId} AND s.order_id = ${orderId}
       AND s.bale_id = ${baleId} AND s.removed_at IS NULL
     LIMIT 1
  `);
  return resultRows(rows)[0] ?? null;
}

export function registerFactoryLoadingDispatchScanRoutes(app: Express): void {
  // All active and corrected scan records are retained; removedAt distinguishes
  // an active verification from an operator-corrected historical scan.
  app.get("/api/factory/customer-orders/:id/loading-dispatches/:dispatchId/scans",
    requireAuth, loadingAccess, async (req, res) => {
      try {
        const context = await readContext(req, res);
        if (!context) return;
        const { companyId, orderId, dispatchId } = context;
        const result = await db.execute(sql`
          SELECT id, status FROM factory_loading_dispatches
           WHERE id = ${dispatchId} AND company_id = ${companyId}
             AND order_id = ${orderId} LIMIT 1
        `);
        const trip = resultRows(result)[0];
        if (!trip) return res.status(404).json({ message: "Dispatch not found for this loading" });

        const scans = await db.execute(sql`
          SELECT s.id, s.dispatch_id AS "dispatchId", s.order_id AS "orderId",
                 s.bale_id AS "baleId", s.bale_reference AS "baleReference",
                 s.article_code AS "articleCode", s.product_name AS "productName",
                 s.weight_kg AS "weightKg", s.scanned_by_user_id AS "scannedByUserId",
                 s.scanned_by_username AS "scannedByUsername", s.scanned_at AS "scannedAt",
                 s.removed_at AS "removedAt", s.removed_by_user_id AS "removedByUserId",
                 s.removal_reason AS "removalReason",
                 EXISTS (
                   SELECT 1 FROM customer_order_bales cob
                   WHERE cob.order_id = s.order_id AND cob.bale_id = s.bale_id
                 ) AS "stillInLoading"
            FROM factory_loading_dispatch_scans s
           WHERE s.dispatch_id = ${dispatchId} AND s.company_id = ${companyId}
             AND s.order_id = ${orderId}
           ORDER BY s.scanned_at DESC, s.id DESC
        `);
        const rows = resultRows(scans);
        const active = rows.filter((row) => row.removedAt == null);
        return res.json({
          dispatchId, orderId, status: trip.status,
          activeCount: active.length,
          activeWeightKg: active.reduce((total, row) => total + Number(row.weightKg || 0), 0),
          scans: rows,
        });
      } catch (error) {
        logger.error("Error loading truck dispatch scans", { error });
        return res.status(500).json({ message: "Unable to load truck scan history" });
      }
    }
  );

  app.post("/api/factory/customer-orders/:id/loading-dispatches/:dispatchId/scans",
    requireAuth, loadingAccess, async (req, res) => {
      try {
        const context = await readContext(req, res);
        if (!context) return;
        const { companyId, orderId, dispatchId, role, userId, username } = context;
        if (!canWrite(role)) return res.status(403).json({ message: "This role cannot scan dispatch bales" });

        const scanCode = validBarcode(req.body?.scanCode);
        if (!scanCode) return res.status(400).json({ code: "INVALID_BARCODE", message: "Scan one bale reference or barcode (up to 120 characters)" });

        const result = await db.transaction(async (tx) => {
          // Lock the parent order before the trip, matching trip plan writes.
          await tx.execute(sql`
            SELECT id FROM customer_orders WHERE company_id = ${companyId}
              AND id = ${orderId} FOR UPDATE
          `);
          const tripRows = await tx.execute(sql`
            SELECT d.id, d.status, co.status AS "loadingStatus", co.deleted_at AS "loadingDeletedAt"
              FROM factory_loading_dispatches d
              JOIN customer_orders co ON co.id = d.order_id AND co.company_id = d.company_id
             WHERE d.id = ${dispatchId} AND d.order_id = ${orderId}
               AND d.company_id = ${companyId} FOR UPDATE OF d
          `);
          const trip = resultRows(tripRows)[0];
          if (!trip) return { status: 404, code: "DISPATCH_NOT_FOUND", message: "Dispatch not found for this loading" };
          if (trip.status !== "OPEN") return { status: 409, code: "DISPATCH_NOT_OPEN", message: "This dispatch is closed. Open a different active trip." };
          if (trip.loadingDeletedAt || trip.loadingStatus === "CANCELLED") {
            return { status: 409, code: "LOADING_INACTIVE", message: "This loading is cancelled or deleted and cannot be verified" };
          }

          // Never search by article or name: physical verification requires a
          // single exact bale barcode from the selected order's loaded bales.
          const candidateRows = await tx.execute(sql`
            SELECT DISTINCT ON (cob.bale_id)
                   cob.bale_id AS "baleId", cob.bale_reference AS "baleReference",
                   cob.article_code AS "articleCode", cob.bale_name AS "productName",
                   cob.weight AS "weightKg"
              FROM customer_order_bales cob
              JOIN factory_bales fb ON fb.id = cob.bale_id AND fb.company_id = ${companyId}
             WHERE cob.order_id = ${orderId}
               AND (
                 LOWER(TRIM(cob.bale_reference)) = LOWER(${scanCode})
                 OR LOWER(TRIM(fb.reference_number)) = LOWER(${scanCode})
                 OR LOWER(TRIM(fb.bale_code)) = LOWER(${scanCode})
               )
             ORDER BY cob.bale_id, cob.id DESC
             LIMIT 2
          `);
          const candidates = resultRows(candidateRows);
          if (candidates.length === 0) {
            return {
              status: 422, code: "DISPATCH_NOT_IN_LOADING",
              message: "Bale " + scanCode + " is not in this loading. Check the truck or scan it into the main loading first.",
            };
          }
          if (candidates.length !== 1) {
            return { status: 422, code: "DISPATCH_AMBIGUOUS_BARCODE",
              message: "Barcode matches more than one loaded bale. Scan the unique bale reference." };
          }
          const bale = candidates[0];
          const existing = await readDuplicate(tx, companyId, orderId, Number(bale.baleId));
          if (existing) {
            return {
              status: 409, code: "DISPATCH_DUPLICATE",
              message: "Already verified on Dispatch #" + existing.dispatchNumber + " by " + existing.scannedByUsername,
              previous: existing,
            };
          }

          // Flag exact bales allocated to a different truck while preserving
          // their actual physical verification for the Compare discrepancy.
          const otherPlanRows = await tx.execute(sql`
            SELECT d.dispatch_number AS "expectedDispatchNumber", d.id AS "expectedDispatchId"
              FROM factory_loading_dispatch_expected_bales e
              JOIN factory_loading_dispatches d ON d.id = e.dispatch_id
                AND d.company_id = e.company_id AND d.order_id = e.order_id
             WHERE e.company_id = ${companyId} AND e.order_id = ${orderId}
               AND e.bale_id = ${bale.baleId} AND e.removed_at IS NULL
               AND e.dispatch_id <> ${dispatchId} LIMIT 1
          `);
          const assignedOther = resultRows(otherPlanRows)[0] ?? null;

          // DO NOTHING handles a race with a different open dispatch. This
          // prevents a failed insert from aborting the surrounding PG tx.
          const inserted = await tx.execute(sql`
            INSERT INTO factory_loading_dispatch_scans
              (company_id, order_id, dispatch_id, bale_id, bale_reference,
               article_code, product_name, weight_kg, scanned_by_user_id, scanned_by_username)
            VALUES (${companyId}, ${orderId}, ${dispatchId}, ${bale.baleId}, ${bale.baleReference},
                    ${bale.articleCode}, ${bale.productName}, ${bale.weightKg}, ${userId}, ${username})
            ON CONFLICT DO NOTHING
            RETURNING id, bale_id AS "baleId", bale_reference AS "baleReference",
                      article_code AS "articleCode", product_name AS "productName",
                      weight_kg AS "weightKg", scanned_at AS "scannedAt",
                      scanned_by_username AS "scannedByUsername"
          `);
          const scan = resultRows(inserted)[0];
          if (!scan) {
            const winner = await readDuplicate(tx, companyId, orderId, Number(bale.baleId));
            return {
              status: 409, code: "DISPATCH_DUPLICATE",
              message: winner
                ? "Already verified on Dispatch #" + winner.dispatchNumber + " by " + winner.scannedByUsername
                : "Bale is already recorded in another dispatch",
              previous: winner,
            };
          }

          await tx.execute(sql`
            INSERT INTO factory_loading_dispatch_events
              (company_id, order_id, dispatch_id, event_type,
               actor_user_id, actor_username, event_data)
            VALUES (${companyId}, ${orderId}, ${dispatchId}, 'BALE_SCANNED',
                    ${userId}, ${username},
                    jsonb_build_object('scanId', ${scan.id}, 'baleId', ${bale.baleId},
                                       'baleReference', ${bale.baleReference}))
          `);
          if (assignedOther) {
            await tx.execute(sql`
              INSERT INTO factory_loading_dispatch_events
                (company_id, order_id, dispatch_id, event_type, actor_user_id,
                 actor_username, event_data)
              VALUES (${companyId}, ${orderId}, ${dispatchId},
                'WRONG_TRIP_BALE_VERIFIED', ${userId}, ${username},
                jsonb_build_object('baleId', ${bale.baleId},
                  'expectedDispatchId', ${assignedOther.expectedDispatchId},
                  'expectedDispatchNumber', ${assignedOther.expectedDispatchNumber}))
            `);
          }
          return { scan, assignedOther };
        });
        if ("status" in result && typeof result.status === "number") {
          return res.status(result.status).json({
            code: result.code, message: result.message,
            previous: "previous" in result ? result.previous : undefined,
          });
        }
        if (!("scan" in result) || !result.scan) throw new Error("Scan insert returned no row");
        return res.status(201).json({
          ...result.scan, status: result.assignedOther ? "REVIEW_REQUIRED" : "VERIFIED",
          ...(result.assignedOther ? {
            warningMessage: "Bale verified on this truck but allocated to Dispatch #" +
              result.assignedOther.expectedDispatchNumber + ". Check comparison.",
            expectedDispatchNumber: result.assignedOther.expectedDispatchNumber,
          } : {}),
        });
      } catch (error) {
        logger.error("Error recording truck dispatch verification scan", { error });
        return res.status(500).json({ message: "Could not verify bale. Please retry; no stock was changed." });
      }
    }
  );

  // Correction is only available to supervisors on OPEN trips. Never DELETE;
  // the original evidence and actor/reason remain in the permanent history.
  app.post("/api/factory/customer-orders/:id/loading-dispatches/:dispatchId/scans/:scanId/remove",
    requireAuth, loadingAccess, async (req, res) => {
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
                    jsonb_build_object('scanId', ${scan.id}, 'baleId', ${scan.baleId},
                                       'baleReference', ${scan.baleReference}, 'reason', ${reason}))
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
