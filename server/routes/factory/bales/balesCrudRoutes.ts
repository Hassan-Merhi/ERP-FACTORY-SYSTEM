import { lineAmount } from "../../../lib/money";
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
import type { DbTransaction } from "../../../db";
import { writeAuditEvent } from "../../../services/audit/auditService";
import {
  BaleStatusChangeRefusal,
  FACTORY_BALE_DELETE_CHANGES_VALUE_MESSAGE,
  FACTORY_BALE_STATUS_CHANGES_VALUE_MESSAGE,
  isValueNeutralBaleDelete,
  isValueNeutralBaleStatusChange,
  KNOWN_BALE_STATUSES,
} from "../../../services/factory/baleStatusPolicy";

import {
  factoryBaleProducts,
  factoryMixBatches,
  factoryBales,
  factoryBaleSequences,
  baleLabelPrints,
  customerOrders,
  customerOrderBales,
  factoryWorkers,
  factoryV3LoadBales,
  factoryInvoiceLoadingBales,
  factoryBaleProductionAttributions,
} from "@shared/schema";
import { eq, and, desc, sql, inArray, not } from "drizzle-orm";

/** The status vocabulary the routes accept (an unknown status is 400). */
const ALLOWED = KNOWN_BALE_STATUSES;

const BALE_ON_FINALIZED_ORDER_MESSAGE =
  "Cannot set status to IN_STOCK: this bale is on a finalized order. Use the Return to Stock action to remove it from the order first.";

class BaleOnFinalizedOrderError extends Error {}

/**
 * A bale on a finalized, dispatched or sold order is not set back to IN_STOCK
 * here (the valuation does not count it as stock); the Return to Stock action
 * takes it off the order first.
 */
