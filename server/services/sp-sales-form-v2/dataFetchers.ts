import { db } from "../../db";
import { logger } from "../../lib/logger";
import { sql } from "drizzle-orm";
import { calculateHistoricalLocationInventory } from "../../routes/helpers/inventoryHistoryHelpers";
import { pn } from "./styleHelpers";
import { InvEntry } from "./types";

type QueryRecord = Record<string, unknown>;
type QueryResultLike = { rows: QueryRecord[] };

function queryRows(result: QueryResultLike | QueryRecord[]): QueryRecord[] {
  return Array.isArray(result) ? result : result.rows;
}

export async function fetchInventory(
  companyId: number,
  locationId: number | undefined,
  asOfDate: string
): Promise<Map<number, InvEntry>> {
  const result = new Map<number, InvEntry>();

  let locationIds: number[];
  if (locationId) {
    locationIds = [locationId];
  } else {
    const res = await db.execute(sql`SELECT id FROM locations WHERE company_id = ${companyId} AND deleted_at IS NULL`);
    locationIds = queryRows(res).map((r) => Number(r.id));
  }

  // TEMP DEBUG (historical opening-stock audit): confirm which locations feed
  // this as-of-date snapshot, and how many are aggregated for "All Locations".
  // Gated behind DEBUG_HISTORICAL_INVENTORY=1 to keep routine exports quiet.
  if (process.env.DEBUG_HISTORICAL_INVENTORY === "1") {
    logger.info(
      `[spSalesFormExportV2:fetchInventory] asOfDate=${asOfDate} locationId=${locationId ?? "all"} locationsIncluded=${locationIds.length} [${locationIds.join(",")}]`
    );
  }

  await Promise.all(
    locationIds.map(async (locId) => {
      const rows = await calculateHistoricalLocationInventory(locId, companyId, asOfDate);
      for (const row of rows) {
        const qty = pn(row.quantity),
          val = pn(row.totalValue),
          rate = pn(row.averageRate);
        const ex = result.get(row.stockItemId);
        if (!ex) {
          result.set(row.stockItemId, {
            stockItemId: row.stockItemId,
            stockItemCode: row.stockItemCode ?? "",
            stockItemName: row.stockItemName ?? "",
            stockGroupName: row.stockGroupName ?? "",
            stockItemUom: row.stockItemUom ?? "",
            quantity: qty,
            averageRate: rate,
            totalValue: val,
          });
        } else {
          const newQty = ex.quantity + qty,
            newVal = ex.totalValue + val;
          ex.quantity = newQty;
          ex.totalValue = newVal;
          ex.averageRate = newQty > 0 ? newVal / newQty : 0;
          if (!ex.stockGroupName && row.stockGroupName) ex.stockGroupName = row.stockGroupName;
        }
      }
    })
  );

  return result;
}

export async function fetchSalesData(
  companyId: number,
  locationId: number | undefined,
  fromDate: string,
  toDate: string
): Promise<
  Array<{
    stockItemId: number;
    itemCode: string;
    itemName: string;
    groupName: string;
    uom: string;
    saleDate: string;
    qty: number;
    totalSales: number;
    totalCost: number;
    totalDeduction: number;
  }>
> {
  const locFilter = locationId ? sql` AND v.location_id = ${locationId}` : sql``;
  const res = await db.execute(sql`
    SELECT
      si.stock_item_id                                     AS stock_item_id,
      sk.code                                              AS item_code,
      sk.name                                              AS item_name,
      COALESCE(sg.name, '')                                AS group_name,
      COALESCE(sk.uom, '')                                 AS uom,
      v.voucher_date::text                                 AS sale_date,
      SUM(si.quantity)::numeric                            AS qty,
      SUM(si.total_sales)::numeric                         AS total_sales,
      SUM(si.total_cost)::numeric                          AS total_cost,
      SUM(
        si.quantity * COALESCE(l.supplier_partner_payable_deduction_per_qty, 0)
      )::numeric                                           AS total_deduction
    FROM  sales_items  si
    JOIN  vouchers     v  ON v.id  = si.voucher_id
    JOIN  stock_items  sk ON sk.id = si.stock_item_id
    LEFT  JOIN stock_groups sg ON sg.id = sk.stock_group_id
    LEFT  JOIN locations     l  ON l.id = v.location_id
                                 AND l.company_id = v.company_id
    WHERE v.company_id   = ${companyId}
      AND v.deleted_at   IS NULL
      AND v.voucher_type = 'Sales'
      AND v.optional     = false
      AND v.voucher_date BETWEEN ${fromDate}::date AND ${toDate}::date
      ${locFilter}
    GROUP BY si.stock_item_id, sk.code, sk.name, COALESCE(sg.name,''), COALESCE(sk.uom,''), v.voucher_date
    ORDER BY COALESCE(sg.name,''), sk.name, v.voucher_date
  `);
  return queryRows(res).map((r) => ({
    stockItemId: Number(r.stock_item_id),
    itemCode: String(r.item_code ?? ""),
    itemName: String(r.item_name ?? ""),
    groupName: String(r.group_name ?? ""),
    uom: String(r.uom ?? ""),
    saleDate: String(r.sale_date),
    qty: pn(r.qty),
    totalSales: pn(r.total_sales),
    totalCost: pn(r.total_cost),
    totalDeduction: pn(r.total_deduction),
  }));
}

// ── Ageing: best-available last-inbound-movement date per stock item ─────────
// There is no per-lot/FIFO ageing tracked anywhere in the schema. The best
// available real signal for "when did this stock last arrive at this
// location" is the later of:
//   1. container_offload_items.offload_id → container_offloads.offloaded_at
//      (stock offloaded from a container into this location)
//   2. stock_transfer_items → stock_transfer_vouchers.created_at, filtered to
//      transfers whose destination is this location (stock moved in from
//      another location)
// This is a documented fallback, not fabricated data — if neither source has
// a record for an item (e.g. stock predates both tables or was adjusted in
// directly), we do not guess a date; the item's full closing qty is placed in
// the 121+ bucket, which is called out explicitly via the "Ageing Basis"
// column so a reviewer knows it is undetermined rather than confirmed-old.

// ── Cash account opening balance ─────────────────────────────────────────────
export async function fetchCashAccountBalance(accountId: number, companyId: number, asOfDate: string): Promise<number> {
  const res = await db.execute(sql`
    SELECT COALESCE(SUM(ve.debit_amount - ve.credit_amount), 0) AS balance
    FROM   voucher_entries ve
    JOIN   vouchers        v  ON v.id = ve.voucher_id
    WHERE  ve.ledger_account_id = ${accountId}
      AND  v.company_id         = ${companyId}
      AND  v.voucher_date       <= ${asOfDate}::date
      AND  v.deleted_at        IS NULL
  `);
  return pn(queryRows(res)[0]?.balance ?? 0);
}
