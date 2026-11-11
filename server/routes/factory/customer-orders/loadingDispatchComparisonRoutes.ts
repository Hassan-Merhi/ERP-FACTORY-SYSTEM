/**
 * Phase 4 read-only reconciliation endpoints for Factory truck dispatches.
 * The current loading's bale IDs are authoritative for the overall expected
 * set. Per-trip expectations come exclusively from explicitly assigned
 * article/exact-bale plan rows (priority allocation is Phase 5).
 */
import type { Express, Request, Response } from "express";
import { sql } from "drizzle-orm";
import { db, type DbTransaction } from "../../../db";
import { requireAuth } from "../../../auth";
import { getFactoryAccessState, requireFactoryTabAccess } from "../../../lib/factoryAccessControl";
import { parseId } from "../../../lib/parseId";
import { resultRows } from "../../../lib/queryResult";
import { logger } from "../../../lib/logger";
import {
  compareFactoryLoadingDispatch,
  type ComparisonBale,
  type ComparisonExpectedArticle,
  type ComparisonExpectedBale,
  type ComparisonScan,
  type ComparisonTrip,
} from "./loadingDispatchComparison";

const loadingAccess = requireFactoryTabAccess("factory/invoicing", "hide_invoicing_loadings_tab");
function numeric(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}
function stringValue(value: unknown): string { return value == null ? "" : String(value); }

/**
 * Reusable company-scoped reconciliation data loader.
 * Callers decide transaction isolation/locking; closing holds an order row
 * lock so this exact snapshot is validated before status changes.
 */
export async function loadFactoryLoadingDispatchComparisonSnapshot(
  tx: DbTransaction, companyId: number, orderId: number, selectedDispatchId?: number
) {
  const orderRows = resultRows(await tx.execute(sql`
    SELECT id, status, invoice_number AS "invoiceNumber", container_number AS "containerNumber",
           deleted_at AS "deletedAt"
      FROM customer_orders
     WHERE id = ${orderId} AND company_id = ${companyId}
     LIMIT 1
  `));
  const order = orderRows[0];
  if (!order) return null;

  const tripsRows = resultRows(await tx.execute(sql`
    SELECT id, dispatch_number AS "dispatchNumber", status,
           truck_plate AS "truckPlate"
      FROM factory_loading_dispatches
     WHERE company_id = ${companyId} AND order_id = ${orderId}
     ORDER BY dispatch_number
  `));
  const trips: ComparisonTrip[] = tripsRows.map((row) => ({
    id: stringValue(row.id),
    dispatchNumber: numeric(row.dispatchNumber),
    status: stringValue(row.status),
    truckPlate: row.truckPlate == null ? null : stringValue(row.truckPlate),
  }));
  if (selectedDispatchId !== undefined && !trips.some((t) => t.id === String(selectedDispatchId))) {
    return { notFoundTrip: true as const };
  }

  // Loaded barcode IDs define the current order expectation.
  const loadedRows = resultRows(await tx.execute(sql`
    SELECT cob.id AS "orderBaleId", cob.bale_id AS "baleId", cob.bale_reference AS "baleReference",
           cob.article_code AS "articleCode", cob.bale_name AS "productName",
           cob.weight AS "weightKg"
      FROM customer_order_bales cob
     WHERE cob.order_id = ${orderId}
     ORDER BY cob.id
  `));
  const loaded: ComparisonBale[] = loadedRows.map((row) => ({
    orderBaleId: numeric(row.orderBaleId),
    baleId: numeric(row.baleId),
    baleReference: stringValue(row.baleReference),
    articleCode: stringValue(row.articleCode),
    productName: stringValue(row.productName),
    weightKg: numeric(row.weightKg),
  }));

  // Active physical-verification evidence only. Removed scans stay visible
  // on the existing audit/scan-history page, but do not count as verified.
  const scanRows = resultRows(await tx.execute(sql`
    SELECT s.id AS "scanId", s.bale_id AS "baleId",
           s.bale_reference AS "baleReference",
           s.article_code AS "articleCode", s.product_name AS "productName",
           s.weight_kg AS "weightKg",
           s.dispatch_id AS "dispatchId",
           d.dispatch_number AS "dispatchNumber",
           s.scanned_by_username AS "scannedBy",
           s.scanned_at AS "scannedAt"
      FROM factory_loading_dispatch_scans s
      JOIN factory_loading_dispatches d
        ON d.id = s.dispatch_id AND d.company_id = s.company_id
       AND d.order_id = s.order_id
     WHERE s.company_id = ${companyId} AND s.order_id = ${orderId}
       AND s.removed_at IS NULL
     ORDER BY s.id
  `));
  const scans: ComparisonScan[] = scanRows.map((row) => ({
    scanId: stringValue(row.scanId),
    baleId: numeric(row.baleId),
    baleReference: stringValue(row.baleReference),
    articleCode: stringValue(row.articleCode),
    productName: stringValue(row.productName),
    weightKg: numeric(row.weightKg),
    dispatchId: stringValue(row.dispatchId),
    dispatchNumber: numeric(row.dispatchNumber),
    scannedBy: stringValue(row.scannedBy),
    scannedAt: stringValue(row.scannedAt),
  }));

  const expectedBaleRows = resultRows(await tx.execute(sql`
    SELECT e.dispatch_id AS "dispatchId", e.bale_id AS "baleId",
           COALESCE(
             (SELECT cob.bale_reference FROM customer_order_bales cob
              WHERE cob.order_id = e.order_id AND cob.bale_id = e.bale_id
              ORDER BY cob.id DESC LIMIT 1), fb.reference_number
           ) AS "baleReference",
           COALESCE(
             (SELECT cob.article_code FROM customer_order_bales cob
              WHERE cob.order_id = e.order_id AND cob.bale_id = e.bale_id
              ORDER BY cob.id DESC LIMIT 1), fb.article_code
           ) AS "articleCode",
           COALESCE(
             (SELECT cob.bale_name FROM customer_order_bales cob
              WHERE cob.order_id = e.order_id AND cob.bale_id = e.bale_id
              ORDER BY cob.id DESC LIMIT 1), fb.product_name
           ) AS "productName",
           COALESCE(
             (SELECT cob.weight FROM customer_order_bales cob
              WHERE cob.order_id = e.order_id AND cob.bale_id = e.bale_id
              ORDER BY cob.id DESC LIMIT 1), fb.weight_kg
           ) AS "weightKg"
      FROM factory_loading_dispatch_expected_bales e
      JOIN factory_bales fb ON fb.id = e.bale_id
       AND fb.company_id = e.company_id
     WHERE e.company_id = ${companyId} AND e.order_id = ${orderId}
       AND e.removed_at IS NULL
     ORDER BY e.id
  `));
  const expectedBales: ComparisonExpectedBale[] = expectedBaleRows.map((row) => ({
    dispatchId: stringValue(row.dispatchId),
    baleId: numeric(row.baleId),
    baleReference: stringValue(row.baleReference),
    articleCode: stringValue(row.articleCode),
    productName: stringValue(row.productName),
    weightKg: numeric(row.weightKg),
  }));

  const expectedArticleRows = resultRows(await tx.execute(sql`
    SELECT dispatch_id AS "dispatchId", article_code AS "articleCode",
           product_name AS "productName", expected_qty AS "expectedQty",
           priority_rank AS "priorityRank"
      FROM factory_loading_dispatch_expected_articles
     WHERE company_id = ${companyId} AND order_id = ${orderId}
     ORDER BY priority_rank NULLS LAST, id
  `));
  const expectedArticles: ComparisonExpectedArticle[] = expectedArticleRows.map((row) => ({
    dispatchId: stringValue(row.dispatchId),
    articleCode: stringValue(row.articleCode),
    productName: stringValue(row.productName),
    expectedQty: numeric(row.expectedQty),
    priorityRank: row.priorityRank == null ? null : numeric(row.priorityRank),
  }));

  return {
    order, loaded, scans, trips, expectedBales, expectedArticles,
  };
}

