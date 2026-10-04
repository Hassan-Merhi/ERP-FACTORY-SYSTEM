import type { Express, NextFunction, Request, Response } from "express";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { requireAuth, requireNonPOS } from "../../auth";
import { db } from "../../db";
import { locations, stockItems } from "@shared/schema";
import { logAudit } from "../_helpers";
import {
  immutableRevisionPayloadHash,
  normalizeImmutableRevisionItems,
} from "../../services/immutableStockTransferRevisionInput";

const revisionSchema = z.object({
  note: z.string().optional().nullable(),
  optional: z.boolean().optional().default(false),
  items: z
    .array(
      z.object({
        stockItemId: z.coerce.number().int().positive(),
        stockItemName: z.string().min(1),
        sourceLocationId: z.coerce.number().int().positive(),
        sourceLocationName: z.string().optional().nullable(),
        originalQuantity: z.coerce.number().nonnegative(),
        newQuantity: z.coerce.number().nonnegative(),
        delta: z.coerce.number().optional(),
      })
    )
    .min(1),
});

/**
 * Drizzle's `db.execute` returns a driver result object on node-postgres and a
 * bare array on other drivers, so the row list lives in either shape. Narrowing
 * from `unknown` keeps the helper honest without an `any` escape.
 */
type QueryResultLike = { rows?: unknown } | readonly unknown[] | null | undefined;

function rows<T = Record<string, unknown>>(result: QueryResultLike): T[] {
  if (Array.isArray(result)) return [...result] as T[];
  const carried = result && typeof result === "object" ? (result as { rows?: unknown }).rows : undefined;
  if (Array.isArray(carried)) return [...carried] as T[];
  return [];
}

function firstRow<T = Record<string, unknown>>(result: QueryResultLike): T | undefined {
  return rows<T>(result)[0];
}

function closeEnough(left: number, right: number) {
  return Math.abs(left - right) <= 0.001;
}

/**
 * Pending revisions belong to the canonical immutable lifecycle, which is the
 * route that accepts POS submissions and enforces the POS source-location
 * boundary. This compatibility route is registered first, so it must skip the
 * entire route before requireNonPOS runs. A plain next() would continue into
 * requireNonPOS and incorrectly reject every POS revision with a 403.
 */
function bypassAdminCompatibilityForPendingRevision(req: Request, _res: Response, next: NextFunction) {
  if (req.body?.optional === true) return next("route");
  return next();
}

/**
 * Compatibility lane for the current admin editor, which persists the transfer
 * before posting its immutable revision snapshot. Pending/POS revisions still
 * flow through the canonical immutable lifecycle unchanged.
 *
 * If the database is still on the submitted original quantities we call next()
 * and let the canonical route perform its normal stale-baseline validation. If
 * the database already matches every submitted new quantity, we record the
 * immutable history row without incorrectly rejecting it as stale.
 */
