/**
 * Spreadsheet stock imports and back-dated stock entries against the
 * perpetual cut-over (accounting audit wave 18 C, owner decision).
 *
 * Bale reimport, bale import and raw-stock import create stock value from a
 * spreadsheet, with no journal and no cost evidence:
 *   - before the company's perpetual cut-over is applied they are allowed, to
 *     Admin/Owner (Developer passes), audited in their transaction, and the
 *     readiness report lists what they brought in as rows imported at the
 *     spreadsheet's cost (`importedAtSpreadsheetCostTx`);
 *   - once the cut-over is applied they are refused (409
 *     FACTORY_STOCK_IMPORT_AFTER_CUTOVER): the opening journal is fixed at the
 *     apply, so stock must enter through costed receipts and mixes.
 *
 * A stock entry tests the cut-over against the company's business date
 * (companyBusinessDate.ts), not the date the client sends: once the cut-over
 * applies on the business date, an entry dated before the cut-over date is
 * refused (409 FACTORY_STOCK_ENTRY_BEFORE_CUTOVER) — it would add stock to a
 * period the opening already valued.
 */
import { sql } from "drizzle-orm";

import type { DatabaseOrTransaction } from "../../db";
import { HttpError } from "../../lib/httpHandlers";
import { toMoney } from "../../lib/money";
import { companyBusinessDate } from "../accounting/companyBusinessDate";
import { getInventoryCutover } from "../accounting/perpetualInventory/cutover";

export const FACTORY_STOCK_IMPORT_AFTER_CUTOVER = "FACTORY_STOCK_IMPORT_AFTER_CUTOVER" as const;
export const FACTORY_STOCK_ENTRY_BEFORE_CUTOVER = "FACTORY_STOCK_ENTRY_BEFORE_CUTOVER" as const;

/** The audit `table_name` / `action` that marks a raw-stock row brought in by the raw-stock import. */
export const RAW_STOCK_IMPORT_AUDIT = { tableName: "factory_raw_stock", action: "import" } as const;

export function stockImportAfterCutoverMessage(effectiveFrom: string): string {
  return `Perpetual inventory applies from ${effectiveFrom}: stock cannot be imported from a spreadsheet. Enter it through costed receipts and mixes.`;
}

export function stockEntryBeforeCutoverMessage(effectiveFrom: string): string {
  return `Perpetual inventory applies from ${effectiveFrom}: a stock entry cannot be dated before it.`;
}

export class FactoryStockImportAfterCutoverError extends HttpError {
  readonly code = FACTORY_STOCK_IMPORT_AFTER_CUTOVER;
  constructor(readonly effectiveFrom: string) {
    super(409, stockImportAfterCutoverMessage(effectiveFrom));
    this.name = "FactoryStockImportAfterCutoverError";
  }
}

export class FactoryStockEntryBeforeCutoverError extends HttpError {
  readonly code = FACTORY_STOCK_ENTRY_BEFORE_CUTOVER;
  constructor(
    readonly effectiveFrom: string,
    readonly entryDate: string
  ) {
    super(409, stockEntryBeforeCutoverMessage(effectiveFrom));
    this.name = "FactoryStockEntryBeforeCutoverError";
  }
}

/** Refuses a spreadsheet stock import once the company's cut-over is applied. */
export async function assertStockImportAllowedTx(executor: DatabaseOrTransaction, companyId: number): Promise<void> {
  const cutover = await getInventoryCutover(executor, companyId);
  if (cutover && cutover.status === "ACTIVE") throw new FactoryStockImportAfterCutoverError(cutover.effectiveFrom);
}

/**
 * Whether the cut-over applies to a stock entry: tested on the later of the
 * entry date and the company's business date, so a client cannot leave
 * perpetual inventory by sending an earlier date. Refuses an entry dated
 * before the cut-over date once the cut-over applies on the business date.
 */
export async function stockEntryCutoverTx(
  executor: DatabaseOrTransaction,
  companyId: number,
  entryDate: string
): Promise<{ perpetual: boolean; businessDate: string }> {
  const businessDate = await companyBusinessDate(companyId, executor);
  const cutover = await getInventoryCutover(executor, companyId);
  if (!cutover || cutover.status !== "ACTIVE") return { perpetual: false, businessDate };
  const appliesToday = businessDate >= cutover.effectiveFrom;
  if (appliesToday && entryDate < cutover.effectiveFrom) {
    throw new FactoryStockEntryBeforeCutoverError(cutover.effectiveFrom, entryDate);
  }
  return { perpetual: appliesToday || entryDate >= cutover.effectiveFrom, businessDate };
}