async function respondWithComparison(req: Request, res: Response, tripScoped: boolean) {
  const state = await getFactoryAccessState(req);
  if (!state) return res.status(403).json({ message: "Factory access context unavailable" });
  const orderId = parseId(req.params.id);
  if (orderId === null) return res.status(400).json({ message: "Invalid loading order" });
  const dispatchId = tripScoped ? parseId(req.params.dispatchId) : null;
  if (tripScoped && dispatchId === null) return res.status(400).json({ message: "Invalid dispatch" });

  try {
    const companyId = state.companyId;
    // Every table read occurs within one stable read-only snapshot. This
    // prevents counters and missing-reference lists disagreeing mid-scan.
      const snapshot = await db.transaction(async (tx) => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      return loadFactoryLoadingDispatchComparisonSnapshot(tx, companyId, orderId,
        tripScoped ? dispatchId! : undefined);
    });

    if (!snapshot) return res.status(404).json({ message: "Loading order not found in this company" });
    if ("notFoundTrip" in snapshot) return res.status(404).json({ message: "Dispatch not found for this loading" });

    const comparison = compareFactoryLoadingDispatch({
      loaded: snapshot.loaded,
      scans: snapshot.scans,
      // No truck-specific expectations: Pending Loading is the only source
      // for the final order-wide comparison.
      expectedBales: [],
      expectedArticles: [],
      trips: snapshot.trips,
      ...(tripScoped ? { selectedDispatchId: String(dispatchId) } : {}),
    });
    return res.json({
      orderId,
      containerNumber: snapshot.order.containerNumber ?? null,
      loadingStatus: snapshot.order.status,
      generatedAt: new Date().toISOString(),
      ...comparison,
    });
  } catch (error) {
    logger.error("Error comparing Factory truck dispatch verification", { error });
    return res.status(500).json({ message: "Unable to compare this loading and its truck trips" });
  }
}

export function registerFactoryLoadingDispatchComparisonRoutes(app: Express): void {
  // IMPORTANT: register before /:dispatchId in loadingDispatchRoutes.
  app.get("/api/factory/customer-orders/:id/loading-dispatches/comparison",
    requireAuth, loadingAccess, (req, res) => {
      void respondWithComparison(req, res, false);
    });

  app.get("/api/factory/customer-orders/:id/loading-dispatches/:dispatchId/comparison",
    requireAuth, loadingAccess, (req, res) => {
      void respondWithComparison(req, res, true);
    });
}
