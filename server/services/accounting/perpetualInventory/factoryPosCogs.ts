/**
 * Cost of goods sold for factory POS sales (wave 8.4).
 *
 * A factory POS sale marks bales SOLD and posts its revenue (FPOS- voucher,
 * Cr Factory Bale Sales Income); it never posted their cost. Once the
 * company's cut-over applies, the sale also posts a linked journal
 * FPOS-COGS-{saleId}: Dr Cost of Goods Sold / Cr Factory Finished Goods for
 * the recorded cost of the bales the sale marked sold. Since wave 11 a sale
 * records the bales it took (factory_pos_sale_bales,
 * services/factory/factoryPosSaleBales.ts): the cost is the SUM of those
 * bales' total_cost, a void puts back exactly those bales, and an edit
 * releases them and records the ones it takes. An edit replaces the journal
 * and a delete removes it.
 */
import type Decimal from "decimal.js";
import { and, eq, inArray, sql } from "drizzle-orm";

import { factoryBales } from "@shared/schema";

import type { DbTransaction } from "../../../db";
import { MoneyDecimal, toMoney } from "../../../lib/money";
import { isPerpetualInventoryActive } from "./cutover";
import {
  isSupplierPartnerCompany,
  postLinkedJournalTx,
  removeLinkedJournalTx,
  systemAccountIdsTx,
} from "./linkedJournal";

export const factoryPosCogsVoucherNumber = (saleId: number) => `FPOS-COGS-${saleId}`;

/** The recorded cost of a set of bales. */
export async function factoryBalesCostTx(tx: DbTransaction, companyId: number, baleIds: readonly number[]) {
  if (baleIds.length === 0) return new MoneyDecimal(0);
  const [row] = await tx
    .select({ cost: sql<string>`COALESCE(SUM(${factoryBales.totalCost}), 0)::text` })
    .from(factoryBales)
    .where(and(eq(factoryBales.companyId, companyId), inArray(factoryBales.id, [...baleIds])));
  return toMoney(row?.cost ?? 0);
}

export async function removeFactoryPosCogsTx(tx: DbTransaction, companyId: number, saleId: number): Promise<void> {
  await removeLinkedJournalTx(tx, companyId, factoryPosCogsVoucherNumber(saleId));
}

/** Posts (replacing any earlier one) the COGS journal of a factory POS sale. */
export async function postFactoryPosCogsTx(
  tx: DbTransaction,
  params: { companyId: number; saleId: number; voucherDate: string; cost: Decimal }
): Promise<number | null> {
  await removeFactoryPosCogsTx(tx, params.companyId, params.saleId);
  if (!(await isPerpetualInventoryActive(tx, params.companyId, params.voucherDate))) return null;
  if (await isSupplierPartnerCompany(tx, params.companyId)) return null;
  const amount = params.cost.toDecimalPlaces(2);
  if (!amount.gt(0)) return null;
  const accounts = await systemAccountIdsTx(tx, params.companyId, ["COGS", "FACTORY_FINISHED_GOODS"]);
  const number = factoryPosCogsVoucherNumber(params.saleId);
  const zero = new MoneyDecimal(0);
  return postLinkedJournalTx(tx, {
    companyId: params.companyId,
    voucherNumber: number,
    voucherDate: params.voucherDate,
    description: ["Cost of bales sold", number].join(" - "),
    identity: { sourceType: "perpetual-factory-pos-cogs", sourceId: params.saleId },
    lines: [
      {
        ledgerAccountId: accounts.get("COGS")!,
        debit: amount,
        credit: zero,
        narration: "Cost of bales sold at the factory POS",
      },
      {
        ledgerAccountId: accounts.get("FACTORY_FINISHED_GOODS")!,
        debit: zero,
        credit: amount,
        narration: "Bales sold at the factory POS",
      },
    ],
  });
}