export function registerAdminPostUpdateStockTransferRevisionRoute(app: Express) {
  app.post(
    "/api/stock-transfers/:transferId/revisions",
    requireAuth,
    bypassAdminCompatibilityForPendingRevision,
    requireNonPOS,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const companyId = req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const transferId = Number(req.params.transferId);
        if (!Number.isInteger(transferId) || transferId <= 0) {
          return res.status(400).json({ message: "Transfer ID is required" });
        }
        const actorId = String(req.user?.id ?? req.session.userId ?? "").trim();
        if (!actorId) return res.status(401).json({ message: "User session is required" });

        const parsed = revisionSchema.parse(req.body);
        const note = parsed.note?.trim() || null;
        const normalized = normalizeImmutableRevisionItems(parsed.items);
        const hash = immutableRevisionPayloadHash(normalized, note);

        const result = await db.transaction(async (tx) => {
          const transfer = firstRow(
            await tx.execute(sql`
              SELECT
                stv.id,
                stv.voucher_id,
                stv.destination_location_id,
                v.company_id,
                v.deleted_at
              FROM stock_transfer_vouchers stv
              JOIN vouchers v ON v.id = stv.voucher_id
              WHERE stv.id = ${transferId}
              FOR UPDATE OF stv, v
            `)
          );
          if (!transfer) return { mode: "not-found" as const };
          if (Number(transfer.company_id) !== companyId) return { mode: "forbidden" as const };
          if (transfer.deleted_at) return { mode: "deleted" as const };

          const sourceIds = Array.from(new Set(normalized.map((item) => item.sourceLocationId)));
          const validSources = await tx
            .select({ id: locations.id })
            .from(locations)
            .where(
              and(eq(locations.companyId, companyId), inArray(locations.id, sourceIds), isNull(locations.deletedAt))
            );
          if (validSources.length !== sourceIds.length) return { mode: "scope" as const };

          const itemIds = Array.from(new Set(normalized.map((item) => item.stockItemId)));
          const validItems = await tx
            .select({ id: stockItems.id })
            .from(stockItems)
            .where(
              and(eq(stockItems.companyId, companyId), inArray(stockItems.id, itemIds), isNull(stockItems.deletedAt))
            );
          if (validItems.length !== itemIds.length) return { mode: "scope" as const };

          const current = rows(
            await tx.execute(sql`
              SELECT stock_item_id, source_location_id, quantity
              FROM stock_transfer_items
              WHERE transfer_id = ${transferId}
              FOR UPDATE
            `)
          );

          let originalMatches = 0;
          let newMatches = 0;
          for (const item of normalized) {
            const row = current.find(
              (candidate) =>
                Number(candidate.stock_item_id) === item.stockItemId &&
                Number(candidate.source_location_id) === item.sourceLocationId
            );
            const currentQuantity = Number(row?.quantity ?? 0);
            if (closeEnough(currentQuantity, item.originalQuantity)) originalMatches += 1;
            else if (closeEnough(currentQuantity, item.newQuantity)) newMatches += 1;
            else {
              return {
                mode: "stale" as const,
                stockItemId: item.stockItemId,
                sourceLocationId: item.sourceLocationId,
                expected: item.originalQuantity,
                proposed: item.newQuantity,
                current: currentQuantity,
              };
            }
          }

          if (originalMatches === normalized.length) return { mode: "canonical" as const };
          if (newMatches !== normalized.length) return { mode: "mixed" as const };

          const maxRow = firstRow(
            await tx.execute(sql`
              SELECT COALESCE(MAX(revision_number), 0) AS max_revision
              FROM stock_transfer_revisions
              WHERE transfer_id = ${transferId}
            `)
          );
          const revisionNumber = Number(maxRow?.max_revision ?? 0) + 1;
          const created = firstRow(
            await tx.execute(sql`
              INSERT INTO stock_transfer_revisions (
                transfer_id,
                revision_number,
                note,
                optional,
                revision_date,
                created_by,
                status,
                reviewed_at,
                reviewed_by,
                payload_hash
              ) VALUES (
                ${transferId},
                ${revisionNumber},
                ${note},
                false,
                now(),
                ${actorId},
                'approved',
                now(),
                ${actorId},
                ${hash}
              )
              RETURNING id
            `)
          );
          const revisionId = Number(created?.id ?? 0);
          if (!revisionId) throw new Error("Failed to create stock transfer revision");

          for (const item of normalized) {
            await tx.execute(sql`
              INSERT INTO stock_transfer_revision_items (
                revision_id,
                stock_item_id,
                stock_item_name,
                source_location_id,
                source_location_name,
                original_quantity,
                delta,
                new_quantity
              ) VALUES (
                ${revisionId},
                ${item.stockItemId},
                ${item.stockItemName},
                ${item.sourceLocationId},
                ${item.sourceLocationName},
                ${item.originalQuantity.toFixed(3)},
                ${item.delta.toFixed(3)},
                ${item.newQuantity.toFixed(3)}
              )
            `);
          }

          return {
            mode: "created" as const,
            revisionId,
            revisionNumber,
            itemCount: normalized.length,
          };
        });

        if (result.mode === "canonical") return next();
        if (result.mode === "not-found") return res.status(404).json({ message: "Stock transfer not found" });
        if (result.mode === "forbidden")
          return res.status(403).json({ message: "Stock transfer belongs to a different company" });
        if (result.mode === "deleted")
          return res.status(400).json({ message: "Deleted stock transfers cannot be revised" });
        if (result.mode === "scope") {
          return res.status(403).json({ message: "Revision item or source location is outside the current company" });
        }
        if (result.mode === "mixed") {
          return res.status(409).json({
            message: "Transfer changed while saving the revision. Reload the transfer and try again.",
            code: "STOCK_TRANSFER_REVISION_STALE",
          });
        }
        if (result.mode === "stale") {
          return res.status(409).json({
            message: `Revision is stale for item ${result.stockItemId} at source ${result.sourceLocationId}. Expected ${result.expected} or saved value ${result.proposed}, current transfer quantity is ${result.current}.`,
            code: "STOCK_TRANSFER_REVISION_STALE",
            stockItemId: result.stockItemId,
            sourceLocationId: result.sourceLocationId,
          });
        }

        try {
          await logAudit({
            userId: actorId,
            username: req.session.username || req.user?.username || "unknown",
            companyId,
            action: "update",
            tableName: "stock_transfer_revisions",
            recordId: result.revisionId,
            recordIdentifier: `transfer-${transferId}-revision-${result.revisionNumber}`,
            changes: {
              revisionNumber: { new: result.revisionNumber },
              status: { new: "approved" },
              note: { new: note },
              itemCount: { new: result.itemCount },
              compatibilityMode: { new: "post-update-baseline" },
              items: {
                new: normalized.map((item) => ({
                  stockItemId: item.stockItemId,
                  stockItemName: item.stockItemName,
                  sourceLocationId: item.sourceLocationId,
                  sourceLocationName: item.sourceLocationName ?? null,
                  originalQuantity: item.originalQuantity,
                  newQuantity: item.newQuantity,
                  delta: item.delta,
                })),
              },
            },
          });
        } catch {
          // The revision is already committed; audit logging remains non-fatal.
        }

        return res.status(201).json({
          id: result.revisionId,
          transferId,
          revisionNumber: result.revisionNumber,
          status: "approved",
          optional: false,
        });
      } catch (error) {
        if (error instanceof z.ZodError) {
          return res.status(400).json({ message: "Invalid revision data", errors: error.issues });
        }
        return res.status(500).json({
          message: error instanceof Error ? error.message : "Failed to save stock transfer revision",
        });
      }
    }
  );
}
