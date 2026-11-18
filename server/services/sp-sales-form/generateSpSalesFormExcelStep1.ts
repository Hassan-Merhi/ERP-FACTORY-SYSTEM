// Extracted from ./generate.ts to keep that module under the source-size cap.
import ExcelJS from "exceljs";
import { logger } from "../../lib/logger";
import path from "path";
import fs from "fs";
import { db } from "../../db";
import { sql } from "drizzle-orm";
import {
  addDays,
  dateStr,
  DaySales,
  E_DATE_START,
  E_TEMPLATE_MAX_DAYS,
  nk,
  pn,
  S_DATE_START,
  SpSalesFormParams,
  toUtcDate,
} from "./layout";
import { resolveFromMap } from "./generateResolveFromMap";

export async function generateSpSalesFormExcelStep1(params: SpSalesFormParams) {
  logger.info("RUNNING NEW SP EXPORT FIX 2026-07-06 DIRECT ENTRY WRITE");
  const { companyId, fromDate, toDate, locationId } = params;

  // Build conditional location SQL fragments — injected into both queries below.
  // When locationId is a positive integer, restrict to that location.
  // When absent / falsy, keep existing all-location behaviour.
  const salesLocFilter = locationId ? sql` AND mv.location_id = ${locationId}` : sql``;
  const openingLocFilter = locationId ? sql` AND sm.location_id = ${locationId}` : sql``;

  const templatePath = path.join(process.cwd(), "server", "templates", "supplier_partner_sales_form_template.xlsx");
  if (!fs.existsSync(templatePath)) {
    throw new Error("Template not found: server/templates/supplier_partner_sales_form_template.xlsx");
  }

  // ── Build date list ────────────────────────────────────────────────────────
  const startDate = toUtcDate(fromDate);
  const endDate = toUtcDate(toDate);
  const dayCount = Math.max(1, Math.round((endDate.getTime() - startDate.getTime()) / 86_400_000) + 1);
  const dates: string[] = Array.from({ length: dayCount }, (_, i) => dateStr(addDays(startDate, i)));

  // ── Capacity guard ─────────────────────────────────────────────────────────
  // The ENTRY template has exactly E_TEMPLATE_MAX_DAYS date slots.  Writing
  // beyond that would corrupt the fixed columns (Closing Stock, Ageing, etc.)
  // that follow immediately.  Clamp the effective write count; log a warning
  // if the requested range is longer so the caller can investigate.
  const effectiveDayCount = Math.min(dayCount, E_TEMPLATE_MAX_DAYS);
  if (dayCount > E_TEMPLATE_MAX_DAYS) {
    logger.warn(
      `[spSalesFormExport] WARNING: requested ${dayCount} days exceeds template ` +
        `capacity (${E_TEMPLATE_MAX_DAYS} days). Export will be clamped to ` +
        `${E_TEMPLATE_MAX_DAYS} days; data beyond ${dates[E_TEMPLATE_MAX_DAYS - 1]} is dropped.`
    );
  }

  // ── Diagnostic log (confirms the server is running the latest code) ────────
  logger.info(
    `[spSalesFormExport] fromDate=${fromDate} toDate=${toDate} dayCount=${dayCount}` +
      ` effectiveDayCount=${effectiveDayCount} locationId=${locationId ?? "none"}` +
      ` firstClearedENTRYdateBlockCol=${E_DATE_START + effectiveDayCount * 3} (dayIndex=${effectiveDayCount})` +
      ` firstClearedSalesDateCol=${S_DATE_START + effectiveDayCount}`
  );

  // ── DB queries ─────────────────────────────────────────────────────────────
  const [salesRes, openingRes] = await Promise.all([
    // ── Query 1: daily SP sales within the export range ─────────────────────
    // • article_code normalized via stock_item_code_aliases → stock_items.code
    // • per-qty deduction: sp_sale_lines.movement_id → sp_stock_movements.location_id
    //     → locations.supplier_partner_payable_deduction_per_qty
    // • raw_article_code + item_name returned for multi-key alias lookup
    db.execute(sql`
      SELECT
        COALESCE(si.code, sl.article_code)                                            AS item_code,
        MAX(sl.article_code)                                                          AS raw_article_code,
        MAX(si.name)                                                                  AS item_name,
        s.sale_date::text                                                             AS sale_date,
        SUM(sl.qty_sold)::numeric                                                     AS qty,
        SUM(sl.qty_sold * sl.sale_price_per_unit)::numeric                            AS total_sales,
        SUM(sl.qty_sold * sl.final_unit_cost_usd)::numeric                            AS total_cost,
        SUM(sl.qty_sold * COALESCE(l.supplier_partner_payable_deduction_per_qty, 0))
          ::numeric                                                                   AS total_deduction
      FROM  sp_sale_lines          sl
      JOIN  sp_sales               s    ON sl.sale_id     = s.id
      LEFT  JOIN sp_stock_movements mv  ON mv.id          = sl.movement_id
      LEFT  JOIN locations          l   ON l.id           = mv.location_id
      LEFT  JOIN stock_item_code_aliases sica
                                        ON sica.alias_code  = sl.article_code
                                       AND sica.company_id  = sl.company_id
      LEFT  JOIN stock_items        si  ON si.id          = sica.stock_item_id
      WHERE sl.company_id = ${companyId}
        AND s.status      = 'posted'
        AND s.sale_date BETWEEN ${fromDate}::date AND ${toDate}::date
        ${salesLocFilter}
      GROUP BY COALESCE(si.code, sl.article_code), s.sale_date
      ORDER BY s.sale_date
    `),

    // ── Query 2: point-in-time opening stock at START of fromDate ───────────
    // Opening stock = stock available BEFORE fromDate begins.
    // Uses s.sale_date < fromDate (strict less-than) so sales on fromDate itself
    // are NOT deducted from opening stock — they belong to the export period.
    // For every lot created on or before the day before fromDate:
    //   opening_qty = MAX(qty_in − qty_sold_before_fromDate, 0)
    db.execute(sql`
      WITH sold_before AS (
        SELECT
          sl.movement_id,
          SUM(sl.qty_sold) AS qty
        FROM  sp_sale_lines sl
        JOIN  sp_sales       s ON sl.sale_id = s.id
        WHERE sl.company_id = ${companyId}
          AND s.status      = 'posted'
          AND s.sale_date   < ${fromDate}::date
        GROUP BY sl.movement_id
      ),
      lot_opening AS (
        SELECT
          sm.article_code,
          sm.company_id,
          sm.final_unit_cost_usd,
          GREATEST(
            sm.qty_in::numeric - COALESCE(sb.qty, 0)::numeric,
            0
          ) AS opening_qty
        FROM  sp_stock_movements sm
        LEFT  JOIN sold_before sb ON sb.movement_id = sm.id
        WHERE sm.company_id     = ${companyId}
          AND sm.created_at::date <= ${fromDate}::date
          ${openingLocFilter}
      )
      SELECT
        COALESCE(si.code, lo.article_code)  AS item_code,
        MAX(lo.article_code)                AS raw_article_code,
        MAX(si.name)                        AS item_name,
        SUM(lo.opening_qty)::numeric        AS qty,
        CASE WHEN SUM(lo.opening_qty) > 0
             THEN SUM(lo.opening_qty * lo.final_unit_cost_usd::numeric)
                  / SUM(lo.opening_qty)
             ELSE 0
        END::numeric                        AS avg_cost
      FROM  lot_opening                    lo
      LEFT  JOIN stock_item_code_aliases   sica
                                           ON sica.alias_code = lo.article_code
                                          AND sica.company_id = lo.company_id
      LEFT  JOIN stock_items               si ON si.id = sica.stock_item_id
      GROUP BY COALESCE(si.code, lo.article_code)
    `),
  ]);

  const salesRows = salesRes.rows;
  const openingRows = openingRes.rows;

  // ── Build in-memory data structures ──────────────────────────────────────
  //
  // Strategy: store primary data under the resolved item_code, then build
  // alias maps (resolved/raw/name → canonical key, normalized variants too)
  // for multi-key lookup.  This avoids double-counting while supporting
  // matching by article_code, stock_items.code, stock_items.name, or any
  // normalized case variant.

  // ── Sales data ──────────────────────────────────────────────────────────
  // Primary: resolved item_code → dateStr → DaySales
  const salesData = new Map<string, Map<string, DaySales>>();
  // Alias: any key variant → canonical resolved item_code
  const salesAlias = new Map<string, string>();

  for (const r of salesRows) {
    const resolved = String(r.item_code ?? "").trim();
    if (!resolved) continue;
    const dateKey = String(r.sale_date).slice(0, 10);

    if (!salesData.has(resolved)) salesData.set(resolved, new Map());
    const dm = salesData.get(resolved)!;
    const prev = dm.get(dateKey) ?? { qty: 0, totalSales: 0, totalCost: 0, totalDeduction: 0 };
    dm.set(dateKey, {
      qty: prev.qty + pn(r.qty),
      totalSales: prev.totalSales + pn(r.total_sales),
      totalCost: prev.totalCost + pn(r.total_cost),
      totalDeduction: prev.totalDeduction + pn(r.total_deduction),
    });

    // Register all alias variants (resolved code, raw article code, item name)
    for (const k of [resolved, String(r.raw_article_code ?? "").trim(), String(r.item_name ?? "").trim()]) {
      if (!k) continue;
      salesAlias.set(k, resolved);
      salesAlias.set(nk(k), resolved);
    }
  }

  // ── Opening data ─────────────────────────────────────────────────────────
  const openingData = new Map<string, { qty: number; avgCost: number }>();
  const openingAlias = new Map<string, string>();

  for (const r of openingRows) {
    const resolved = String(r.item_code ?? "").trim();
    if (!resolved) continue;
    openingData.set(resolved, { qty: pn(r.qty), avgCost: pn(r.avg_cost) });

    for (const k of [resolved, String(r.raw_article_code ?? "").trim(), String(r.item_name ?? "").trim()]) {
      if (!k) continue;
      openingAlias.set(k, resolved);
      openingAlias.set(nk(k), resolved);
    }
  }

  /** Opening stock for an item — try all key variants. */
  const getOpening = (displayName: string, systemCode: string) =>
    resolveFromMap(openingData, openingAlias, displayName, systemCode) ?? { qty: 0, avgCost: 0 };

  /** DaySales map for an item — try all key variants. */
  const getSalesMap = (displayName: string, systemCode: string) =>
    resolveFromMap(salesData, salesAlias, displayName, systemCode);

  // ── Load workbook ─────────────────────────────────────────────────────────
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(templatePath);
  wb.calcProperties.fullCalcOnLoad = true;

  const entryWs = wb.getWorksheet("ENTRY");
  const costingWs = wb.getWorksheet("Costing");
  const salesWs = wb.getWorksheet("Sales");
  const summaryIWs = wb.getWorksheet("Summary-Itemwise");

  if (!entryWs || !costingWs) throw new Error("ENTRY or Costing sheet missing from template");

  // ── Resolve actual item row ceiling dynamically ───────────────────────────
  // The attached template has 173 rows; old hardcoded E_DATA_END = 128 silently
  // dropped all items after row 128.  Use the sheet's own rowCount instead.
  const E_DATA_END = entryWs.rowCount;

  // ── Scan ENTRY rows 5–<actual>: build name → systemCode + row-number maps ──
  const nameToSystemCode = new Map<string, string>();
  const itemRows = new Map<string, number>();
  return {
    E_DATA_END,
    costingWs,
    dates,
    dayCount,
    effectiveDayCount,
    entryWs,
    fromDate,
    getOpening,
    getSalesMap,
    itemRows,
    nameToSystemCode,
    salesWs,
    startDate,
    summaryIWs,
    toDate,
    wb,
  };
}
