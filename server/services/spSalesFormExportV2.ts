import { styleSpecializedWorkbook } from "@shared/universal-excel/specializedWorkbookStyle";
import { loadCompanyExcelAppearance } from "./excelAppearanceSettings";
/**
 * SP Sales Form Export — V2 (from-scratch ExcelJS, no template)
 *
 * Data sources:
 *   Opening stock : calculateHistoricalLocationInventory(locationId, companyId, dayBefore(fromDate))
 *                   — same helper that powers the Location Inventory page, so opening stock here
 *                   always agrees with what Location Inventory shows as-of that date.
 *   Closing stock : calculateHistoricalLocationInventory(locationId, companyId, toDate)
 *                   — same helper, as-of toDate, for the same reason.
 *   Daily sales   : sales_items + vouchers (ERP POS) — this is the real posted Supplier Partner
 *                   sales source. sp_sales/sp_sale_lines were checked and are NOT used for
 *                   posted POS sales; sales_items/vouchers is the source the live system posts to
 *                   (WHERE voucher_type='Sales' AND optional=false AND deleted_at IS NULL), which
 *                   is the same source calculateHistoricalLocationInventory reverses out of its
 *                   as-of-date snapshot, guaranteeing opening − sales + offloads ≈ closing.
 *   Opening cash  : voucher_entries SUM(debit-credit) as of dayBefore(fromDate) for cashAccountId
 *
 * Sheet order (3 sheets):
 *   1. Costing          — hidden
 *   2. Sales            — hidden
 *   3. ENTRY            — visible  ← main page (includes Group/category column)
 *
 * Implementation is split across server/services/sp-sales-form-v2/ — this file only
 * orchestrates: accept params, build date list, call data fetchers, build item
 * registry, create the workbook, call sheet builders in order, scan for errors,
 * return the buffer.
 */

import ExcelJS from "exceljs";
import { logger } from "../lib/logger";
import { SpSalesFormV2Params } from "./sp-sales-form-v2/types";
import { toUtcDate, addDays, dateStr } from "./sp-sales-form-v2/dateHelpers";
import { fetchInventory, fetchSalesData, fetchCashAccountBalance } from "./sp-sales-form-v2/dataFetchers";
import { buildItemRegistry } from "./sp-sales-form-v2/itemRegistry";
import { buildCostingSheet } from "./sp-sales-form-v2/buildCostingSheet";
import { buildSalesSheet } from "./sp-sales-form-v2/buildSalesSheet";
import { buildEntrySheet } from "./sp-sales-form-v2/buildEntrySheet";
import { scanErrors } from "./sp-sales-form-v2/workbookErrorScanner";

export type { SpSalesFormV2Params } from "./sp-sales-form-v2/types";

// ── Main export function ──────────────────────────────────────────────────────
export async function generateSpSalesFormExcelV2(params: SpSalesFormV2Params): Promise<Buffer> {
  const { companyId, locationId, fromDate, toDate, cashAccountId } = params;

  logger.info(
    `[spSalesFormExportV2] start companyId=${companyId} locationId=${locationId ?? "all"} ${fromDate}→${toDate}`
  );

  // Build date list
  const startDate = toUtcDate(fromDate);
  const endDate = toUtcDate(toDate);
  const dayCount = Math.max(1, Math.round((endDate.getTime() - startDate.getTime()) / 86_400_000) + 1);
  const dates = Array.from({ length: dayCount }, (_, i) => dateStr(addDays(startDate, i)));
  const dayBefore = dateStr(addDays(startDate, -1));

  // Fetch all data in parallel
  const [openMap, closeMap, salesRows, openingCashBalance] = await Promise.all([
    fetchInventory(companyId, locationId, dayBefore),
    fetchInventory(companyId, locationId, toDate),
    fetchSalesData(companyId, locationId, fromDate, toDate),
    cashAccountId ? fetchCashAccountBalance(cashAccountId, companyId, dayBefore) : Promise.resolve(null),
  ]);
  logger.info(
    `[spSalesFormExportV2] cashAccountId=${cashAccountId ?? "none"} openingCashBalance=${openingCashBalance ?? "n/a (manual)"}`
  );
  logger.info(
    `[spSalesFormExportV2] openItems=${openMap.size} closeItems=${closeMap.size} saleRows=${salesRows.length} dayCount=${dayCount}`
  );

  // Build item registry
  const items = buildItemRegistry(openMap, closeMap, salesRows, dayCount);

  logger.info(`[spSalesFormExportV2] totalItems=${items.length}`);

  // Build workbook (sheet order per spec)
  const wb = new ExcelJS.Workbook();
  wb.creator = "System SP Export V2";
  wb.created = new Date();
  wb.modified = new Date();
  // Force full recalculation when Excel opens the file
  wb.calcProperties = { fullCalcOnLoad: true };

  buildCostingSheet(wb, items); // 1. Costing — hidden
  buildSalesSheet(wb, items, dates); // 2. Sales — hidden
  await buildEntrySheet(wb, items, dates, dayCount, params, openingCashBalance); // 3. ENTRY — visible (async for ws.protect)

  // Error scan — fail fast on visible-sheet errors
  const errors = scanErrors(wb);
  if (errors.length > 0) {
    const detail = errors.map((e) => `${e.sheet}!${e.cell}: ${e.value}`).join(", ");
    logger.error(`[spSalesFormExportV2] Excel errors found: ${detail}`);
    throw new Error(`Excel formula errors detected in export: ${detail}`);
  }

  // Preserve protected ENTRY positions and hidden Costing/Sales formula sheets.
  // This adds print branding to the visible report only, without restyling
  // entry cells or changing formula recalculation / sheet protection.
  styleSpecializedWorkbook(wb, {
    appearance: await loadCompanyExcelAppearance(companyId),
    expectedSheetNames: ["Costing", "Sales", "ENTRY"],
    sheets: [
      { name: "Costing", purpose: "formula-support" },
      { name: "Sales", purpose: "formula-support" },
      { name: "ENTRY", purpose: "report" },
    ],
  });
  const buf = await wb.xlsx.writeBuffer();
  logger.info(`[spSalesFormExportV2] done bufferSize=${buf.byteLength}`);
  return Buffer.from(buf);
}
