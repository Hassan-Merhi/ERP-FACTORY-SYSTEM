/**
 * The ledger journal of a factory container's commission (accounting audit
 * wave 8.4 continuation, owner decision 3).
 *
 * A container's commission (factory_containers.commission_amount, in
 * commission_currency_code) reached the factory supplier pages from the
 * container table only; no voucher carried it, so the ledger had neither the
 * cost nor the payable, and the daily factory stock journal credited the
 * commission share of each raw-material receipt to accounts that were never
 * charged with it.
 *
 * Now every writer of the commission posts, in its own transaction, one
 * deterministic journal FACTORY-COMM-{container}, replaced whole whenever the
 * commission (or what it depends on) changes and removed when the commission
 * is removed or the container deleted:
 *
 *   Dr the container's import cost account   the account its FACTORY-IMPORT
 *                                            voucher debits, else Factory
 *                                            Import Cost
 *      Cr the commission payee               the commission supplier (broker)
 *                                            when the container names one, else
 *                                            the container's supplier (a
 *                                            factory-supplier line), else the
 *                                            container's commission ledger
 *                                            account
 *
 * normalized like the wave 6 factory writers (USD base in debit/credit, native
 * amounts in transaction_*, the factory rate as the historical rate). The rate
 * is the commission's own confirmed rate, or the container's confirmed rate
 * for a commission in the container's currency; with neither (or with no
 * payee) nothing is posted, and the not-in-ledger memo and the integrity
 * diagnostic keep listing the commission. Legacy containers are not
 * back-filled.
 */
import type Decimal from "decimal.js";
import { sql } from "drizzle-orm";
import { voucherEntries } from "@shared/schema";

import type { DatabaseOrTransaction, DbTransaction } from "../../db";
import { MoneyDecimal, toMoney } from "../../lib/money";
import {
  deleteInfrastructurePostingIdentityForVoucherTx,
  infrastructurePostingIdentity,
  insertInfrastructureVoucherTx,
} from "../accounting/infrastructureVoucherIdentity";
import { systemAccountIdsTx } from "../accounting/perpetualInventory/linkedJournal";
import { normFactoryEntry } from "./factoryVoucherEntryAmounts";

export const CONTAINER_COMMISSION_SOURCE = "factory-container-commission";

export const containerCommissionVoucherNumber = (containerId: number) => `FACTORY-COMM-${containerId}`;

export type ContainerCommissionJournalSkip = "missing" | "deleted" | "no-commission" | "no-rate" | "no-payee";

export interface ContainerCommissionJournalResult {
  voucherId: number | null;
  skipped?: ContainerCommissionJournalSkip;
}

interface CommissionRow {
  container_number: string;
  deleted_at: string | null;
  date: string;
  currency_code: string | null;
  fx_rate_to_usd: string | null;
  fx_rate_confirmed: boolean | null;
  commission_amount: string | null;
  commission_currency_code: string | null;
  commission_fx_rate_to_usd: string | null;
  commission_fx_rate_confirmed: boolean | null;
  commission_supplier_id: number | null;
  supplier_id: number | null;
  commission_account_id: number | null;
}

async function rowsOf<T>(executor: DatabaseOrTransaction, query: ReturnType<typeof sql>): Promise<T[]> {
  return (await executor.execute(query)).rows as unknown as T[];
}

/** USD per unit when known: 1 for USD, a confirmed positive stored rate otherwise (as the memo reads it). */
function confirmedRate(currency: string, rate: string | null, confirmed: boolean | null): Decimal | null {
  if (currency === "USD") return new MoneyDecimal(1);
  if (confirmed !== true || rate === null) return null;
  const value = toMoney(rate);
  return value.greaterThan(0) ? value : null;
}

/** The commission's rate: its own confirmed rate, else the container's for a commission in the container's currency. */
export function containerCommissionRate(row: {
  currency_code: string | null;
  fx_rate_to_usd: string | null;
  fx_rate_confirmed: boolean | null;
  commission_currency_code: string | null;
  commission_fx_rate_to_usd: string | null;
  commission_fx_rate_confirmed: boolean | null;
}): { currency: string; rate: Decimal | null } {
  const containerCcy = (row.currency_code || "USD").toUpperCase();
  const currency = (row.commission_currency_code || containerCcy).toUpperCase();
  const rate =
    confirmedRate(currency, row.commission_fx_rate_to_usd, row.commission_fx_rate_confirmed) ??
    (currency === containerCcy ? confirmedRate(containerCcy, row.fx_rate_to_usd, row.fx_rate_confirmed) : null);
  return { currency, rate };
}

