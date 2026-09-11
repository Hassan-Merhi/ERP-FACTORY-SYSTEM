import { sql, and, eq } from "drizzle-orm";
import { db } from "../../db";
import { proformaStockReservations, companies } from "@shared/schema";
import { firstRow } from "../../lib/queryResult";
import { getProformaCapacitySnapshot } from "./customer-orders/proformaCapacity";
import { normalizeLoadingArticleCode } from "./customer-orders/bale-scanning/proformaScanPolicy";

type DbOrTx = Pick<typeof db, "select" | "insert" | "update" | "delete" | "execute">;

/**
 * Rebuild the derived reservation cache from the authoritative capacity engine.
 * reservedQty is exactly the per-article remaining commitment after every
 * non-cancelled, non-deleted linked order, including verified/finalized history.
 */
export async function syncProformaReservations(tx: DbOrTx, companyId: number, proformaId: number): Promise<void> {
  const snapshot = await getProformaCapacitySnapshot(tx, { companyId, proformaId });
  if (!snapshot || !snapshot.proformaActive) {
    await tx
      .delete(proformaStockReservations)
      .where(
        and(eq(proformaStockReservations.companyId, companyId), eq(proformaStockReservations.proformaId, proformaId))
      );
    return;
  }

  const desiredRows = snapshot.articles
    .filter((article) => article.isOnProforma && article.normalizedArticleCode)
    .map((article) => ({
      companyId,
      proformaId,
      articleCode: article.articleCode.trim() || article.normalizedArticleCode,
      reservedQty: article.remainingQty,
    }));

  if (desiredRows.length === 0) {
    await tx
      .delete(proformaStockReservations)
      .where(
        and(eq(proformaStockReservations.companyId, companyId), eq(proformaStockReservations.proformaId, proformaId))
      );
    return;
  }

  await tx
    .insert(proformaStockReservations)
    .values(desiredRows)
    .onConflictDoUpdate({
      target: [
        proformaStockReservations.companyId,
        proformaStockReservations.proformaId,
        proformaStockReservations.articleCode,
      ],
      set: { reservedQty: sql`excluded.reserved_qty` },
    });

  const keepCodes = desiredRows.map((row) => row.articleCode);
  const keepList = sql.join(
    keepCodes.map((code) => sql`${code}`),
    sql`, `
  );
  await tx.execute(sql`DELETE FROM proforma_stock_reservations
      WHERE company_id = ${companyId}
        AND proforma_id = ${proformaId}
        AND article_code NOT IN (${keepList})`);
}

export async function isFactoryV2Company(companyId: number): Promise<boolean> {
  const [co] = await db
    .select({ companyType: companies.companyType })
    .from(companies)
    .where(eq(companies.id, companyId));
  return co?.companyType === "factory" || co?.companyType === "factory_v2";
}

/**
 * Current free-to-promise stock for one normalized article bucket. Reconcile
 * matching active proformas first so stale historical cache rows cannot block
 * or inflate a new promise.
 */
export async function computeFreeToPromise(companyId: number, articleCode: string): Promise<number> {
  const normalized = normalizeLoadingArticleCode(articleCode);
  if (!normalized) return 0;

  const matchingProformas = await db.execute(sql`SELECT DISTINCT cp.id
      FROM customer_proformas cp
      JOIN customer_proforma_lines cpl ON cpl.proforma_id = cp.id
      WHERE cp.company_id = ${companyId}
        AND cp.deleted_at IS NULL
        AND cp.is_active = true
        AND LOWER(TRIM(cpl.article_code)) = ${normalized}`);
  for (const row of matchingProformas.rows) {
    const proformaId = Number(row.id);
    if (Number.isSafeInteger(proformaId) && proformaId > 0) {
      await syncProformaReservations(db, companyId, proformaId);
    }
  }

  const inStockRow = firstRow<{ count: number | null }>(
    await db.execute(sql`SELECT COUNT(*)::int AS count
        FROM factory_bales
        WHERE company_id = ${companyId}
          AND LOWER(TRIM(article_code)) = ${normalized}
          AND status = 'IN_STOCK'`)
  );
  const inStock = Number(inStockRow?.count ?? 0);

  const reservedRow = firstRow<{ total: number | null }>(
    await db.execute(sql`SELECT COALESCE(SUM(reserved_qty),0)::int AS total
        FROM proforma_stock_reservations
        WHERE company_id = ${companyId}
          AND LOWER(TRIM(article_code)) = ${normalized}`)
  );
  const reservedNotYetLoaded = Number(reservedRow?.total ?? 0);
  return Math.max(0, inStock - reservedNotYetLoaded);
}
