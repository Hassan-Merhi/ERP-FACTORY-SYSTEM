/**
 * Cost of goods sold for ERP sales under perpetual inventory (wave 8.1).
 *
 * A sale's COGS is a separate journal linked to the sale by its number,
 * `COGS-{saleVoucherId}`: Dr COGS / Cr Inventory for the exact value the stock
 * sub-ledger relieved (the drop in `inventory.total_value` that
 * `adjustInventory` reports), so the ledger's inventory moves with the
 * sub-ledger. Keeping it out of the sale voucher leaves the sale's own lines
 * (one payment debit, one revenue credit) as every sale reader expects them.
 *
 * Nothing is posted unless the company's perpetual-inventory cut-over is
 * applied and the sale is dated on or after it.
 */
import type Decimal from "decimal.js";
import { sql } from "drizzle-orm";

import type { DatabaseOrTransaction, DbTransaction } from "../../../db";
import { HttpError } from "../../../lib/httpHandlers";
import type { AdjustInventoryResult } from "../../../inventoryHelper";
import { MoneyDecimal, toMoney } from "../../../lib/money";
import { getOrCreateInventoryControlAccount } from "../inventoryControlAccount";
import { getInventoryCutover, isPerpetualInventoryActive } from "./cutover";
import {
  isSupplierPartnerCompany,
  postLinkedJournalTx,
  removeLinkedJournalTx,
  systemAccountIdsTx,
} from "./linkedJournal";

export const saleCogsVoucherNumber = (saleVoucherId: number) => `COGS-${saleVoucherId}`;

/**
 * The value an inventory issue relieved: minus the stored value delta
 * (previous minus new total value on a result without one). A short sale
 * relieves its shortage at the provisional cost (negative-stock policy), so it
 * is not zero. Not clamped: an issue from a row holding a negative value
 * (an anomaly) relieves a negative amount, and the COGS journal then credits
 * COGS, so the ledger still moves with the sub-ledger.
 */
export function relievedValue(
  result: Pick<AdjustInventoryResult, "previousTotalValue" | "newTotalValue"> & { valueDelta?: string }
): Decimal {
  if (result.valueDelta !== undefined) return toMoney(result.valueDelta).negated();
  return toMoney(result.previousTotalValue).minus(toMoney(result.newTotalValue)).toDecimalPlaces(2);
}

/** Removes a sale's COGS journal and its posting identity, if any. */
export async function removeSaleCogsTx(tx: DbTransaction, companyId: number, saleVoucherId: number): Promise<void> {
  await removeLinkedJournalTx(tx, companyId, saleCogsVoucherNumber(saleVoucherId));
}

/**
 * Posts (replacing any earlier one) the COGS journal of a sale. Returns the
 * journal's id, or null when nothing is posted: the cut-over does not cover the
 * sale's date, the company is a supplier partner, or the sale relieved no value.
 * A negative relieved value (see relievedValue) posts the reverse journal.
 */
export async function postSaleCogsTx(
  tx: DbTransaction,
  params: {
    companyId: number;
    saleVoucherId: number;
    saleVoucherNumber: string;
    voucherDate: string;
    locationId?: number | null;
    relieved: Decimal;
    optional?: boolean;
  }
): Promise<number | null> {
  await removeSaleCogsTx(tx, params.companyId, params.saleVoucherId);
  if (!(await isPerpetualInventoryActive(tx, params.companyId, params.voucherDate))) return null;
  if (await isSupplierPartnerCompany(tx, params.companyId)) return null;
  const relieved = params.relieved.toDecimalPlaces(2);
  if (relieved.isZero()) return null;
  const amount = relieved.abs();
  const credit = relieved.isNegative();

  const accounts = await systemAccountIdsTx(tx, params.companyId, ["COGS"]);
  const { id: inventoryAccountId } = await getOrCreateInventoryControlAccount(tx, params.companyId);
  const zero = new MoneyDecimal(0);
  return postLinkedJournalTx(tx, {
    companyId: params.companyId,
    voucherNumber: saleCogsVoucherNumber(params.saleVoucherId),
    voucherDate: params.voucherDate,
    description: ["Cost of goods sold", params.saleVoucherNumber].join(" - "),
    identity: { sourceType: "perpetual-sale-cogs", sourceId: params.saleVoucherId },
    locationId: params.locationId,
    optional: params.optional,
    lines: [
      {
        ledgerAccountId: accounts.get("COGS")!,
        debit: credit ? zero : amount,
        credit: credit ? amount : zero,
        narration: ["Cost of goods sold", params.saleVoucherNumber].join(" - "),
      },
      {
        ledgerAccountId: inventoryAccountId,
        debit: credit ? amount : zero,
        credit: credit ? zero : amount,
        narration: ["Stock issued", params.saleVoucherNumber].join(" - "),
      },
    ],
  });
}

