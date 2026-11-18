// Extracted from ./balesCrudRoutes.ts to keep that module under the source-size cap.
import { normalizeSearchText } from "@shared/searchNormalization";
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { db } from "../../../db";
import { requireAuth, requireRole } from "../../../auth";
import { writeAuditEvent } from "../../../services/audit/auditService";
import {
  BaleStatusChangeRefusal,
  FACTORY_BALE_STATUS_CHANGES_VALUE_MESSAGE,
  isValueNeutralBaleStatusChange,
} from "../../../services/factory/baleStatusPolicy";
import {
  baleLabelPrints,
  factoryBaleProductionAttributions,
  factoryBaleProducts,
  factoryBales,
  factoryMixBatches,
} from "@shared/schema";
import { and, desc, eq, inArray, not, sql } from "drizzle-orm";
import {
  ALLOWED,
  assertNoLiveLoadingLinkOutsideLoadingStatusTx,
  assertNotOnFinalizedOrderTx,
  baleWriteErrorResponse,
  deletePreStockBalesTx,
  lockPriorityScanQueueTx,
} from "./baleStatusWriteGuards";

export function registerBalesCrudRoutesPart1(app: Express) {
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
}
