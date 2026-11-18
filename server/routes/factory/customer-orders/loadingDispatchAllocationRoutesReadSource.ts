// Extracted from ./loadingDispatchAllocationRoutes.ts to keep that module under the source-size cap.
import { sql } from "drizzle-orm";
import type { DbTransaction } from "../../../db";
import { code, fail, num, rows, str, type Loaded, type Source } from "./loadingDispatchAllocationRoutesParsePlan";

export async function readSource(
  tx: DbTransaction,
  companyId: number,
  orderId: number,
  dispatchId: number,
  lock: boolean
): Promise<Source> {
  const orderRows = rows(
    await tx.execute(
      lock
        ? sql`
    SELECT id, status, deleted_at AS "deletedAt", proforma_id_used AS "proformaIdUsed",
           container_number AS "containerNumber"
      FROM customer_orders WHERE id = ${orderId} AND company_id = ${companyId} FOR UPDATE
  `
        : sql`
    SELECT id, status, deleted_at AS "deletedAt", proforma_id_used AS "proformaIdUsed",
           container_number AS "containerNumber"
      FROM customer_orders WHERE id = ${orderId} AND company_id = ${companyId}
  `
    )
  );
  const order = orderRows[0];
  if (!order) fail(404, "LOADING_NOT_FOUND", "Loading not found in the active company");
  const tripRows = rows(
    await tx.execute(
      lock
        ? sql`
    SELECT id, status, dispatch_number AS "dispatchNumber",
           truck_plate AS "truckPlate" FROM factory_loading_dispatches
     WHERE company_id = ${companyId} AND order_id = ${orderId} AND id = ${dispatchId} FOR UPDATE
  `
        : sql`
    SELECT id, status, dispatch_number AS "dispatchNumber",
           truck_plate AS "truckPlate" FROM factory_loading_dispatches
     WHERE company_id = ${companyId} AND order_id = ${orderId} AND id = ${dispatchId}
  `
    )
  );
  const trip = tripRows[0];
  if (!trip) fail(404, "DISPATCH_NOT_FOUND", "Truck dispatch not found for this loading");

  const loadedRaw = rows(
    await tx.execute(sql`
    SELECT DISTINCT ON (cob.bale_id)
           cob.bale_id AS "baleId", cob.bale_reference AS "baleReference",
           cob.article_code AS "articleCode", cob.bale_name AS "productName",
           cob.weight AS "weightKg", cob.id AS "orderIndex"
      FROM customer_order_bales cob WHERE cob.order_id = ${orderId}
     ORDER BY cob.bale_id, cob.id DESC
  `)
  );
  const loaded: Loaded[] = loadedRaw
    .map((r) => ({
      baleId: num(r.baleId),
      baleReference: str(r.baleReference),
      articleCode: code(r.articleCode),
      productName: str(r.productName),
      weightKg: num(r.weightKg),
      orderIndex: num(r.orderIndex),
    }))
    .sort((a, b) => a.orderIndex - b.orderIndex);

  const priority =
    rows(
      await tx.execute(sql`
    SELECT priority, color, enabled, updated_at AS "updatedAt"
      FROM customer_order_priority_scan_configs
     WHERE company_id = ${companyId} AND order_id = ${orderId} LIMIT 1
  `)
    )[0] ?? null;
  const proformaId = order.proformaIdUsed == null ? null : num(order.proformaIdUsed);
  const rankRows = proformaId
    ? rows(
        await tx.execute(sql`
    SELECT UPPER(TRIM(pl.article_code)) AS "articleCode", MIN(pl.id) AS "sortId"
      FROM customer_proforma_lines pl
      JOIN customer_proformas p ON p.id = pl.proforma_id AND p.company_id = ${companyId}
     WHERE pl.proforma_id = ${proformaId}
     GROUP BY UPPER(TRIM(pl.article_code)) ORDER BY "sortId"
  `)
      )
    : [];
  const fallbackRanks = rows(
    await tx.execute(sql`
    SELECT UPPER(TRIM(article_code)) AS "articleCode", MIN(id) AS "sortId"
      FROM customer_order_lines WHERE order_id = ${orderId}
     GROUP BY UPPER(TRIM(article_code)) ORDER BY "sortId"
  `)
  );
  const queueRanks = new Map<string, number>();
  for (const line of [...rankRows, ...fallbackRanks]) {
    const normalized = code(line.articleCode);
    if (normalized && !queueRanks.has(normalized)) queueRanks.set(normalized, queueRanks.size + 1);
  }

  const existingArticles = rows(
    await tx.execute(sql`
    SELECT a.id, a.dispatch_id AS "dispatchId", d.dispatch_number AS "dispatchNumber",
           a.article_code AS "articleCode", a.product_name AS "productName",
           a.expected_qty AS "expectedQty", a.priority_rank AS "priorityRank"
      FROM factory_loading_dispatch_expected_articles a
      JOIN factory_loading_dispatches d ON d.id = a.dispatch_id AND d.company_id = a.company_id AND d.order_id = a.order_id
     WHERE a.company_id = ${companyId} AND a.order_id = ${orderId}
     ORDER BY a.id
  `)
  );
  const existingBales = rows(
    await tx.execute(sql`
    SELECT e.id, e.bale_id AS "baleId", e.dispatch_id AS "dispatchId",
           d.dispatch_number AS "dispatchNumber", e.source
      FROM factory_loading_dispatch_expected_bales e
      JOIN factory_loading_dispatches d ON d.id = e.dispatch_id AND d.company_id = e.company_id AND d.order_id = e.order_id
     WHERE e.company_id = ${companyId} AND e.order_id = ${orderId}
       AND e.removed_at IS NULL
     ORDER BY e.id
  `)
  );
  const scans = rows(
    await tx.execute(sql`
    SELECT s.bale_id AS "baleId", s.dispatch_id AS "dispatchId",
           d.dispatch_number AS "dispatchNumber", s.article_code AS "articleCode"
      FROM factory_loading_dispatch_scans s
      JOIN factory_loading_dispatches d ON d.id = s.dispatch_id AND d.company_id = s.company_id AND d.order_id = s.order_id
     WHERE s.company_id = ${companyId} AND s.order_id = ${orderId}
       AND s.removed_at IS NULL
  `)
  );
  return { trip, order, loaded, priority, queueRanks, existingArticles, existingBales, scans };
}