async function assertNotOnFinalizedOrderTx(
  tx: DbTransaction,
  companyId: number,
  status: string,
  baleIds: number[]
): Promise<void> {
  if (status !== "IN_STOCK" || baleIds.length === 0) return;
  const [onOrder] = await tx
    .select({ baleId: customerOrderBales.baleId })
    .from(customerOrderBales)
    .innerJoin(customerOrders, eq(customerOrders.id, customerOrderBales.orderId))
    .where(
      and(
        inArray(customerOrderBales.baleId, baleIds),
        eq(customerOrders.companyId, companyId),
        inArray(customerOrders.status, ["FINALIZED", "DISPATCHED", "SOLD"])
      )
    )
    .limit(1);
  if (onOrder) throw new BaleOnFinalizedOrderError(BALE_ON_FINALIZED_ORDER_MESSAGE);
}

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
  // with one audit row per bale changed.
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

        const updated = await db.transaction(async (tx) => {
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
        if (error instanceof BaleStatusChangeRefusal) return res.status(409).json(error.body);
        if (error instanceof BaleOnFinalizedOrderError) return res.status(409).json({ message: error.message });
        res.status(500).json({ message: getErrorMessage(error) });
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
  // and its audit row commit together.
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
          const [bale] = await tx
            .select({
              id: factoryBales.id,
              status: factoryBales.status,
              deletedAt: factoryBales.deletedAt,
              referenceNumber: factoryBales.referenceNumber,
            })
            .from(factoryBales)
            .where(and(eq(factoryBales.id, id), eq(factoryBales.companyId, companyId)))
            .for("update");
          if (!bale) return null;
          if (!isValueNeutralBaleStatusChange(bale.status, status, bale.deletedAt)) {
            throw new BaleStatusChangeRefusal(FACTORY_BALE_STATUS_CHANGES_VALUE_MESSAGE, [
              { id, from: bale.status, to: status },
            ]);
          }
          await assertNotOnFinalizedOrderTx(tx, companyId, status, [id]);
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
        if (error instanceof BaleStatusChangeRefusal) return res.status(409).json(error.body);
        if (error instanceof BaleOnFinalizedOrderError) return res.status(409).json({ message: error.message });
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  // Phase 19 C (F3): Admin/Owner; only a pre-stock bale (no value) is deleted
  // here; a valued or sold bale is removed or written off through Stock Removal
  // (409). The delete and its audit row (the bale as it was) commit together.
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

        const deleted = await db.transaction(async (tx) => {
          const [bale] = await tx
            .select()
            .from(factoryBales)
            .where(and(eq(factoryBales.id, id), eq(factoryBales.companyId, companyId)))
            .for("update");
          if (!bale) return false;
          if (!isValueNeutralBaleDelete(bale.status, bale.deletedAt)) {
            throw new BaleStatusChangeRefusal(FACTORY_BALE_DELETE_CHANGES_VALUE_MESSAGE, [
              { id, from: bale.status, to: "DELETED" },
            ]);
          }
          const now = new Date();
          await tx
            .update(factoryBales)
            .set({ status: "DELETED", deletedAt: now, updatedAt: now })
            .where(and(eq(factoryBales.id, id), eq(factoryBales.companyId, companyId)));
          await writeAuditEvent(
            {
              userId: String(req.session.userId ?? "unknown"),
              username: req.session.username || String(req.session.userId ?? "unknown"),
              companyId,
              action: "delete",
              tableName: "factory_bales",
              recordId: id,
              recordIdentifier: bale.referenceNumber || `Bale #${id}`,
              changes: { status: { old: bale.status, new: "DELETED" }, bale: { old: bale } },
            },
            tx
          );
          return true;
        });

        if (!deleted) return res.status(404).json({ message: "Bale not found" });
        res.json({ message: "Bale deleted" });
      } catch (error: unknown) {
        if (error instanceof BaleStatusChangeRefusal) return res.status(409).json(error.body);
        res.status(500).json({ message: getErrorMessage(error) });
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

      if (bale.productId) {
        await db
          .update(factoryBaleProducts)
          .set({ name: name.trim(), updatedAt: new Date() })
          .where(and(eq(factoryBaleProducts.id, bale.productId), eq(factoryBaleProducts.companyId, companyId)));
      }

      await db
        .update(factoryBales)
        .set({ productName: name.trim(), updatedAt: new Date() })
        .where(eq(factoryBales.id, id));

      await logAudit({
        userId: req.session.userId!,
        username: req.session.username || req.session.userId!,
        companyId,
        action: "update",
        tableName: "bales",
        recordId: id,
        recordIdentifier: `Bale #${id}`,
        changes: { productName: { old: bale.productName, new: name.trim() } },
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

      const rawWeight = parseFloat(req.body.weightKg);
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
        const oldWeight = parseFloat(bale.weightKg || "0");

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

        return {
          bale: updatedBale,
          oldWeight,
          newWeight: rawWeight,
          updatedLoadBales: loadBalesResult?.rowCount ?? 0,
          updatedInvoiceBales: invoiceBalesResult?.rowCount ?? 0,
          updatedOrderBales: orderBalesResult?.rowCount ?? 0,
        };
      });

      await logAudit({
        userId: req.session.userId!,
        username: req.session.username || req.session.userId!,
        companyId,
        action: "update",
        tableName: "factory_bales",
        recordId: id,
        recordIdentifier: result.bale.referenceNumber || `Bale #${id}`,
        changes: { weightKg: { old: result.oldWeight, new: result.newWeight } },
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

        return { originalBale, newBale, newRefNum };
      });

      await logAudit({
        userId: req.session.userId!,
        username: req.session.username || req.session.userId!,
        companyId,
        action: "update",
        tableName: "factory_bales",
        recordId: id,
        recordIdentifier: result.originalBale.referenceNumber || `Bale #${id}`,
        changes: {
          status: { old: result.originalBale.status, new: "REPACKED" },
          newBaleRef: { old: null, new: result.newRefNum },
        },
      });
      res.json(result);
    } catch (error: unknown) {
      logger.error("Error repacking bale:", { error: error });
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });
}
