import { cellFormula, cellResultText, cellText } from "../../lib/excelCellValue";
import { toArrayBuffer } from "../../lib/bufferCompatibility";
import ExcelJS from "exceljs";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import path from "path";
import fs from "fs";
import { db } from "../../db";
import { sql } from "drizzle-orm";

import {
  C_AVG_COL,
  C_NAME_COL,
  C_QTY_COL,
  C_VAL_COL,
  DaySales,
  EXCEL_ERRORS,
  E_CLOSING_QTY_COL,
  E_CLOSING_VAL_COL,
  E_CODE_COL,
  E_COST_BAG_COL,
  E_DATA_START,
  E_DATE_ROW,
  E_DATE_START,
  E_NAME_COL,
  E_OPENING_QTY_COL,
  E_TEMPLATE_MAX_DAYS,
  S_DATA_START,
  S_DATE_ROW,
  S_DATE_START,
  S_NAME_COL,
  SpSalesFormParams,
  addDays,
  colLetter,
  dateStr,
  isFormula,
  nk,
  pn,
  r2,
  r3,
  toUtcDate,
} from "./layout";

export async function generateSpSalesFormExcel(params: SpSalesFormParams): Promise<Buffer> {
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

  /**
   * Resolve any lookup key to a value, trying:
   *   1. Direct hit in map
   *   2. Via alias map (original key)
   *   3. Via alias map (normalized key)
   *   4. Direct hit on normalized key
   * Falls through all keys in order.
   */
  function resolveFromMap<V>(map: Map<string, V>, alias: Map<string, string>, ...keys: string[]): V | undefined {
    for (const k of keys) {
      if (!k) continue;
      if (map.has(k)) return map.get(k);
      const c = alias.get(k) ?? alias.get(nk(k));
      if (c && map.has(c)) return map.get(c);
      if (map.has(nk(k))) return map.get(nk(k));
    }
    return undefined;
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
  const _ageingWs = wb.getWorksheet("Ageing");
  const summaryIWs = wb.getWorksheet("Summary-Itemwise");

  if (!entryWs || !costingWs) throw new Error("ENTRY or Costing sheet missing from template");

  // ── Resolve actual item row ceiling dynamically ───────────────────────────
  // The attached template has 173 rows; old hardcoded E_DATA_END = 128 silently
  // dropped all items after row 128.  Use the sheet's own rowCount instead.
  const E_DATA_END = entryWs.rowCount;

  // ── Scan ENTRY rows 5–<actual>: build name → systemCode + row-number maps ──
  const nameToSystemCode = new Map<string, string>();
  const itemRows = new Map<string, number>();

  for (let r = E_DATA_START; r <= E_DATA_END; r++) {
    const row = entryWs.getRow(r);
    const nameCell = row.getCell(E_NAME_COL).value;
    const codeCell = row.getCell(E_CODE_COL).value;

    const rawName = cellText(nameCell);
    if (!rawName || rawName.startsWith("Total ")) continue;

    const systemCode = typeof codeCell === "string" && codeCell.trim() ? codeCell.trim() : rawName;

    nameToSystemCode.set(rawName, systemCode);
    // Also store under normalized key for case-insensitive Costing/Sales lookups
    if (nk(rawName) !== rawName) nameToSystemCode.set(nk(rawName), systemCode);
    itemRows.set(rawName, r);
  }

  // ── 1. Costing sheet: write opening stock ─────────────────────────────────
  // FIX: When qty = 0, also write 0 to the Avg Cost cell (G = C_AVG_COL).
  // The template formula there is =H/E. If both H and E are null/0, Excel
  // computes 0/0 = #DIV/0!, which then propagates to ENTRY col F (Cost/Bag)
  // and from there into the Closing Stock Value formula — causing the #DIV/0!
  // errors visible in the exported sheet. Overwriting with the plain value 0
  // replaces the formula entirely so Excel shows 0 instead of the error.
  const costingLastRow = costingWs.rowCount;
  for (let r = 2; r <= costingLastRow; r++) {
    const row = costingWs.getRow(r);
    const nameRaw = row.getCell(C_NAME_COL).value;
    const displayName = cellText(nameRaw);

    // For rows with no readable name (formula-name with null result), still
    // guard the avgCostCell to prevent #DIV/0! from an untouched =H/E formula.
    if (!displayName) {
      const avgCell = row.getCell(C_AVG_COL);
      if (isFormula(avgCell)) {
        avgCell.value = 0;
        row.commit();
      }
      continue;
    }

    if (displayName.startsWith("Total ") || displayName === "Inventory") continue;

    const systemCode = nameToSystemCode.get(displayName) ?? nameToSystemCode.get(nk(displayName)) ?? displayName;
    const stock = getOpening(displayName, systemCode);

    const qtyCell = row.getCell(C_QTY_COL);
    const avgCostCell = row.getCell(C_AVG_COL);
    const valCell = row.getCell(C_VAL_COL);

    if (!isFormula(qtyCell)) {
      qtyCell.value = stock.qty > 0 ? r3(stock.qty) : null;
    }
    if (!isFormula(valCell)) {
      const assetVal = stock.qty * stock.avgCost;
      valCell.value = assetVal > 0 ? r2(assetVal) : null;
    }

    // Avg Cost cell:
    //   • qty > 0 → write formula =H<r>/E<r> with the computed result as cached value.
    //               This stays formula-based (matches template) and is recalculated by Excel.
    //   • qty = 0 → write plain 0 to replace the =H/E formula; otherwise Excel shows #DIV/0!
    if (stock.qty > 0) {
      avgCostCell.value = { formula: `H${r}/E${r}`, result: r2(stock.avgCost) } as ExcelJS.CellFormulaValue;
    } else {
      avgCostCell.value = 0;
    }

    row.commit();
  }

  // ── 2. Sales sheet: write date row and item qty ───────────────────────────
  //
  // Sales date row structure (from template inspection):
  //   Col F (6)  = plain date (day 0) — we write fromDate here
  //   Cols G–L (7–12) = formula chain =F1+1, =G1+1, … — auto-compute dates 1–6
  //   Col M (13) onward = plain stale dates (2024-01-xx leftover from template)
  //
  // For days WITHIN the export range: only F1 needs to be written; formula
  // cells auto-chain from there.
  //
  // For days BEYOND the export range: ALL cells must be cleared, including the
  // formula chain cells (col 12 onward for a 6-day export).
  // The old code had `if (!isFormula(cell)) cell.value = null` which SKIPPED
  // the formula cells, leaving the chain alive and showing July 7, 8, 9…
  // Fix: always set value = null regardless of formula status.
  //
  // Sales data rows:
  //   No-sale days must be null (blank), not 0.  Writing 0 causes ambiguity
  //   when ENTRY SUMIFS formulas read the hidden Sales sheet — a 0-qty day
  //   is indistinguishable from a truly missing day.
  if (salesWs) {
    // Pre-sweep: nullify ALL sharedFormula slave cells in the Sales sheet before
    // making any other modifications.
    //
    // Why: the Sales sheet (like ENTRY) contains shared-formula chains.  When we
    // later write null to cells in "Total" rows (beyond the export range) we may
    // be clearing slave cells whose masters still reference them in ExcelJS's
    // internal shared-formula registry.  ExcelJS then throws "Shared Formula
    // master must exist above and or left of clone" during writeBuffer().
    //
    // Scope: ALL rows (date row + item rows + total rows), columns >= S_DATE_START.
    // Use row.getCell(c) column-by-column to force materialisation of every cell,
    // for the same reason as the ENTRY pre-sweep above.
    const salesLastCol = salesWs.columnCount;
    for (let r = S_DATE_ROW; r <= salesWs.rowCount; r++) {
      const row = salesWs.getRow(r);
      let rowChanged = false;
      for (let c = S_DATE_START; c <= salesLastCol; c++) {
        const cell = row.getCell(c);
        const v = cell.value;
        if (v && typeof v === "object" && "sharedFormula" in v) {
          cell.value = null;
          rowChanged = true;
        }
      }
      if (rowChanged) row.commit();
    }

    const sDateRow = salesWs.getRow(S_DATE_ROW);
    // Write fromDate to the plain anchor cell (F1 = col S_DATE_START).
    // Formula cells for d=1… auto-chain from F1 — do not overwrite them.
    for (let d = 0; d < effectiveDayCount; d++) {
      const cell = sDateRow.getCell(S_DATE_START + d);
      if (!isFormula(cell)) cell.value = addDays(startDate, d);
    }
    // Clear ALL cells beyond the export range — including formula-chain cells.
    // Using +40 to safely cover any template day-column extent.
    for (let d = effectiveDayCount; d < effectiveDayCount + 40; d++) {
      sDateRow.getCell(S_DATE_START + d).value = null;
    }
    sDateRow.commit();

    // Named rows (items + totals): write qty and clear beyond range.
    //
    // Loop design — two concerns kept separate:
    //   a) Data writing (within range): item rows only; "Total …" rows are
    //      aggregation rows whose in-range cells are formula-driven and must not
    //      be overwritten with raw qty values.
    //   b) Beyond-range clearing: ALL named rows, including "Total …" rows.
    //      "Total" rows contain formula cells (e.g. SUM chains) that, if left
    //      intact beyond toDate, survive in the hidden Sales sheet and can be
    //      picked up by ENTRY SUMIFS, producing phantom quantities.
    //      The clearing MUST NOT use the isFormula guard — formula cells must be
    //      nulled just like plain-value cells.
    //
    // Blank/unnamed rows are skipped entirely; they carry no formula data.
    const salesWsLast = salesWs.rowCount;
    for (let r = S_DATA_START; r <= salesWsLast; r++) {
      const row = salesWs.getRow(r);
      const nameRaw = row.getCell(S_NAME_COL).value;
      const displayName = cellText(nameRaw);

      // Completely skip blank/unnamed rows.
      if (!displayName) continue;

      // (a) Data writing — item rows only (not "Total …").
      if (!displayName.startsWith("Total ")) {
        const systemCode = nameToSystemCode.get(displayName) ?? nameToSystemCode.get(nk(displayName)) ?? displayName;
        const daySalesMap = getSalesMap(displayName, systemCode);

        for (let d = 0; d < effectiveDayCount; d++) {
          const cell = row.getCell(S_DATE_START + d);
          // Always overwrite — template formulas in item rows are stale data
          // that must be replaced with the actual sale qty (or null).
          // The old `if (isFormula(cell)) continue` guard was wrong here.
          const ds = daySalesMap?.get(dates[d]);
          cell.value = ds && ds.qty > 0 ? r3(ds.qty) : null;
        }
      }

      // (b) Beyond-range clearing — ALL named rows (items AND totals).
      for (let d = effectiveDayCount; d < effectiveDayCount + 40; d++) {
        row.getCell(S_DATE_START + d).value = null;
      }
      row.commit();
    }
  }

  // ── 3. ENTRY sheet ────────────────────────────────────────────────────────

  // Pre-sweep: nullify sharedFormula SLAVE cells in every item row of the
  // ENTRY sheet, limited to the date-block columns (col E_DATE_START onward).
  //
  // Why: ExcelJS throws "Shared Formula master must exist above and or left of
  // clone" if any slave's master cell is later replaced or cleared (even
  // replacing with another formula written as a plain {formula:...} object
  // counts as "changing" the master for ExcelJS's validator).
  //
  // Earlier versions only swept the profit column (baseCol+2) for the first
  // dayCount days; but templates with shared-formula chains spanning qty/price
  // columns (baseCol+0/+1) and days beyond the export range were still failing.
  //
  // Scope: we restrict to columns >= E_DATE_START to avoid touching static
  // formula columns (A–F: item name, cost/bag, opening stock totals, etc.)
  // that are not part of the per-day data block and should remain intact.
  //
  // IMPORTANT: do NOT use row.eachCell({ includeEmpty: false }) here.
  // That only iterates cells that ExcelJS has already materialised in its
  // in-memory row model.  Slave shared-formula cells that Excel omitted from
  // the XML (because their computed value was empty/zero) are absent from the
  // row's _cells array, so eachCell silently skips them.  ExcelJS's internal
  // shared-formula tracker still knows about those slaves via the master's
  // declared ref range, and writeBuffer() tries to write them — finding the
  // master gone and throwing "Shared Formula master must exist above and or
  // left of clone" (observed: cell AN134, col 40 = day-11 qty, row 134).
  //
  // Fix: iterate column-by-column with row.getCell(c), which FORCES
  // materialisation of every column in the date region regardless of whether
  // the underlying XML had a <c> element for it.
  const entryLastCol = entryWs.columnCount;
  for (let r = E_DATA_START; r <= E_DATA_END; r++) {
    const row = entryWs.getRow(r);
    let rowChanged = false;
    for (let c = E_DATE_START; c <= entryLastCol; c++) {
      const cell = row.getCell(c);
      const v = cell.value;
      if (v && typeof v === "object" && "sharedFormula" in v) {
        cell.value = null;
        rowChanged = true;
      }
    }
    if (rowChanged) row.commit();
  }

  // 3a. Date row (row 3)
  //
  // Template structure (confirmed from inspection):
  //   Day 0: cols G, H, I (7, 8, 9) = plain date cells → we write fromDate
  //   Day 1: cols J, K, L (10,11,12) = {formula:"G3+1"} → auto-compute fromDate+1
  //   Day 2: cols M, N, O (13,14,15) = {formula:"J3+1"} → auto-compute fromDate+2
  //   …each triplet references the previous triplet's first column (+1 day)
  //
  // Within export range (d < dayCount):
  //   Only write to plain cells (d=0 anchor); formula cells auto-chain.
  //
  // Beyond export range (d >= dayCount):
  //   MUST clear ALL cells including formula-chain cells.
  //   Old code had `if (!isFormula(cell)) cell.value = null` which SKIPPED the
  //   formula cells (since d>0 cells are formulas), leaving July 7, 8, 9…
  //   visible in the exported workbook.
  //   Fix: always null the cell regardless of formula status for d >= dayCount.
  const eDateRow = entryWs.getRow(E_DATE_ROW);
  for (let d = 0; d < effectiveDayCount; d++) {
    const dateVal = addDays(startDate, d);
    const baseCol = E_DATE_START + d * 3;
    for (let c = baseCol; c < baseCol + 3; c++) {
      const cell = eDateRow.getCell(c);
      if (!isFormula(cell)) cell.value = dateVal;
    }
  }
  // Clear date cells beyond the export range — stop at E_TEMPLATE_MAX_DAYS.
  // IMPORTANT: do NOT go past E_TEMPLATE_MAX_DAYS (18 days, ending at col 60).
  // The fixed Closing Stock columns (BJ=62, BK=63) immediately follow the
  // date section; the old `dayCount + 40` loop reached col 61-63 and wiped them.
  for (let d = effectiveDayCount; d < E_TEMPLATE_MAX_DAYS; d++) {
    const baseCol = E_DATE_START + d * 3;
    for (let c = baseCol; c < baseCol + 3; c++) {
      eDateRow.getCell(c).value = null;
    }
  }
  eDateRow.commit();

  // 3b. Item data rows
  //
  // Key rule: Qty (baseCol) and Sale Price (baseCol+1) are DATA OUTPUT cells,
  // not template formulas to preserve.  ALWAYS clear all 3 cells unconditionally
  // before writing, then only write if there is an actual posted SP sale for
  // that exact item/date.  The old `if (!isFormula(...)) cell.value = null` guard
  // was wrong — it silently kept stale template formulas alive, producing
  // phantom Qty/Price values and #DIV/0! on days with no sales.
  //
  // Profit/Bag (baseCol+2):
  //   Write as a standalone Excel FORMULA string only when a sale exists.
  //   The pre-sweep above already cleared all sharedFormula slaves.
  //
  // Opening Stock (col E) and Cost/Bag (col F):
  //   Written directly here so ExcelJS output is self-contained.
  //   The ENTRY sheet has SUMIFS formulas pointing at Costing; ExcelJS cannot
  //   recalculate those, so cached results can show blank/dash.  Writing the
  //   plain values ensures the profit formula $F<row> always has a real number.
  //
  // Closing Stock (col BJ=62, BK=63):
  //   Written directly as closingQty = openingQty − totalSoldInRange.
  //   Template formulas at those columns are unreliable for the same reason.
  //   CRITICAL: the "beyond range" clear loop below must stop at E_TEMPLATE_MAX_DAYS
  //   (col 60) — otherwise it overwrites the Closing Stock columns at 62-63.
  for (const [displayName, rowNum] of itemRows) {
    const systemCode = nameToSystemCode.get(displayName) ?? displayName;
    const daySalesMap = getSalesMap(displayName, systemCode);
    const stock = getOpening(displayName, systemCode);
    const row = entryWs.getRow(rowNum);

    // ── Opening Stock: write directly to ENTRY col E and F ──────────────────
    row.getCell(E_OPENING_QTY_COL).value = stock.qty > 0 ? r3(stock.qty) : null;
    // Always write 0 (not null) for avg cost when qty=0 to keep $F<row> numeric
    // and prevent #DIV/0! in the profit formula =IF(qty=0,0,price-$F<row>).
    row.getCell(E_COST_BAG_COL).value = stock.qty > 0 ? r2(stock.avgCost) : 0;

    // ── Date blocks ──────────────────────────────────────────────────────────
    let totalSoldInRange = 0;
    for (let d = 0; d < effectiveDayCount; d++) {
      const baseCol = E_DATE_START + d * 3;
      const qtyCell = row.getCell(baseCol);
      const priceCell = row.getCell(baseCol + 1);
      const profitCell = row.getCell(baseCol + 2);

      // Unconditional clear — data cells must never retain stale template formulas.
      qtyCell.value = null;
      priceCell.value = null;
      profitCell.value = null;

      const ds = daySalesMap?.get(dates[d]);
      if (ds && ds.qty > 0) {
        totalSoldInRange += ds.qty;
        const avgPrice = ds.totalSales / ds.qty;
        const deductionPerBag = ds.totalDeduction / ds.qty;
        const netProfitPB = (ds.totalSales - ds.totalCost - ds.totalDeduction) / ds.qty;

        qtyCell.value = r3(ds.qty);
        priceCell.value = r2(avgPrice);

        const qC = colLetter(baseCol);
        const pC = colLetter(baseCol + 1);
        const deductionPart = deductionPerBag !== 0 ? `-${r2(deductionPerBag)}` : "";
        profitCell.value = {
          formula: `IF(${qC}${rowNum}=0,0,${pC}${rowNum}-$F${rowNum}${deductionPart})`,
          result: r2(netProfitPB),
        } as ExcelJS.CellFormulaValue;
      }
      // No-sale day: all three cells remain null (already cleared above).
    }

    // ── Clear stale data beyond export range (date section only) ─────────────
    // Stop at E_TEMPLATE_MAX_DAYS — fixed Closing Stock columns (62, 63) follow
    // immediately and must NOT be overwritten here.
    for (let d = effectiveDayCount; d < E_TEMPLATE_MAX_DAYS; d++) {
      const baseCol = E_DATE_START + d * 3;
      row.getCell(baseCol).value = null; // qty
      row.getCell(baseCol + 1).value = null; // price
      row.getCell(baseCol + 2).value = null; // profit
    }

    // ── Closing Stock: compute and write directly ─────────────────────────────
    // closingQty = openingQty − total qty sold within the selected date range.
    // Do not rely on the template formula (ExcelJS cannot recalculate it).
    //
    // Zero-semantics: write 0 (not null) when opening stock > 0 and all bags
    // were sold.  This keeps downstream SUM/pivot formulas numeric.
    // When opening stock = 0 there is nothing to report — write null to leave
    // those cells blank (consistent with template expectation for new items).
    const closingQty = Math.max(0, stock.qty - totalSoldInRange);
    const closingValue = r2(closingQty * stock.avgCost);
    if (stock.qty > 0) {
      row.getCell(E_CLOSING_QTY_COL).value = r3(closingQty); // 0 when fully sold
      row.getCell(E_CLOSING_VAL_COL).value = closingValue; // 0.00 when fully sold
    } else {
      row.getCell(E_CLOSING_QTY_COL).value = null;
      row.getCell(E_CLOSING_VAL_COL).value = null;
    }

    row.commit();
  }

  // ── 4. Summary-Itemwise: B1 = toDate (VLOOKUP reference) ─────────────────
  if (summaryIWs) {
    const b1 = summaryIWs.getRow(1).getCell(2);
    if (!isFormula(b1)) b1.value = toUtcDate(toDate);
    summaryIWs.getRow(1).commit();
  }

  // ── 5. Sheet visibility ───────────────────────────────────────────────────
  // Match attached template exactly:
  //   Costing=hidden, Sales=hidden, ENTRY=visible, Summary=visible,
  //   Ageing=VISIBLE (template has it visible — do NOT hide it), Summary-Itemwise=hidden
  // The old code incorrectly set Ageing to "hidden". Removed.
  if (costingWs) costingWs.state = "hidden";
  if (salesWs) salesWs.state = "hidden";
  if (summaryIWs) summaryIWs.state = "hidden";
  // ENTRY, Summary, Ageing: leave as visible (template default)

  // ── 6. Sales sheet alignment check ────────────────────────────────────────
  // ENTRY BM formulas read the hidden Sales sheet via INDIRECT/SUMIFS on Sales!$1:$1.
  // Alignment requires:
  //   (a) Sales date-row starts at the same column offset as written (S_DATE_START = F = col 6).
  //   (b) Sales has enough date columns for the full dayCount.
  //   (c) First date written into Sales!F1 matches the export fromDate.
  //   (d) Item name column in Sales (col C = S_NAME_COL) matches ENTRY col C (E_NAME_COL).
  //   (e) ENTRY BM formula sample references "Sales!" — confirm the sheet is not renamed.
  if (salesWs) {
    const mismatches: string[] = [];

    // (a) Column offset
    if (S_DATE_START !== 6) {
      mismatches.push(`S_DATE_START=${S_DATE_START} expected 6 (col F); ENTRY BM uses Sales!$1:$1 starting F`);
    }

    // (b) Capacity
    const salesCapacity = salesWs.columnCount - S_DATE_START + 1;
    if (dayCount > salesCapacity) {
      mismatches.push(`capacity: export=${dayCount} days, Sales only has ${salesCapacity} date columns (F1 onward)`);
    }

    // (c) First date cell in Sales row 1 vs fromDate
    const firstDateCell = salesWs.getRow(S_DATE_ROW).getCell(S_DATE_START);
    const firstDateVal = firstDateCell.value;
    const firstDateWritten =
      firstDateVal instanceof Date
        ? firstDateVal.toISOString().slice(0, 10)
        : typeof firstDateVal === "string"
          ? firstDateVal.slice(0, 10)
          : null;
    if (firstDateWritten && firstDateWritten !== fromDate) {
      mismatches.push(
        `Sales!F1 date="${firstDateWritten}" does not match fromDate="${fromDate}"; ` +
          `SUMIFS date range will be offset`
      );
    }

    // (d) Name column alignment
    if (S_NAME_COL !== E_NAME_COL) {
      mismatches.push(
        `name column mismatch: Sales uses col ${S_NAME_COL}, ENTRY uses col ${E_NAME_COL}; ` +
          `item lookup by row reference may fail`
      );
    }

    // (e) Verify a sample ENTRY BM formula actually references "Sales!"
    const bmColIdx = 65; // BM = column 65
    let bmFormulaChecked = false;
    for (let r = E_DATA_START; r <= Math.min(E_DATA_START + 5, E_DATA_END); r++) {
      const bmCell = entryWs.getRow(r).getCell(bmColIdx);
      const fmla = cellFormula(bmCell.value);
      if (fmla) {
        if (!fmla.includes("Sales!")) {
          mismatches.push(
            `ENTRY!BM${r} formula "${fmla}" does not reference "Sales!" — ` +
              `sheet may have been renamed or formula structure changed`
          );
        }
        bmFormulaChecked = true;
        break;
      }
    }
    if (!bmFormulaChecked) {
      mismatches.push(
        `No BM formula found in ENTRY rows ${E_DATA_START}–${E_DATA_START + 5}; template may be missing Avg Monthly Sales column`
      );
    }

    if (mismatches.length > 0) {
      logger.warn(
        `[spSalesFormExport] Sales alignment issues (${mismatches.length}):\n` +
          mismatches.map((m, i) => `  ${i + 1}. ${m}`).join("\n")
      );
    } else {
      logger.info(
        `[spSalesFormExport] Sales alignment OK — ${dayCount} day(s), F1=${firstDateWritten ?? fromDate}, BM formula references Sales!`
      );
    }
  }

  // ── 7. Output ─────────────────────────────────────────────────────────────
  const rawBuf = await wb.xlsx.writeBuffer();
  const buf = Buffer.from(new Uint8Array(rawBuf));

  // ── 8. Post-export formula error scan ─────────────────────────────────────
  // Re-read the generated buffer and scan every cell result for Excel error strings.
  // If any critical sheet contains errors, fail loudly instead of sending a broken file.
  try {
    const wbCheck = new ExcelJS.Workbook();
    await wbCheck.xlsx.load(toArrayBuffer(buf));
    const errorsBySheet: Record<string, string[]> = {};
    for (const ws of wbCheck.worksheets) {
      ws.eachRow({ includeEmpty: false }, (row) => {
        row.eachCell({ includeEmpty: false }, (cell) => {
          // Text results only: an error cached as `{ error: "#DIV/0!" }` is not
          // text and is missed here — see `cellResultText`.
          const result = cellResultText(cell.value);
          if (result !== null && EXCEL_ERRORS.some((e) => result.includes(e))) {
            (errorsBySheet[ws.name] ??= []).push(`${ws.name}!${cell.address}: ${result}`);
          }
        });
      });
    }

    const allErrors = Object.entries(errorsBySheet).flatMap(([, errs]) => errs);
    if (allErrors.length > 0) {
      logger.warn(`[spSalesFormExport] Formula errors detected (all sheets):`, { errors: allErrors });
    }

    // NOTE: ExcelJS reads cached formula results embedded at write-time; it does not
    // recalculate.  This catches errors baked into the template cache or explicitly
    // written as result values.  Errors that only appear after Excel recalculates on
    // open cannot be detected here — but cached errors always indicate a real problem
    // (broken template cell, bad opening-stock write, missing data, etc.) so we fail.
    const criticalSheets = ["ENTRY", "Costing", "Summary", "Ageing", "Summary-Itemwise"];
    const criticalErrors = criticalSheets.flatMap((s) => errorsBySheet[s] ?? []);
    if (criticalErrors.length > 0) {
      throw new Error(
        `SP Sales Form export aborted — formula errors in critical sheets:\n` + criticalErrors.slice(0, 20).join("\n")
      );
    }
  } catch (scanErr: unknown) {
    // Re-throw export-abort errors; swallow scan infrastructure failures only.
    if (getErrorMessage(scanErr)?.startsWith("SP Sales Form export aborted")) throw scanErr;
    logger.error("[spSalesFormExport] Error scan failed (non-critical):", { error: getErrorMessage(scanErr) });
  }

  return buf;
}
