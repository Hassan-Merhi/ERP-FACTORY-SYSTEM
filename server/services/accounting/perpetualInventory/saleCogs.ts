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

import type { DbTransaction } from "../../../db";
import type { AdjustInventoryResult } from "../../../inventoryHelper";
import { MoneyDecimal, toMoney } from "../../../lib/money";
import { getOrCreateInventoryControlAccount } from "../inventoryControlAccount";
import { ensureSystemAccounts } from "../systemAccounts";
import { isPerpetualInventoryActive } from "./cutover";

export const saleCogsVoucherNumber = (saleVoucherId: number) => `COGS-${saleVoucherId}`;

/** The value an inventory issue relieved: previous minus new total value (never negative). */
export function relievedValue(result: Pick<AdjustInventoryResult, "previousTotalValue" | "newTotalValue">): Decimal {
  const relieved = toMoney(result.previousTotalValue).minus(toMoney(result.newTotalValue));
  return relieved.isNegative() ? new MoneyDecimal(0) : relieved;
}

/** Removes a sale's COGS journal, if any. */
export async function removeSaleCogsTx(tx: DbTransaction, companyId: number, saleVoucherId: number): Promise<void> {
  const number = saleCogsVoucherNumber(saleVoucherId);
  await tx.execute(sql`
    DELETE FROM voucher_entries WHERE voucher_id IN (
      SELECT id FROM vouchers WHERE company_id = ${companyId} AND voucher_number = ${number}
    )
  `);
  await tx.execute(sql`DELETE FROM vouchers WHERE company_id = ${companyId} AND voucher_number = ${number}`);
}

/**
 * Posts (replacing any earlier one) the COGS journal of a sale. Returns the
 * journal's id, or null when nothing is posted: the cut-over does not cover the
 * sale's date, or the sale relieved no value.
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
  // Supplier-partner companies carry their stock in their own sp_stock accounts.
  const company = await tx.execute<{ company_type: string | null } & Record<string, unknown>>(
    sql`SELECT company_type FROM companies WHERE id = ${params.companyId}`
  );
  if ((company.rows[0] as { company_type: string | null } | undefined)?.company_type === "supplier_partner") {
    return null;
  }
  const amount = params.relieved.toDecimalPlaces(2);
  if (!amount.gt(0)) return null;

  const [cogs] = await ensureSystemAccounts(tx, params.companyId, ["COGS"]);
  if (cogs.state === "missing" || cogs.state === "deleted") {
    throw new Error("A required system account is not available");
  }
  const { id: inventoryAccountId } = await getOrCreateInventoryControlAccount(tx, params.companyId);
  const voucher = await tx.execute<{ id: number } & Record<string, unknown>>(sql`
    INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, description, total_amount,
                          currency, exchange_rate, location_id, optional)
    VALUES (${params.companyId}, ${saleCogsVoucherNumber(params.saleVoucherId)}, 'Journal', ${params.voucherDate},
            ${`Cost of goods sold - ${params.saleVoucherNumber}`}, ${amount.toFixed(2)}, 'USD', 1,
            ${params.locationId ?? null}, ${params.optional === true})
    RETURNING id
  `);
  const id = (voucher.rows[0] as { id: number }).id;
  await tx.execute(sql`
    INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount, narration)
    VALUES (${id}, ${cogs.accountId}, ${amount.toFixed(2)}, 0, ${`Cost of goods sold - ${params.saleVoucherNumber}`}),
           (${id}, ${inventoryAccountId}, 0, ${amount.toFixed(2)}, ${`Stock issued - ${params.saleVoucherNumber}`})
  `);
  return id;
}
