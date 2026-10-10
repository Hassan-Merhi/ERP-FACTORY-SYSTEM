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
 *
 * Commission held elsewhere (accounting audit wave 14):
 *   - On the container's raw-stock row (factory_raw_stock.commission_*,
 *     written by an opening-balance entry): when the container carries no
 *     commission of its own, the journal posts the raw-stock commission
 *     instead, with the same rules: rate = the row's own stored rate (that
 *     table has no "confirmed" flag, so a non-USD rate must be positive and
 *     not the unset default 1, as resolveStoredFxRate reads it), else the
 *     container's confirmed rate for a commission in the container's
 *     currency; payee = the row's commission supplier, else the container's
 *     supplier, else the row's commission ledger account. When the container
 *     has a commission too, only the container's is posted (one journal per
 *     container, never both), and the raw-stock amount is listed for review.
 *   - In factory_container_commissions (the offload's commission record):
 *     the offload copies it onto the container, whose commission this
 *     journal posts, so a record is never journalled on its own (that would
 *     count it twice). A record its container no longer carries is listed:
 *     by the not-in-ledger memo when the container has no commission at
 *     all, by the integrity diagnostic in every case.
 */
import type Decimal from "decimal.js";
import { sql } from "drizzle-orm";
import { voucherEntries } from "@shared/schema";

import type { DatabaseOrTransaction, DbTransaction } from "../../db";
import { MoneyDecimal, toMoney } from "../../lib/money";
import {
  infrastructurePostingIdentity,
  insertInfrastructureVoucherTx,
} from "../accounting/infrastructureVoucherIdentity";
import { retireVouchersTx } from "../accounting/voucherRetirement";
import { systemAccountIdsTx } from "../accounting/perpetualInventory/linkedJournal";
import { resolveStoredFxRate } from "./currencyConversion";
import { normFactoryEntry } from "./factoryVoucherEntryAmounts";

export const CONTAINER_COMMISSION_SOURCE = "factory-container-commission";

export const containerCommissionVoucherNumber = (containerId: number) => `FACTORY-COMM-${containerId}`;

export type ContainerCommissionJournalSkip = "missing" | "deleted" | "no-commission" | "no-rate" | "no-payee";

export interface ContainerCommissionJournalResult {
  voucherId: number | null;
  skipped?: ContainerCommissionJournalSkip;
  /** Where the posted commission was read from: the container, or its raw-stock row. */
  source?: "container" | "rawStock";
}

interface RawStockCommissionRow {
  commission_amount: string | null;
  commission_currency_code: string | null;
  commission_fx_rate_to_usd: string | null;
  commission_supplier_id: number | null;
  commission_ledger_account_id: number | null;
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

/**
 * A raw-stock commission's rate: the row's own stored rate (no confirmed flag
 * on that table: positive and not the unset default 1), else the container's
 * confirmed rate for a commission in the container's currency.
 */
export function rawStockCommissionRate(
  container: { currency_code: string | null; fx_rate_to_usd: string | null; fx_rate_confirmed: boolean | null },
  row: { commission_currency_code: string | null; commission_fx_rate_to_usd: string | null }
): { currency: string; rate: Decimal | null } {
  const containerCcy = (container.currency_code || "USD").toUpperCase();
  const currency = (row.commission_currency_code || containerCcy).toUpperCase();
  const own = resolveStoredFxRate(currency, row.commission_fx_rate_to_usd);
  const rate = own.looksSet
    ? currency === "USD"
      ? new MoneyDecimal(1)
      : toMoney(row.commission_fx_rate_to_usd)
    : currency === containerCcy
      ? confirmedRate(containerCcy, container.fx_rate_to_usd, container.fx_rate_confirmed)
      : null;
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
  // Wave 16 (A): retired (soft delete, audited, number and identity released), not hard-deleted.
  await retireVouchersTx(tx, {
    companyId,
    voucherIds: ids.map(({ id }) => id),
    reason: "container-commission-journal-replaced",
  });
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

  // The container's own commission; else (wave 14) the commission held on its
  // live raw-stock row (an opening-balance entry). Never both.
  let source: "container" | "rawStock" = "container";
  let amount = toMoney(row.commission_amount ?? 0).toDecimalPlaces(2);
  let { currency, rate } = containerCommissionRate(row);
  let payeeSupplierId = row.commission_supplier_id ?? row.supplier_id;
  let payeeAccountId = row.commission_account_id;
  if (!amount.greaterThan(0)) {
    const [held] = await rowsOf<RawStockCommissionRow>(
      tx,
      sql`SELECT commission_amount::text AS commission_amount, commission_currency_code,
                 commission_fx_rate_to_usd::text AS commission_fx_rate_to_usd,
                 commission_supplier_id, commission_ledger_account_id
            FROM factory_raw_stock
           WHERE company_id = ${companyId} AND container_id = ${containerId} AND deleted_at IS NULL
             AND COALESCE(commission_amount, 0) > 0
           ORDER BY id LIMIT 1`
    );
    if (!held) return { voucherId: null, skipped: "no-commission" };
    source = "rawStock";
    amount = toMoney(held.commission_amount).toDecimalPlaces(2);
    ({ currency, rate } = rawStockCommissionRate(row, held));
    payeeSupplierId = held.commission_supplier_id ?? row.supplier_id;
    payeeAccountId = held.commission_ledger_account_id;
  }
  if (!amount.greaterThan(0)) return { voucherId: null, skipped: "no-commission" };
  if (!rate) return { voucherId: null, skipped: "no-rate" };
  if (!payeeSupplierId && !payeeAccountId) return { voucherId: null, skipped: "no-payee" };

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
      ...(payeeSupplierId ? { factorySupplierId: payeeSupplierId } : { ledgerAccountId: Number(payeeAccountId) }),
      ...normFactoryEntry(currency, "0", amount.toFixed(2), rateText),
      narration: `Commission payable - container ${row.container_number}`,
    },
  ]);
  return { voucherId: voucher.id, source };
}