/** Removes the container's commission journal (and any legacy FACTORY-COMM-{container}-… voucher). */
export async function removeContainerCommissionJournalTx(
  tx: DbTransaction,
  companyId: number,
  containerId: number
): Promise<void> {
  const ids = await rowsOf<{ id: number }>(
    tx,
    sql`SELECT id FROM vouchers
         WHERE company_id = ${companyId}
           AND (voucher_number = ${containerCommissionVoucherNumber(containerId)}
                OR voucher_number LIKE ${`${containerCommissionVoucherNumber(containerId)}-%`})`
  );
  for (const { id } of ids) {
    await deleteInfrastructurePostingIdentityForVoucherTx(tx, id);
    await tx.execute(sql`DELETE FROM voucher_entries WHERE voucher_id = ${id}`);
    await tx.execute(sql`DELETE FROM vouchers WHERE id = ${id} AND company_id = ${companyId}`);
  }
}

/** The ledger account the container's live FACTORY-IMPORT voucher debits, else Factory Import Cost. */
async function importCostAccountIdTx(tx: DbTransaction, companyId: number, containerId: number): Promise<number> {
  const [charged] = await rowsOf<{ ledger_account_id: number }>(
    tx,
    sql`SELECT ve.ledger_account_id
          FROM vouchers v JOIN voucher_entries ve ON ve.voucher_id = v.id
         WHERE v.company_id = ${companyId} AND v.deleted_at IS NULL AND COALESCE(v.optional, false) = false
           AND v.voucher_number LIKE ${`FACTORY-IMPORT-${containerId}-%`}
           AND ve.ledger_account_id IS NOT NULL AND ve.debit_amount > 0
         ORDER BY v.id DESC, ve.id
         LIMIT 1`
  );
  if (charged) return Number(charged.ledger_account_id);
  return (await systemAccountIdsTx(tx, companyId, ["FACTORY_IMPORT_COST"])).get("FACTORY_IMPORT_COST")!;
}

/**
 * Posts (replacing any earlier one) the commission journal of a container from
 * its current row. Call it inside the transaction that writes the commission.
 */
export async function syncContainerCommissionJournalTx(
  tx: DbTransaction,
  companyId: number,
  containerId: number
): Promise<ContainerCommissionJournalResult> {
  await removeContainerCommissionJournalTx(tx, companyId, containerId);
  const [row] = await rowsOf<CommissionRow>(
    tx,
    sql`SELECT container_number, deleted_at::text AS deleted_at,
               COALESCE(arrival_date, created_at::date)::text AS date,
               currency_code, fx_rate_to_usd::text AS fx_rate_to_usd, fx_rate_confirmed,
               commission_amount::text AS commission_amount, commission_currency_code,
               commission_fx_rate_to_usd::text AS commission_fx_rate_to_usd, commission_fx_rate_confirmed,
               commission_supplier_id, supplier_id, commission_account_id
          FROM factory_containers WHERE id = ${containerId} AND company_id = ${companyId}`
  );
  if (!row) return { voucherId: null, skipped: "missing" };
  if (row.deleted_at !== null) return { voucherId: null, skipped: "deleted" };
  const amount = toMoney(row.commission_amount ?? 0).toDecimalPlaces(2);
  if (!amount.greaterThan(0)) return { voucherId: null, skipped: "no-commission" };
  const { currency, rate } = containerCommissionRate(row);
  if (!rate) return { voucherId: null, skipped: "no-rate" };
  const payeeSupplierId = row.commission_supplier_id ?? row.supplier_id;
  if (!payeeSupplierId && !row.commission_account_id) return { voucherId: null, skipped: "no-payee" };

  const debitAccountId = await importCostAccountIdTx(tx, companyId, containerId);
  const rateText = rate.toFixed();
  const { voucher } = await insertInfrastructureVoucherTx(
    tx,
    {
      companyId,
      voucherType: "Journal",
      voucherNumber: containerCommissionVoucherNumber(containerId),
      voucherDate: row.date,
      description: ["Commission - container", row.container_number].join(" "),
      totalAmount: amount.toFixed(2),
      currency,
      exchangeRate: rateText,
      sourceModule: "FACTORY",
    },
    infrastructurePostingIdentity(CONTAINER_COMMISSION_SOURCE, containerId)
  );
  await tx.insert(voucherEntries).values([
    {
      voucherId: voucher.id,
      ledgerAccountId: debitAccountId,
      ...normFactoryEntry(currency, amount.toFixed(2), "0", rateText),
      narration: `Commission cost - container ${row.container_number}`,
    },
    {
      voucherId: voucher.id,
      ...(payeeSupplierId
        ? { factorySupplierId: payeeSupplierId }
        : { ledgerAccountId: Number(row.commission_account_id) }),
      ...normFactoryEntry(currency, "0", amount.toFixed(2), rateText),
      narration: `Commission payable - container ${row.container_number}`,
    },
  ]);
  return { voucherId: voucher.id };
}
