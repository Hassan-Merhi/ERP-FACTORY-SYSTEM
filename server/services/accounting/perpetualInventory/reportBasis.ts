/**
 * Which basis the reports use for a company's stock (wave 8.5).
 *
 * Before a company's perpetual-inventory cut-over the ledger is periodic: the
 * reports value stock outside it (location stock in hand, containers on the
 * way, the factory's bales and raw material) and add it to the ledger figures.
 * From the cut-over on, the ledger carries that stock in its own accounts
 * (Inventory, Goods in Transit, the factory stock accounts) and the reports
 * read them instead, so nothing is counted twice. A report dated before the
 * cut-over keeps the computed figures.
 */
import { db, type DatabaseOrTransaction } from "../../../db";
import { isPerpetualInventoryActive } from "./cutover";

/** True when the ledger carries the company's stock as of the date (today when none). */
export async function ledgerCarriesStock(
  companyId: number,
  asOf?: string | null,
  executor: DatabaseOrTransaction = db
): Promise<boolean> {
  return isPerpetualInventoryActive(executor, companyId, asOf || new Date().toISOString().slice(0, 10));
}
