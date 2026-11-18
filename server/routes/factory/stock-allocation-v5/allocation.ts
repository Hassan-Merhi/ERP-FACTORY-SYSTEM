import { searchAny } from "@shared/searchNormalization";
/**
 * factoryStockAllocationV5Routes: V5StockAllocation endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { sql } from "drizzle-orm";
import { resultRows } from "../../../lib/queryResult";
import { handleGetFactoryV5StockAllocationStep1 } from "./handleGetFactoryV5StockAllocationStep1";

export function registerV5StockAllocationRoutes(app: Express) {
  registerV5StockAllocationRoutesStep1(app);
  registerV5StockAllocationRoutesStep2(app);
}

function registerV5StockAllocationRoutesStep1(app: Express) {
  // ── GET /api/factory/v5/stock-allocation ────────────────────────────────
  app.get("/api/factory/v5/stock-allocation", requireAuth, async (req: Request, res: Response) => {
    try {
      const step1Result = await handleGetFactoryV5StockAllocationStep1(req, res);
      if (step1Result.done) return step1Result.value;
      const {
        containerFilter,
        customerFilter,
        hideZero,
        limitQ,
        pageQ,
        productFilter,
        productNamesMap,
        proformaFilter,
        rows,
        search,
        statusFilter,
      } = step1Result;
      handleGetFactoryV5StockAllocationStep2(
        {
          containerFilter,
          customerFilter,
          hideZero,
          limitQ,
          pageQ,
          productFilter,
          productNamesMap,
          proformaFilter,
          rows,
          search,
          statusFilter,
        },
        res
      );
    } catch (err: unknown) {
      logger.error("[V5] stock-allocation error:", { error: err });
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });
  return {};
}

function registerV5StockAllocationRoutesStep2(app: Express) {
  // ── GET /api/factory/v5/stock-allocation/summary ─────────────────────────
  // Returns aggregate totals only — used for dashboard cards without loading the full list.
  app.get("/api/factory/v5/stock-allocation/summary", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const [inStockRaw, inLoadingRaw, expectedRaw] = await Promise.all([
        db.execute(
          sql`SELECT COUNT(*)::int AS count FROM factory_bales
              WHERE company_id = ${companyId} AND status = 'IN_STOCK'`
        ),
        db.execute(
          sql`SELECT COUNT(*)::int AS count
              FROM customer_order_bales cob
              JOIN customer_orders co ON co.id = cob.order_id
              WHERE co.company_id = ${companyId} AND co.status = 'LOADING' AND co.proforma_id_used IS NOT NULL`
        ),
        db.execute(
          sql`SELECT COALESCE(SUM(cel.expected_qty),0)::int AS qty
              FROM customer_order_expected_lines cel
              JOIN customer_orders co ON co.id = cel.order_id
              WHERE co.company_id = ${companyId} AND co.status IN ('DRAFT','LOADING') AND co.proforma_id_used IS NOT NULL`
        ),
      ]);

      const stockAvailable = Number(resultRows(inStockRaw)[0]?.count ?? 0);
      const totalLoaded = Number(resultRows(inLoadingRaw)[0]?.count ?? 0);
      const expectedToLoad = Number(resultRows(expectedRaw)[0]?.qty ?? 0);
      const freeToPromise = stockAvailable - expectedToLoad - totalLoaded;

      res.set("Cache-Control", "private, max-age=60");
      res.json({ stockAvailable, totalLoaded, expectedToLoad, freeToPromise });
    } catch (err: unknown) {
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });
  return {};
}

function handleGetFactoryV5StockAllocationStep2(
  {
    containerFilter,
    customerFilter,
    hideZero,
    limitQ,
    pageQ,
    productFilter,
    productNamesMap,
    proformaFilter,
    rows,
    search,
    statusFilter,
  }: Pick<
    Extract<Awaited<ReturnType<typeof handleGetFactoryV5StockAllocationStep1>>, { done: false }>,
    | "containerFilter"
    | "customerFilter"
    | "hideZero"
    | "limitQ"
    | "pageQ"
    | "productFilter"
    | "productNamesMap"
    | "proformaFilter"
    | "rows"
    | "search"
    | "statusFilter"
  >,
  res: Response
) {
  // 11. Apply frontend filters
  let filtered = rows;
  if (productFilter) {
    filtered = filtered.filter((r) => searchAny(productFilter, r.articleCode, r.productName));
  }
  if (customerFilter) {
    filtered = filtered.filter((r) => r.proformaDetails.some((d) => searchAny(customerFilter, d.customerName)));
  }
  if (proformaFilter) {
    filtered = filtered.filter((r) => r.proformaDetails.some((d) => searchAny(proformaFilter, d.proformaName)));
  }
  if (containerFilter) {
    filtered = filtered.filter((r) =>
      r.proformaDetails.some((d) => d.containers.some((c) => searchAny(containerFilter, c.containerName)))
    );
  }
  if (statusFilter) {
    const q = String(statusFilter).toUpperCase();
    filtered = filtered.filter((r) => r.proformaDetails.some((d) => d.containers.some((c) => c.status === q)));
  }
  if (hideZero === "true") {
    // Keep rows that have non-zero counts OR that still have at least one non-cancelled
    // container in any linked proforma (e.g. a FINALIZED order whose bales are already SOLD
    // and therefore no longer contribute to stockAvailable / totalLoaded / expectedToLoad).
    filtered = filtered.filter(
      (r) =>
        r.expectedToLoad > 0 ||
        r.stockAvailable > 0 ||
        r.totalLoaded > 0 ||
        r.proformaDetails.some((d) => d.containers.some((c) => c.status !== "CANCELLED"))
    );
  }

  // Search param (frontend search box — unified alias alongside productFilter)
  if (search && !productFilter) {
    filtered = filtered.filter((r) => searchAny(search, r.articleCode, r.productName));
  }

  // Recompute totals over the final filtered set (search may have trimmed rows)
  const finalTotals = {
    stockAvailable: filtered.reduce((s, r) => s + r.stockAvailable, 0),
    totalLoaded: filtered.reduce((s, r) => s + r.totalLoaded, 0),
    expectedToLoad: filtered.reduce((s, r) => s + r.expectedToLoad, 0),
    freeToPromise: filtered.reduce((s, r) => s + r.freeToPromise, 0),
    totalKg: filtered.reduce((s, r) => s + r.totalKg, 0),
    shortageCount: filtered.filter((r) => r.freeToPromise < 0).length,
  };

  // In-memory pagination — only applied when ?page= is explicitly set.
  const rowLimit = Math.min(Number(limitQ) || 100, 250);
  const page = pageQ !== undefined ? Math.max(1, Number(pageQ) || 1) : null;
  const total = filtered.length;
  const totalPages = page !== null ? Math.max(1, Math.ceil(total / rowLimit)) : null;
  const pagedRows = page !== null ? filtered.slice((page - 1) * rowLimit, page * rowLimit) : filtered;

  res.set("Cache-Control", "private, max-age=60");
  if (page !== null) {
    res.json({
      rows: pagedRows,
      totals: finalTotals,
      productNames: productNamesMap,
      total,
      page,
      limit: rowLimit,
      totalPages,
    });
  } else {
    res.json({ rows: filtered, totals: finalTotals, productNames: productNamesMap });
  }
  return {};
}