/** Sends the 409 for an import or back-dated entry refusal; returns whether it did. */
export function sendStockImportRefusal(
  response: { status: (code: number) => { json: (body: unknown) => unknown } },
  error: unknown
): boolean {
  if (error instanceof FactoryStockImportAfterCutoverError) {
    response.status(409).json({ code: error.code, message: error.message, effectiveFrom: error.effectiveFrom });
    return true;
  }
  if (error instanceof FactoryStockEntryBeforeCutoverError) {
    response.status(409).json({
      code: error.code,
      message: error.message,
      effectiveFrom: error.effectiveFrom,
      entryDate: error.entryDate,
    });
    return true;
  }
  return false;
}

export interface ImportedAtSpreadsheetCostRow {
  source: "factory_bales" | "factory_raw_stock";
  id: number;
  /** The bale's import batch (bale import and reimport). */
  importBatchId: number | null;
  status: string | null;
  /** Remaining kg for raw stock, the bale weight for a bale. */
  kg: string;
  /** USD value at the spreadsheet's cost (2dp); null for raw stock with no USD cost. */
  value: string | null;
}

export interface ImportedAtSpreadsheetCost {
  bales: number;
  rawStock: number;
  /** Sum of the rows' values (2dp). */
  value: string;
  rows: ImportedAtSpreadsheetCostRow[];
}

/**
 * Stock brought in by a spreadsheet import and still held: bales of an import
 * batch in a stock status, and raw-stock rows the raw-stock import created
 * (identified by their import audit row) with kg left. Read-only.
 */
export async function importedAtSpreadsheetCostTx(
  executor: DatabaseOrTransaction,
  companyId: number
): Promise<ImportedAtSpreadsheetCost> {
  const bales = await executor.execute(sql`
    SELECT b.id, b.import_batch_id, b.status, COALESCE(b.weight_kg, 0)::text AS kg,
           COALESCE(b.total_cost, 0)::text AS value
      FROM factory_bales b
     WHERE b.company_id = ${companyId} AND b.deleted_at IS NULL AND b.import_batch_id IS NOT NULL
       AND b.status IN ('PENDING_PRESSING', 'IN_STOCK', 'RESERVED_FOR_ORDER', 'RESERVED_FOR_DISPATCH')
     ORDER BY b.id
  `);
  const raw = await executor.execute(sql`
    SELECT rs.id, (rs.received_kg - rs.used_kg)::text AS kg,
           CASE WHEN rs.cost_per_kg_usd IS NULL THEN NULL
                ELSE ((rs.received_kg - rs.used_kg) * rs.cost_per_kg_usd)::text END AS value
      FROM factory_raw_stock rs
     WHERE rs.company_id = ${companyId} AND rs.deleted_at IS NULL AND rs.received_kg - rs.used_kg > 0
       AND EXISTS (
         SELECT 1 FROM audit_log a
          WHERE a.table_name = ${RAW_STOCK_IMPORT_AUDIT.tableName} AND a.action = ${RAW_STOCK_IMPORT_AUDIT.action}
            AND a.company_id = rs.company_id AND a.record_id = rs.id
       )
     ORDER BY rs.id
  `);
  const rows: ImportedAtSpreadsheetCostRow[] = [
    ...(bales.rows as Array<Record<string, unknown>>).map((row) => ({
      source: "factory_bales" as const,
      id: Number(row.id),
      importBatchId: row.import_batch_id == null ? null : Number(row.import_batch_id),
      status: row.status == null ? null : String(row.status),
      kg: String(row.kg),
      value: toMoney(String(row.value)).toFixed(2),
    })),
    ...(raw.rows as Array<Record<string, unknown>>).map((row) => ({
      source: "factory_raw_stock" as const,
      id: Number(row.id),
      importBatchId: null,
      status: null,
      kg: String(row.kg),
      value: row.value == null ? null : toMoney(String(row.value)).toFixed(2),
    })),
  ];
  const total = rows.reduce((sum, row) => (row.value === null ? sum : sum.plus(toMoney(row.value))), toMoney(0));
  return {
    bales: bales.rows.length,
    rawStock: raw.rows.length,
    value: total.toFixed(2),
    rows,
  };
}
