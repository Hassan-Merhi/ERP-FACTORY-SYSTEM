// Extracted from ./registerBalesCrudRoutesPart1.ts
import { normalizeSearchText } from "@shared/searchNormalization";
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { baleLabelPrints, factoryBaleProducts, factoryBales, factoryMixBatches } from "@shared/schema";
import { and, desc, eq, inArray, not, sql } from "drizzle-orm";

export function registerBalesCrudRoutesPart5(app: Express) {
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
}