// ── A sale's date changes (wave 15, M5) ──────────────────────────────────────

export const SALE_DATE_CROSSES_CUTOVER = "SALE_DATE_CROSSES_INVENTORY_CUTOVER" as const;
export const SALE_DATE_CROSSES_CUTOVER_MESSAGE =
  "This sale moved stock: its date cannot be moved across the company's perpetual inventory cut-over date, because its cost of goods sold would leave or enter the ledger without the stock moving.";

export class SaleDateCrossesCutoverError extends HttpError {
  readonly code = SALE_DATE_CROSSES_CUTOVER;
  constructor(readonly effectiveFrom: string) {
    super(409, SALE_DATE_CROSSES_CUTOVER_MESSAGE);
    this.name = "SaleDateCrossesCutoverError";
  }
}

/**
 * Keeps a sale's COGS journal on the sale's date when the sale is re-dated:
 * COGS-{id} takes the new date (in place, same lines and identity), so cost of
 * sales and the INVENTORY credit stay in the sale's period. A date change
 * that crosses the company's cut-over date is refused for a sale that moved
 * stock (it has sale lines): before the cut-over the sale carries no COGS
 * journal and the opening journal holds its stock effect; after it the journal
 * does, so moving across would add or drop COGS with no stock movement. Call
 * it inside the edit's transaction with the dates before and after.
 */
export interface SaleRedate {
  companyId: number;
  saleVoucherId: number;
  voucherType: string;
  oldDate: string;
  newDate: string;
}

function redateDates(params: SaleRedate): { oldDate: string; newDate: string } | null {
  if (params.voucherType !== "Sales" && params.voucherType !== "Receipt") return null;
  const oldDate = String(params.oldDate ?? "").slice(0, 10);
  const newDate = String(params.newDate ?? "").slice(0, 10);
  if (!newDate || oldDate === newDate) return null;
  return { oldDate, newDate };
}

/** Throws SaleDateCrossesCutoverError when the re-date is refused (see redateSaleCogsTx). */
export async function assertSaleRedateAllowed(executor: DatabaseOrTransaction, params: SaleRedate): Promise<void> {
  const dates = redateDates(params);
  if (!dates) return;
  const cutover = await getInventoryCutover(executor, params.companyId);
  if (!cutover) return;
  if (dates.oldDate >= cutover.effectiveFrom === dates.newDate >= cutover.effectiveFrom) return;
  const lines = await executor.execute(
    sql`SELECT 1 FROM sales_items WHERE voucher_id = ${params.saleVoucherId} LIMIT 1`
  );
  if (lines.rows.length > 0) throw new SaleDateCrossesCutoverError(cutover.effectiveFrom);
}

export async function redateSaleCogsTx(tx: DbTransaction, params: SaleRedate): Promise<void> {
  const dates = redateDates(params);
  if (!dates) return;
  await assertSaleRedateAllowed(tx, params);
  await tx.execute(sql`
    UPDATE vouchers SET voucher_date = ${dates.newDate}
     WHERE company_id = ${params.companyId} AND voucher_number = ${saleCogsVoucherNumber(params.saleVoucherId)}
       AND deleted_at IS NULL
  `);
}
