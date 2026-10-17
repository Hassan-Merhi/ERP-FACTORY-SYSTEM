import { lineAmount, parseMoneyInput, toMoney } from "../../../lib/money";
import { normalizeSearchText } from "@shared/searchNormalization";
/**
 * factoryBalesRoutes: BalesCrud endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { logAudit } from "../../helpers/auditHelpers";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { parseId } from "../../../lib/parseId";
import { db } from "../../../db";
import { requireAuth, requireRole } from "../../../auth";
import { writeAuditEvent } from "../../../services/audit/auditService";
import { recordFactoryStockValueEventTx } from "../../../services/factory/factoryStockValueEvents";
import {
  BaleStatusChangeRefusal,
  FACTORY_BALE_STATUS_CHANGES_VALUE_MESSAGE,
  isValueNeutralBaleStatusChange,
} from "../../../services/factory/baleStatusPolicy";

import {
  factoryBaleProducts,
  factoryMixBatches,
  factoryBales,
  factoryBaleSequences,
  baleLabelPrints,
  customerOrderBales,
  factoryWorkers,
  factoryV3LoadBales,
  factoryInvoiceLoadingBales,
  factoryBaleProductionAttributions,
  factoryPhysicalBaleDeletions,
  customerOrders,
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
                and(
                  eq(factoryPhysicalBaleDeletions.companyId, companyId),
                  eq(factoryPhysicalBaleDeletions.baleId, id)
                )
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
                and(
                  eq(factoryBales.id, id),
                  eq(factoryBales.companyId, companyId),
                  eq(factoryBales.status, "DELETED")
                )
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

  app.patch("/api/factory/bales/:id/product-name", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const id = parseId(req.params.id);

      if (id === null) return res.status(400).json({ message: "Invalid id" });
      const { name } = req.body;
      if (!name || typeof name !== "string" || !name.trim()) {
        return res.status(400).json({ message: "Name is required" });
      }

      const [bale] = await db
        .select()
        .from(factoryBales)
        .where(and(eq(factoryBales.id, id), eq(factoryBales.companyId, companyId)));

      if (!bale) return res.status(404).json({ message: "Bale not found" });

      // Phase 21 (B): the rename and its audit commit together.
      await db.transaction(async (tx) => {
        if (bale.productId) {
          await tx
            .update(factoryBaleProducts)
            .set({ name: name.trim(), updatedAt: new Date() })
            .where(and(eq(factoryBaleProducts.id, bale.productId), eq(factoryBaleProducts.companyId, companyId)));
        }

        await tx
          .update(factoryBales)
          .set({ productName: name.trim(), updatedAt: new Date() })
          .where(eq(factoryBales.id, id));

        await logAudit(
          {
            userId: req.session.userId!,
            username: req.session.username || req.session.userId!,
            companyId,
            action: "update",
            tableName: "bales",
            recordId: id,
            recordIdentifier: `Bale #${id}`,
            changes: { productName: { old: bale.productName, new: name.trim() } },
          },
          tx
        );
      });
      res.json({ success: true });
    } catch (error: unknown) {
      logger.error("Error updating bale product name:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.patch("/api/factory/bales/:id/assign-worker", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const id = parseId(req.params.id);
      if (id === null) return res.status(400).json({ message: "Invalid id" });
      const { workerId } = req.body;
      if (!workerId) return res.status(400).json({ message: "workerId is required" });
      const numericWorkerId = Number(workerId);
      if (!Number.isInteger(numericWorkerId) || numericWorkerId <= 0) {
        return res.status(400).json({ message: "Invalid workerId" });
      }
      const [worker] = await db
        .select({ fullName: factoryWorkers.fullName })
        .from(factoryWorkers)
        .where(
          and(
            eq(factoryWorkers.id, numericWorkerId),
            eq(factoryWorkers.companyId, companyId),
            eq(factoryWorkers.active, true)
          )
        )
        .limit(1);
      if (!worker) return res.status(400).json({ message: "Worker is inactive or belongs to another company" });

      const updated = await db.transaction(async (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => {
        const [updatedBale] = await tx
          .update(factoryBales)
          .set({ finalizedBy: numericWorkerId, workerName: worker.fullName, updatedAt: new Date() })
          .where(and(eq(factoryBales.id, id), eq(factoryBales.companyId, companyId)))
          .returning();
        if (!updatedBale) return null;

        // A worker-only correction must not silently move production between
        // teams. Preserve the position snapshot, but keep the worker snapshot
        // synchronized for Stock Entry bales that have attribution records.
        await tx
          .update(factoryBaleProductionAttributions)
          .set({ workerId: numericWorkerId, workerNameSnapshot: worker.fullName })
          .where(
            and(
              eq(factoryBaleProductionAttributions.companyId, companyId),
              eq(factoryBaleProductionAttributions.baleId, id)
            )
          );
        return updatedBale;
      });

      if (!updated) return res.status(404).json({ message: "Bale not found" });
      res.json(updated);
    } catch (error: unknown) {
      logger.error("Error assigning worker to bale:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // ── Bulk assign worker to multiple bales (for stock entry history groups) ──
  app.patch("/api/factory/bales/bulk-assign-worker", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const { baleIds, workerId } = req.body;
      if (!Array.isArray(baleIds) || baleIds.length === 0)
        return res.status(400).json({ message: "baleIds array is required" });
      if (!workerId) return res.status(400).json({ message: "workerId is required" });
      const numericIds = [...new Set(baleIds.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
      if (numericIds.length === 0) return res.status(400).json({ message: "No valid bale IDs supplied" });
      const numericWorkerId = Number(workerId);
      if (!Number.isInteger(numericWorkerId) || numericWorkerId <= 0) {
        return res.status(400).json({ message: "Invalid workerId" });
      }
      const [worker] = await db
        .select({ fullName: factoryWorkers.fullName })
        .from(factoryWorkers)
        .where(
          and(
            eq(factoryWorkers.id, numericWorkerId),
            eq(factoryWorkers.companyId, companyId),
            eq(factoryWorkers.active, true)
          )
        )
        .limit(1);
      if (!worker) return res.status(400).json({ message: "Worker is inactive or belongs to another company" });

      const updatedIds = await db.transaction(async (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => {
        const updatedBales = await tx
          .update(factoryBales)
          .set({ finalizedBy: numericWorkerId, workerName: worker.fullName, updatedAt: new Date() })
          .where(and(eq(factoryBales.companyId, companyId), inArray(factoryBales.id, numericIds)))
          .returning({ id: factoryBales.id });
        const ids = updatedBales.map((bale) => bale.id);
        if (ids.length > 0) {
          await tx
            .update(factoryBaleProductionAttributions)
            .set({ workerId: numericWorkerId, workerNameSnapshot: worker.fullName })
            .where(
              and(
                eq(factoryBaleProductionAttributions.companyId, companyId),
                inArray(factoryBaleProductionAttributions.baleId, ids)
              )
            );
        }
        return ids;
      });

      res.json({ updated: updatedIds.length, workerId: numericWorkerId });
    } catch (error: unknown) {
      logger.error("Error bulk-assigning worker:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // ── Correct bale weight (cascades to load bales, invoice bales, order bales) ──
  app.patch("/api/factory/bales/:id/weight", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const id = parseId(req.params.id);
      if (id === null) return res.status(400).json({ message: "Invalid id" });

      const rawWeight = parseMoneyInput(req.body.weightKg)?.toNumber() ?? NaN;
      if (isNaN(rawWeight) || rawWeight <= 0) {
        return res.status(400).json({ message: "weightKg must be a positive number" });
      }
      const newWeightStr = rawWeight.toFixed(3);

      const result = await db.transaction(async (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => {
        // Fetch bale and verify ownership
        const [bale] = await tx
          .select()
          .from(factoryBales)
          .where(and(eq(factoryBales.id, id), eq(factoryBales.companyId, companyId)));

        if (!bale) throw new Error("Bale not found");

        // Exact weight x rate, rounded once: 3.000 kg at 1.115 is 3.35, not 3.34.
        const newTotalCost = lineAmount(newWeightStr, bale.costPerKg).toFixed(2);
        const oldWeight = toMoney(bale.weightKg).toNumber();

        // 1. Update the bale itself
        const [updatedBale] = await tx
          .update(factoryBales)
          .set({
            weightKg: newWeightStr,
            totalCost: newTotalCost,
            updatedAt: new Date(),
          })
          .where(eq(factoryBales.id, id))
          .returning();

        // 2. Update factory_v3_load_bales (loading order scans)
        const loadBalesResult = await tx
          .update(factoryV3LoadBales)
          .set({ weightKg: newWeightStr })
          .where(eq(factoryV3LoadBales.baleId, id));

        // 3. Update factory_invoice_loading_bales (invoice loading session scans)
        const invoiceBalesResult = await tx
          .update(factoryInvoiceLoadingBales)
          .set({ weightKg: newWeightStr })
          .where(eq(factoryInvoiceLoadingBales.baleId, id));

        // 4. Update customer_order_bales (weight column is "weight", not "weightKg")
        const orderBalesResult = await tx
          .update(customerOrderBales)
          .set({ weight: newWeightStr })
          .where(eq(customerOrderBales.baleId, id));

        const weightResult = {
          bale: updatedBale,
          oldWeight,
          newWeight: rawWeight,
          updatedLoadBales: loadBalesResult?.rowCount ?? 0,
          updatedInvoiceBales: invoiceBalesResult?.rowCount ?? 0,
          updatedOrderBales: orderBalesResult?.rowCount ?? 0,
        };
        await logAudit(
          {
            userId: req.session.userId!,
            username: req.session.username || req.session.userId!,
            companyId,
            action: "update",
            tableName: "factory_bales",
            recordId: id,
            recordIdentifier: weightResult.bale.referenceNumber || `Bale #${id}`,
            changes: { weightKg: { old: weightResult.oldWeight, new: weightResult.newWeight } },
          },
          tx
        );
        return weightResult;
      });

      res.json({
        success: true,
        baleId: id,
        referenceNumber: result.bale.referenceNumber,
        oldWeight: result.oldWeight,
        newWeight: result.newWeight,
        updatedLoadBales: result.updatedLoadBales,
        updatedInvoiceBales: result.updatedInvoiceBales,
        updatedOrderBales: result.updatedOrderBales,
      });
    } catch (error: unknown) {
      logger.error("Error correcting bale weight:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/factory/bales/:id/repack", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const id = parseId(req.params.id);

      if (id === null) return res.status(400).json({ message: "Invalid id" });

      const result = await db.transaction(async (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => {
        const [originalBale] = await tx
          .select()
          .from(factoryBales)
          .where(and(eq(factoryBales.id, id), eq(factoryBales.companyId, companyId)));

        if (!originalBale) throw new Error("Bale not found");
        if (originalBale.status === "REPACKED") throw new Error("Bale has already been repacked");
        if (originalBale.status === "SOLD") throw new Error("Cannot repack a sold bale");

        const [seqRecord] = await tx
          .select()
          .from(factoryBaleSequences)
          .where(eq(factoryBaleSequences.companyId, companyId))
          .for("update");

        let nextNumber: number;
        if (seqRecord) {
          nextNumber = seqRecord.nextNumber;
          await tx
            .update(factoryBaleSequences)
            .set({ nextNumber: nextNumber + 1 })
            .where(eq(factoryBaleSequences.id, seqRecord.id));
        } else {
          nextNumber = 200000;
          await tx.insert(factoryBaleSequences).values({
            companyId,
            nextNumber: 200001,
          });
        }

        const newRefNum = `REF${String(nextNumber).padStart(6, "0")}`;

        const [newBale] = await tx
          .insert(factoryBales)
          .values({
            companyId: originalBale.companyId,
            mixBatchId: originalBale.mixBatchId,
            productId: originalBale.productId,
            pressingBatchId: originalBale.pressingBatchId,
            erpLocationId: originalBale.erpLocationId,
            baleCode: originalBale.baleCode,
            referenceNumber: newRefNum,
            articleCode: originalBale.articleCode,
            productName: originalBale.productName,
            category: originalBale.category,
            grade: originalBale.grade,
            quantity: originalBale.quantity,
            weightKg: originalBale.weightKg,
            costPerKg: originalBale.costPerKg,
            totalCost: originalBale.totalCost,
            status: "IN_STOCK",
            finalizedBy: originalBale.finalizedBy,
            workerName: originalBale.workerName,
            finalizedAt: originalBale.finalizedAt,
            stockEntryDate: originalBale.stockEntryDate,
          })
          .returning();

        const [productionAttribution] = await tx
          .select()
          .from(factoryBaleProductionAttributions)
          .where(
            and(
              eq(factoryBaleProductionAttributions.companyId, companyId),
              eq(factoryBaleProductionAttributions.baleId, id)
            )
          )
          .limit(1);
        if (productionAttribution) {
          await tx.insert(factoryBaleProductionAttributions).values({
            companyId,
            baleId: newBale.id,
            workerId: productionAttribution.workerId,
            workerNameSnapshot: productionAttribution.workerNameSnapshot,
            productionPositionId: productionAttribution.productionPositionId,
            productionPositionNameSnapshot: productionAttribution.productionPositionNameSnapshot,
            stockEntryDate: productionAttribution.stockEntryDate,
          });
        }

        await tx.update(factoryBales).set({ status: "REPACKED", updatedAt: new Date() }).where(eq(factoryBales.id, id));

        const repackResult = { originalBale, newBale, newRefNum };
        await logAudit(
          {
            userId: req.session.userId!,
            username: req.session.username || req.session.userId!,
            companyId,
            action: "update",
            tableName: "factory_bales",
            recordId: id,
            recordIdentifier: repackResult.originalBale.referenceNumber || `Bale #${id}`,
            changes: {
              status: { old: repackResult.originalBale.status, new: "REPACKED" },
              newBaleRef: { old: null, new: repackResult.newRefNum },
            },
          },
          tx
        );
        return repackResult;
      });

      res.json(result);
    } catch (error: unknown) {
      logger.error("Error repacking bale:", { error: error });
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });
}
