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
import type { DbTransaction } from "../../../db";
import type { AdjustInventoryResult } from "../../../inventoryHelper";
import { MoneyDecimal, toMoney } from "../../../lib/money";
import { getOrCreateInventoryControlAccount } from "../inventoryControlAccount";
import { isPerpetualInventoryActive } from "./cutover";
import {
  isSupplierPartnerCompany,
  postLinkedJournalTx,
  removeLinkedJournalTx,
  systemAccountIdsTx,
} from "./linkedJournal";

export const saleCogsVoucherNumber = (saleVoucherId: number) => `COGS-${saleVoucherId}`;

/** The value an inventory issue relieved: previous minus new total value (never negative). */
export function relievedValue(result: Pick<AdjustInventoryResult, "previousTotalValue" | "newTotalValue">): Decimal {
  const relieved = toMoney(result.previousTotalValue).minus(toMoney(result.newTotalValue));
  return relieved.isNegative() ? new MoneyDecimal(0) : relieved;
}

/** Removes a sale's COGS journal and its posting identity, if any. */
export async function removeSaleCogsTx(tx: DbTransaction, companyId: number, saleVoucherId: number): Promise<void> {
  await removeLinkedJournalTx(tx, companyId, saleCogsVoucherNumber(saleVoucherId));
}

/**
 * Posts (replacing any earlier one) the COGS journal of a sale. Returns the
 * journal's id, or null when nothing is posted: the cut-over does not cover the
 * sale's date, the company is a supplier partner, or the sale relieved no value.
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
  const amount = params.relieved.toDecimalPlaces(2);
  if (!amount.gt(0)) return null;

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
        debit: amount,
        credit: zero,
        narration: ["Cost of goods sold", params.saleVoucherNumber].join(" - "),
      },
      {
        ledgerAccountId: inventoryAccountId,
        debit: zero,
        credit: amount,
        narration: ["Stock issued", params.saleVoucherNumber].join(" - "),
      },
    ],
  });
}
