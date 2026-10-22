import { toMoney } from "../../../lib/money";
import { normalizeSearchText } from "@shared/searchNormalization";
/**
 * factoryBalesRoutes: BalesCrud endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { parseId } from "../../../lib/parseId";
import { db } from "../../../db";
import { requireAuth, requireRole } from "../../../auth";
import { writeAuditEvent } from "../../../services/audit/auditService";
import { recordFactoryStockValueEventTx } from "../../../services/factory/factoryStockValueEvents";
import { adjustInventory } from "../../../inventoryHelper";
import { companyBusinessDate } from "../../../services/accounting/companyBusinessDate";
import { createDatabaseStockMovementAdapter } from "../../../services/inventory/databaseStockMovementAdapter";
import { postStockMovementTx } from "../../../services/inventory/stockMovementIntegrityService";
import { canonicalStockMovements } from "../../../services/inventory/canonicalStockMovementTables";
import { writeDaybookEntry } from "../_helpers";
import {
  BaleStatusChangeRefusal,
  FACTORY_BALE_STATUS_CHANGES_VALUE_MESSAGE,
  isValueNeutralBaleStatusChange,
} from "../../../services/factory/baleStatusPolicy";

import {
  factoryBaleProducts,
  factoryMixBatches,
  factoryBales,
  baleLabelPrints,
  customerOrderBales,
  factoryBaleProductionAttributions,
  factoryPhysicalBaleDeletions,
  customerOrders,
  stockItems,
} from "@shared/schema";
import { eq, and, desc, sql, inArray, not, isNull } from "drizzle-orm";
import {
  ALLOWED,
  assertNoLiveLoadingLinkOutsideLoadingStatusTx,
  assertNotOnFinalizedOrderTx,
  baleWriteErrorResponse,
  deletePreStockBalesTx,
  lockPriorityScanQueueTx,
} from "./baleStatusWriteGuards";
import { registerBalesMaintenanceRoutes } from "./balesMaintenanceRoutes";

export function registerBalesCrudRoutes(app: Express) {
  app.get("/api/factory/bales", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const {
        status,
        mixBatchId,
        pressingBatchId,
        locationId,
        productId,
        limit: limitQ,
        offset: offsetQ,
        date,
        lite: liteQ,
        page: pageQ,
        search,
      } = req.query;
      const lite = liteQ === "1";

      // Default 100 rows, hard cap 250 — keeps responses under ~200 KB.
      // Use ?page=N for cursor-style pagination; ?limit overrides per-page size (capped at 250).
      const rowLimit = Math.min(Number(limitQ) || 100, 250);
      const page = pageQ !== undefined ? Math.max(1, Number(pageQ) || 1) : null;
      const rowOffset = page !== null ? (page - 1) * rowLimit : Math.max(Number(offsetQ) || 0, 0);

      const conditions = [
        eq(factoryBales.companyId, companyId),
        // Always exclude deleted/removed bales from the history view
        not(inArray(factoryBales.status, ["DELETED", "REMOVED"])),
      ];

      if (status) conditions.push(eq(factoryBales.status, status as string));
      if (mixBatchId) conditions.push(eq(factoryBales.mixBatchId, parseInt(mixBatchId as string)));
      if (pressingBatchId) conditions.push(eq(factoryBales.pressingBatchId, parseInt(pressingBatchId as string)));
      if (locationId) conditions.push(eq(factoryBales.erpLocationId, parseInt(locationId as string)));
      if (productId) conditions.push(eq(factoryBales.productId, parseInt(productId as string)));

      const normalizedSearch = typeof search === "string" ? search.trim() : "";

      // Date filter: match against stockEntryDate first (set on all stock-entry/waste-dispatch bales),
      // falling back to the date portion of createdAt for pressing-batch bales. Text/reference
      // searches intentionally span all dates so an exact bale can never be hidden by the day picker.
      if (!normalizedSearch && date && typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
        conditions.push(sql`COALESCE(${factoryBales.stockEntryDate}, ${factoryBales.createdAt}::date) = ${date}::date`);
      }

      // Server-side text search: bale code, article code, product name, reference number.
      if (normalizedSearch) {
        const raw = normalizedSearch;
        const q = `%${raw}%`;
        const compact = `%${normalizeSearchText(raw)}%`;
        conditions.push(
          sql`(
            ${factoryBales.baleCode} ILIKE ${q}
            OR ${factoryBales.articleCode} ILIKE ${q}
            OR ${factoryBales.productName} ILIKE ${q}
            OR ${factoryBales.referenceNumber} ILIKE ${q}
            OR regexp_replace(lower(coalesce(${factoryBales.baleCode}::text, '')), '[^[:alnum:]]+', '', 'g') LIKE ${compact}
            OR regexp_replace(lower(coalesce(${factoryBales.articleCode}::text, '')), '[^[:alnum:]]+', '', 'g') LIKE ${compact}
            OR regexp_replace(lower(coalesce(${factoryBales.productName}::text, '')), '[^[:alnum:]]+', '', 'g') LIKE ${compact}
            OR regexp_replace(lower(coalesce(${factoryBales.referenceNumber}::text, '')), '[^[:alnum:]]+', '', 'g') LIKE ${compact}
          )`
        );
      }

      // Run data and count queries in parallel; skip count when not paginating.
      const [bales, countResult] = await Promise.all([
        db
          .select()
          .from(factoryBales)
          .where(and(...conditions))
          .orderBy(desc(factoryBales.createdAt))
          .limit(rowLimit)
          .offset(rowOffset),
        page !== null
          ? db
              .select({ count: sql<string>`COUNT(*)::text` })
              .from(factoryBales)
              .where(and(...conditions))
          : Promise.resolve(null as null),
      ]);

      const productIds: number[] = Array.from(
        new Set(bales.map((b) => b.productId).filter((id): id is number => id !== null))
      );
      const batchIds: number[] = Array.from(
        new Set(bales.map((b) => b.mixBatchId).filter((id): id is number => id !== null))
      );

      const products =
        productIds.length > 0
          ? lite
            ? await db
                .select({
                  id: factoryBaleProducts.id,
                  name: factoryBaleProducts.name,
                  articleCode: factoryBaleProducts.articleCode,
                })
                .from(factoryBaleProducts)
                .where(inArray(factoryBaleProducts.id, productIds))
            : await db.select().from(factoryBaleProducts).where(inArray(factoryBaleProducts.id, productIds))
          : [];
      const batches =
        batchIds.length > 0
          ? lite
            ? await db
                .select({
                  id: factoryMixBatches.id,
                  batchCode: factoryMixBatches.batchCode,
                  name: factoryMixBatches.name,
                })
                .from(factoryMixBatches)
                .where(inArray(factoryMixBatches.id, batchIds))
            : await db.select().from(factoryMixBatches).where(inArray(factoryMixBatches.id, batchIds))
          : [];

      const productMap = new Map(products.map((p) => [p.id, p]));
      const batchMap = new Map(batches.map((b) => [b.id, b]));

      const baleIds = bales.map((b) => b.id).filter(Boolean);
      const lastPrintMap = new Map<number, string>();
      // In lite mode skip the print-history lookup; in full mode guard against huge IN-clauses.
      if (!lite && baleIds.length > 0 && baleIds.length <= 500) {
        const printRows = await db
          .select({
            productionBaleId: baleLabelPrints.productionBaleId,
            lastPrintedAt: sql<string>`MAX(${baleLabelPrints.printedAt})::timestamptz`.as("last_printed_at"),
          })
          .from(baleLabelPrints)
          .where(inArray(baleLabelPrints.productionBaleId, baleIds))
          .groupBy(baleLabelPrints.productionBaleId);
        for (const row of printRows) {
          if (row.productionBaleId) lastPrintMap.set(row.productionBaleId, row.lastPrintedAt);
        }
      }

      const results = bales.map((bale) => ({
        bale,
        product: bale.productId ? productMap.get(bale.productId) || null : null,
        mixBatch: bale.mixBatchId ? batchMap.get(bale.mixBatchId) || null : null,
        lastPrintedAt: lastPrintMap.get(bale.id) || null,
      }));

      // Paginated response when ?page= is given; legacy array shape for backward-compat callers.
      if (page !== null && countResult) {
        const total = Number(countResult[0]?.count ?? 0);
        const totalPages = Math.max(1, Math.ceil(total / rowLimit));
        res.set("Cache-Control", "private, max-age=60");
        res.json({ items: results, total, page, limit: rowLimit, totalPages });
      } else {
        res.json(results);
      }
    } catch (error: unknown) {
      logger.error("Error fetching factory bales:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Phase 19 C (F3): Admin/Owner; only value-neutral changes (baleStatusPolicy:
  // within finished goods, or within the pre-stock statuses); any other bale in
  // the set refuses the whole change (409, nothing written). One transaction
  // with one audit row per bale changed. DELETED (main #2134) deletes pre-stock
  // bales through the physical-deletion service; REMOVED and any revival of a
  // deleted bale are refused by the policy.
  app.patch(
    "/api/factory/bales/bulk-status",
    requireAuth,
    requireRole("Admin", "Owner"),
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        const { ids, status } = req.body;
        if (!Array.isArray(ids) || ids.length === 0)
          return res.status(400).json({ message: "ids must be a non-empty array" });
        if (!status || typeof status !== "string") return res.status(400).json({ message: "status is required" });
        if (!(ALLOWED as readonly string[]).includes(status))
          return res.status(400).json({ message: `Invalid status. Allowed: ${ALLOWED.join(", ")}` });
        const baleIds = [...new Set(ids.map(Number))];
        if (baleIds.some((id) => !Number.isInteger(id) || id <= 0))
          return res.status(400).json({ message: "ids must be bale ids" });
        if (baleIds.length > 200) return res.status(400).json({ message: "Provide 1–200 unique physical bale IDs" });

        const updated = await db.transaction(async (tx) => {
          await lockPriorityScanQueueTx(tx, companyId);
          if (status === "DELETED") {
            const removed = await deletePreStockBalesTx(
              tx,
              req,
              companyId,
              baleIds,
              "Physical bales deleted via bulk status change"
            );
            return removed.length;
          }
          const bales = await tx
            .select({
              id: factoryBales.id,
              status: factoryBales.status,
              deletedAt: factoryBales.deletedAt,
              referenceNumber: factoryBales.referenceNumber,
            })
            .from(factoryBales)
            .where(and(eq(factoryBales.companyId, companyId), inArray(factoryBales.id, baleIds)))
            .for("update");
          const refused = bales
            .filter((bale) => !isValueNeutralBaleStatusChange(bale.status, status, bale.deletedAt))
            .map((bale) => ({ id: bale.id, from: bale.status, to: status }));
          if (refused.length > 0) throw new BaleStatusChangeRefusal(FACTORY_BALE_STATUS_CHANGES_VALUE_MESSAGE, refused);
          await assertNotOnFinalizedOrderTx(
            tx,
            companyId,
            status,
            bales.map((bale) => bale.id)
          );
          await assertNoLiveLoadingLinkOutsideLoadingStatusTx(
            tx,
            companyId,
            bales.map((bale) => bale.id),
            status
          );
          const changed = bales.filter((bale) => bale.status !== status);
          if (changed.length === 0) return 0;
          const now = new Date();
          await tx
            .update(factoryBales)
            .set({ status, updatedAt: now })
            .where(
              and(
                eq(factoryBales.companyId, companyId),
                inArray(
                  factoryBales.id,
                  changed.map((bale) => bale.id)
                )
              )
            );
          for (const bale of changed) {
            await writeAuditEvent(
              {
                userId: String(req.session.userId ?? "unknown"),
                username: req.session.username || String(req.session.userId ?? "unknown"),
                companyId,
                action: "update",
                tableName: "factory_bales",
                recordId: bale.id,
                recordIdentifier: bale.referenceNumber || `Bale #${bale.id}`,
                changes: { status: { old: bale.status, new: status }, source: { new: "bulk-status" } },
              },
              tx
            );
          }
          return changed.length;
        });

        res.json({ updated });
      } catch (error: unknown) {
        baleWriteErrorResponse(res, error);
      }
    }
  );

  // PATCH /api/factory/bales/bulk-date — update stock_entry_date for a set of bales
  app.patch("/api/factory/bales/bulk-date", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const { ids, stockEntryDate } = req.body;
      if (!Array.isArray(ids) || ids.length === 0)
        return res.status(400).json({ message: "ids must be a non-empty array" });
      if (!stockEntryDate || typeof stockEntryDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(stockEntryDate))
        return res.status(400).json({ message: "stockEntryDate must be YYYY-MM-DD" });

      const now = new Date();
      const result = await db.transaction(async (tx) => {
        const updatedBales = await tx
          .update(factoryBales)
          .set({ stockEntryDate, updatedAt: now })
          .where(and(eq(factoryBales.companyId, companyId), inArray(factoryBales.id, ids.map(Number))))
          .returning({ id: factoryBales.id });

        const updatedIds = updatedBales.map((bale) => bale.id);
        if (updatedIds.length > 0) {
          await tx
            .update(factoryBaleProductionAttributions)
            .set({ stockEntryDate })
            .where(
              and(
                eq(factoryBaleProductionAttributions.companyId, companyId),
                inArray(factoryBaleProductionAttributions.baleId, updatedIds)
              )
            );
        }

        return updatedBales;
      });

      res.json({ updated: result.length });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Phase 19 C (F3): Admin/Owner; only a value-neutral change (baleStatusPolicy),
  // otherwise 409 pointing to the sale, removal and pressing flows. The change
  // and its audit row commit together. DELETED deletes a pre-stock bale through
  // the physical-deletion service (main #2134), as DELETE does.
  app.patch(
    "/api/factory/bales/:id/status",
    requireAuth,
    requireRole("Admin", "Owner"),
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        const id = parseId(req.params.id);
        if (id === null) return res.status(400).json({ message: "Invalid id" });

        const { status } = req.body;
        if (!status || typeof status !== "string") return res.status(400).json({ message: "status is required" });
        if (!(ALLOWED as readonly string[]).includes(status))
          return res.status(400).json({ message: `Invalid status. Allowed: ${ALLOWED.join(", ")}` });

        const updated = await db.transaction(async (tx) => {
          await lockPriorityScanQueueTx(tx, companyId);
          if (status === "DELETED") {
            await deletePreStockBalesTx(tx, req, companyId, [id], "Physical bale deleted via status change");
            return { id, status: "DELETED" };
          }
          const [bale] = await tx
            .select({
              id: factoryBales.id,
              status: factoryBales.status,
              deletedAt: factoryBales.deletedAt,
              referenceNumber: factoryBales.referenceNumber,
              totalCost: factoryBales.totalCost,
              erpLocationId: factoryBales.erpLocationId,
            })
            .from(factoryBales)
            .where(and(eq(factoryBales.id, id), eq(factoryBales.companyId, companyId)))
            .for("update");
          if (!bale) return null;
          // Legacy status-only deletions never posted an ERP stock debit. Restore
          // those bales without a SECOND receipt. This is intentionally not an
          // exception to the generic value-neutral status policy: the branch
          // verifies that no controlled physical removal took place, and keeps
          // its own stock-value reversal and audit inside the same transaction.
          if (status === "IN_STOCK" && bale.status === "DELETED") {
            const [physicalDeletion] = await tx
              .select({ id: factoryPhysicalBaleDeletions.id })
              .from(factoryPhysicalBaleDeletions)
              .where(
                and(eq(factoryPhysicalBaleDeletions.companyId, companyId), eq(factoryPhysicalBaleDeletions.baleId, id))
              )
              .limit(1);
            const removalMovement = await tx.execute(sql`
              SELECT id FROM canonical_stock_movements
               WHERE company_id = ${companyId}
                 AND source_type = 'factory_bale_removal'
                 AND source_id = ${String(id)}
               LIMIT 1
            `);
            if (physicalDeletion || removalMovement.rows.length) {
              throw new BaleStatusChangeRefusal(
                "This bale was physically removed from inventory. Restore it through a supervised stock re-entry, not a status change.",
                [{ id, from: bale.status, to: status }]
              );
            }
            // An unlocated bale cannot be reconciled to its existing ERP stock.
            if (!bale.erpLocationId) {
              throw new BaleStatusChangeRefusal(
                "This deleted bale has no stock location. Reconcile its original stock entry before restoring it.",
                [{ id, from: bale.status, to: status }]
              );
            }
            const [activeOrder] = await tx
              .select({ id: customerOrderBales.id })
              .from(customerOrderBales)
              .innerJoin(customerOrders, eq(customerOrderBales.orderId, customerOrders.id))
              .where(
                and(
                  eq(customerOrderBales.baleId, id),
                  eq(customerOrders.companyId, companyId),
                  isNull(customerOrders.deletedAt),
                  not(inArray(customerOrders.status, ["CANCELLED"]))
                )
              )
              .limit(1);
            if (activeOrder) {
              throw new BaleStatusChangeRefusal(
                "This deleted bale is linked to an active customer order. Resolve the order before restoring the bale.",
                [{ id, from: bale.status, to: status }]
              );
            }
            const [restored] = await tx
              .update(factoryBales)
              .set({ status: "IN_STOCK", deletedAt: null, updatedAt: new Date() })
              .where(
                and(eq(factoryBales.id, id), eq(factoryBales.companyId, companyId), eq(factoryBales.status, "DELETED"))
              )
              .returning({ id: factoryBales.id, status: factoryBales.status });
            if (!restored) return null;
            // Finished-goods value reappears; the ERP location inventory was
            // never debited and MUST NOT receive another quantity movement.
            await recordFactoryStockValueEventTx(tx, {
              companyId,
              kind: "WASTE",
              amount: toMoney(bale.totalCost ?? 0),
              sourceType: "factory-bale-legacy-status-restore",
              sourceId: id,
            });
            await writeAuditEvent(
              {
                userId: String(req.session.userId ?? "unknown"),
                username: req.session.username || String(req.session.userId ?? "unknown"),
                companyId,
                action: "update",
                tableName: "factory_bales",
                recordId: id,
                recordIdentifier: bale.referenceNumber || `Bale #${id}`,
                changes: {
                  status: { old: "DELETED", new: "IN_STOCK" },
                  deletedAt: { old: bale.deletedAt, new: null },
                  source: { new: "legacy-status-only-restore; ERP inventory unchanged" },
                },
              },
              tx
            );
            return restored;
          }
          if (!isValueNeutralBaleStatusChange(bale.status, status, bale.deletedAt)) {
            throw new BaleStatusChangeRefusal(FACTORY_BALE_STATUS_CHANGES_VALUE_MESSAGE, [
              { id, from: bale.status, to: status },
            ]);
          }
          await assertNotOnFinalizedOrderTx(tx, companyId, status, [id]);
          await assertNoLiveLoadingLinkOutsideLoadingStatusTx(tx, companyId, [id], status);
          if (bale.status === status) return { id, status };
          const [row] = await tx
            .update(factoryBales)
            .set({ status, updatedAt: new Date() })
            .where(and(eq(factoryBales.id, id), eq(factoryBales.companyId, companyId)))
            .returning({ id: factoryBales.id, status: factoryBales.status });
          await writeAuditEvent(
            {
              userId: String(req.session.userId ?? "unknown"),
              username: req.session.username || String(req.session.userId ?? "unknown"),
              companyId,
              action: "update",
              tableName: "factory_bales",
              recordId: id,
              recordIdentifier: bale.referenceNumber || `Bale #${id}`,
              changes: { status: { old: bale.status, new: status } },
            },
            tx
          );
          return row;
        });

        if (!updated) return res.status(404).json({ message: "Bale not found" });
        res.json(updated);
      } catch (error: unknown) {
        baleWriteErrorResponse(res, error);
      }
    }
  );

  /**
   * Physically removed bales cannot be revived through PATCH /status: that
   * changes a factory stock count without reversing the actual ERP debit.
   * This supervised route restores one physical bale and its original canonical
   * removal movement atomically. The original deletion evidence stays immutable.
   */
  app.post(
    "/api/factory/bales/:id/restore-to-stock",
    requireAuth,
    requireRole("Admin", "Owner"),
    async (req: Request, res: Response) => {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const id = parseId(req.params.id);
      if (id === null) return res.status(400).json({ message: "Invalid bale id" });
      const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
      if (!reason || reason.length > 500) {
        return res.status(400).json({ message: "A restoration reason of up to 500 characters is required" });
      }
      const actorId = req.session.userId == null ? null : String(req.session.userId);
      const actorName = req.session.username || actorId || "unknown";
      try {
        const result = await db.transaction(async (tx) => {
          await lockPriorityScanQueueTx(tx, companyId);
          const [bale] = await tx
            .select()
            .from(factoryBales)
            .where(and(eq(factoryBales.id, id), eq(factoryBales.companyId, companyId)))
            .for("update");
          if (!bale) return { outcome: "missing" as const };
          if (bale.status !== "DELETED" || !bale.deletedAt) {
            throw new BaleStatusChangeRefusal("Only a deleted bale can be restored to stock.", [
              { id, from: bale.status, to: "IN_STOCK" },
            ]);
          }

          const [physicalDeletion] = await tx
            .select()
            .from(factoryPhysicalBaleDeletions)
            .where(
              and(eq(factoryPhysicalBaleDeletions.companyId, companyId), eq(factoryPhysicalBaleDeletions.baleId, id))
            )
            .limit(1);
          if (!physicalDeletion) {
            // The existing PATCH /status endpoint handles historic status-only
            // deletions and must NOT create a new ERP receipt.
            return { outcome: "legacy" as const };
          }

          const locationId = physicalDeletion.originalLocationId;
          if (
            !locationId ||
            bale.erpLocationId !== locationId ||
            !["IN_STOCK", "RESERVED_FOR_ORDER"].includes(physicalDeletion.previousStatus)
          ) {
            throw new BaleStatusChangeRefusal(
              "Original inventory location or stock status cannot be verified. Reconcile this bale before re-entry.",
              [{ id, from: bale.status, to: "IN_STOCK" }]
            );
          }
          await assertNotOnFinalizedOrderTx(tx, companyId, "IN_STOCK", [id]);
          await assertNoLiveLoadingLinkOutsideLoadingStatusTx(tx, companyId, [id], "IN_STOCK");
          const [activeOrder] = await tx
            .select({ id: customerOrderBales.id })
            .from(customerOrderBales)
            .innerJoin(customerOrders, eq(customerOrderBales.orderId, customerOrders.id))
            .where(
              and(
                eq(customerOrderBales.baleId, id),
                eq(customerOrders.companyId, companyId),
                isNull(customerOrders.deletedAt),
                not(inArray(customerOrders.status, ["CANCELLED"]))
              )
            )
            .limit(1);
          if (activeOrder) {
            throw new BaleStatusChangeRefusal("Remove the bale from its active customer order before restoring it.", [
              { id, from: bale.status, to: "IN_STOCK" },
            ]);
          }

          const removals = await tx
            .select()
            .from(canonicalStockMovements)
            .where(
              and(
                eq(canonicalStockMovements.companyId, companyId),
                eq(canonicalStockMovements.sourceType, "factory_bale_removal"),
                eq(canonicalStockMovements.sourceId, String(id))
              )
            )
            .for("update");
          if (
            removals.length !== 1 ||
            Number(removals[0].quantityDelta) !== -1 ||
            removals[0].locationId !== locationId ||
            removals[0].reversalOfMovementId
          ) {
            throw new BaleStatusChangeRefusal(
              "The original stock debit is missing or inconsistent. Reconcile inventory before restoring this bale.",
              [{ id, from: bale.status, to: "IN_STOCK" }]
            );
          }
          const original = removals[0];
          const [previousReversal] = await tx
            .select({ id: canonicalStockMovements.id })
            .from(canonicalStockMovements)
            .where(
              and(
                eq(canonicalStockMovements.companyId, companyId),
                eq(canonicalStockMovements.reversalOfMovementId, original.id)
              )
            )
            .limit(1);
          if (previousReversal) {
            throw new BaleStatusChangeRefusal(
              "The original stock removal was already reversed. Check the stock movement ledger.",
              [{ id, from: bale.status, to: "IN_STOCK" }]
            );
          }
          // A product change after deletion must not restore the old SKU while
          // advertising the bale under a different product in factory stock.
          const [product] = bale.productId
            ? await tx
                .select({ articleCode: factoryBaleProducts.articleCode, code: factoryBaleProducts.code })
                .from(factoryBaleProducts)
                .where(and(eq(factoryBaleProducts.companyId, companyId), eq(factoryBaleProducts.id, bale.productId)))
                .limit(1)
            : [];
          const currentCode = bale.productId
            ? product?.articleCode || product?.code
            : bale.articleCode || bale.baleCode;
          const [stockItem] = await tx
            .select({ code: stockItems.code })
            .from(stockItems)
            .where(and(eq(stockItems.companyId, companyId), eq(stockItems.id, original.stockItemId)))
            .limit(1);
          if (!stockItem || !currentCode || stockItem.code !== currentCode) {
            throw new BaleStatusChangeRefusal(
              "The bale product no longer matches its original inventory item. Reconcile the item before restoring.",
              [{ id, from: bale.status, to: "IN_STOCK" }]
            );
          }

          const movement = await postStockMovementTx(
            tx,
            {
              companyId,
              stockItemId: original.stockItemId,
              kind: "reversal",
              quantity: "1",
              unitCost: String(original.unitCost),
              toLocationId: locationId,
              reversalOfMovementId: original.id,
              occurredAt: new Date().toISOString(),
              source: {
                sourceType: "factory_bale_reentry",
                sourceId: String(id),
                idempotencyKey: `factory-bale-reentry:${companyId}:${id}:${original.id}`,
              },
              actor: { userId: actorId, username: actorName, reason },
            },
            createDatabaseStockMovementAdapter()
          );
          if (movement.idempotent) {
            throw new BaleStatusChangeRefusal("This bale has already been restored to ERP inventory.", [
              { id, from: bale.status, to: "IN_STOCK" },
            ]);
          }
          await adjustInventory(tx, locationId, original.stockItemId, 1, companyId);
          const [restored] = await tx
            .update(factoryBales)
            .set({ status: "IN_STOCK", deletedAt: null, updatedAt: new Date() })
            .where(
              and(eq(factoryBales.id, id), eq(factoryBales.companyId, companyId), eq(factoryBales.status, "DELETED"))
            )
            .returning({ id: factoryBales.id, status: factoryBales.status });
          if (!restored) throw new Error("Bale status changed while restoring; transaction cancelled");

          await recordFactoryStockValueEventTx(tx, {
            companyId,
            kind: "WASTE",
            amount: toMoney(bale.totalCost ?? 0),
            sourceType: "factory-bale-physical-reentry",
            sourceId: id,
          });
          await writeDaybookEntry(tx, {
            companyId,
            txDate: await companyBusinessDate(companyId, tx),
            txType: "BALE_REENTRY",
            referenceId: id,
            referenceTable: "factory_bales",
            description: `Bale ${bale.referenceNumber} restored to stock by ${actorName}. Reason: ${reason}`,
            createdBy: actorName,
            metaJson: JSON.stringify({
              baleId: id,
              referenceNumber: bale.referenceNumber,
              originalDeletionId: physicalDeletion.id,
              originalMovementId: original.id,
              reentryMovementIds: movement.movements.map((row) => row.id),
              locationId,
              stockItemId: original.stockItemId,
              reason,
            }),
          });
          await writeAuditEvent(
            {
              userId: actorId || "unknown",
              username: actorName,
              companyId,
              action: "update",
              tableName: "factory_bales",
              recordId: id,
              recordIdentifier: bale.referenceNumber || `Bale #${id}`,
              changes: {
                status: { old: "DELETED", new: "IN_STOCK" },
                deletedAt: { old: bale.deletedAt, new: null },
                originalDeletionId: { new: physicalDeletion.id },
                reversedStockMovementId: { new: original.id },
                reason: { new: reason },
              },
            },
            tx
          );
          return { outcome: "restored" as const, ...restored, movementIds: movement.movements.map((row) => row.id) };
        });
        if (result.outcome === "missing") return res.status(404).json({ message: "Bale not found" });
        if (result.outcome === "legacy") {
          return res.status(409).json({
            code: "BALE_LEGACY_STATUS_RESTORE",
            message: "This bale has only a legacy status deletion; use the status restoration path.",
          });
        }
        res.json(result);
      } catch (error: unknown) {
        baleWriteErrorResponse(res, error);
      }
    }
  );

  // Phase 19 C (F3): Admin/Owner; only a pre-stock bale (no value) is deleted
  // here; a valued or sold bale is removed or written off through Stock Removal
  // (409). The delete runs through the physical-deletion service (main #2134:
  // loading links, Priority Scan reversal, deletion record, daybook) and commits
  // with its audit row (the bale as it was).
  app.delete(
    "/api/factory/bales/:id",
    requireAuth,
    requireRole("Admin", "Owner"),
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        const id = parseId(req.params.id);
        if (id === null) return res.status(400).json({ message: "Invalid id" });

        await db.transaction(async (tx) => {
          await lockPriorityScanQueueTx(tx, companyId);
          await deletePreStockBalesTx(tx, req, companyId, [id], "Bale removed from Factory Bale History");
        });

        res.json({ message: "Bale deleted" });
      } catch (error: unknown) {
        baleWriteErrorResponse(res, error);
      }
    }
  );

  registerBalesMaintenanceRoutes(app);
}
