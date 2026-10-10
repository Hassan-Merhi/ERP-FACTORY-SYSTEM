/**
 * AR/AP aging on the one balance engine (accounting audit wave 17 A).
 *
 * GET /api/reports/aging?kind=customer|supplier|factorySupplier&asOf=YYYY-MM-DD
 *
 *   - each party's balance is the engine's closing (getPartyBalances) as of
 *     `asOf` (everything posted without it), in this company's vouchers, by
 *     COALESCE(effective_date, voucher_date), each line owned once by the
 *     engine's rules (partyLineRules.ts);
 *   - the balance owed (a customer's debit, a supplier's credit) is aged by
 *     the lines that raised it, newest first (payments and credits settle the
 *     oldest amounts first): each part falls in the bucket of its line's
 *     booked date, counted in days before the reference date (`asOf`, else
 *     the server's business date);
 *   - whatever the dated lines do not explain is the master opening (or older
 *     history) and is reported in the `opening` bucket;
 *   - a party in credit (a customer's advance, a supplier we overpaid) is not
 *     aged: its balance is in `unappliedCredit` (negative);
 *   - lines dated after the reference date are in `future`.
 * The buckets of a party always add up to its engine balance.
 *
 * Wave 18 C: factory suppliers are aged too (the engine's kind
 * `factorySupplier`, credit owed like an ERP supplier); amounts are the
 * engine's USD base amounts, COALESCE(base_debit_amount, debit_amount) and
 * the credit likewise (the engine's `historicalBaseClosing`), so a
 * foreign-currency line ages at its posting-rate USD value; the reference date
 * is the company's business date (its timezone), not UTC.
 */
import { sql } from "drizzle-orm";
import type Decimal from "decimal.js";

import { db, type DatabaseOrTransaction } from "../../db";
import { MoneyDecimal, toMoney } from "../../lib/money";
import { getPartyBalances, liveVouchersOf, VOUCHER_BOOKED_ON } from "../accounting/balances/ledgerBalanceEngine";
import {
  customerLinksBody,
  higherPriorityTargetsAbsent,
  intLiteral,
  noNonCustomerTarget,
} from "../accounting/balances/partyLineRules";
import { companyBusinessDate } from "../accounting/companyBusinessDate";

export type AgingKind = "customer" | "supplier" | "factorySupplier";
export const AGING_KINDS: readonly AgingKind[] = ["customer", "supplier", "factorySupplier"];

export const AGING_BUCKETS = [
  "future",
  "current",
  "days31to60",
  "days61to90",
  "over90",
  "opening",
  "unappliedCredit",
] as const;
export type AgingBucket = (typeof AGING_BUCKETS)[number];

export interface AgingPartyRow {
  id: number | null;
  code: string | null;
  name: string;
  /** Owed to us (customers) or by us (suppliers), positive; negative when the party is in credit. */
  balance: string;
  buckets: Record<AgingBucket, string>;
}

export interface AgingReport {
  companyId: number;
  kind: AgingKind;
  basis: "ledger";
  /** The amounts aged: the engine's historical USD base amounts (base columns, else debit/credit). */
  amountBasis: "historicalBase";
  asOf: string | null;
  /** The date ages are counted from. */
  referenceDate: string;
  bucketDays: { current: "0-30"; days31to60: "31-60"; days61to90: "61-90"; over90: ">90" };
  parties: AgingPartyRow[];
  totals: { balance: string; buckets: Record<AgingBucket, string> };
}

/** The engine's USD base amounts of a line (ledgerBalanceEngine's base_net), alias `ve`. */
const BASE_DEBIT = sql.raw("COALESCE(ve.base_debit_amount, ve.debit_amount, 0)");
const BASE_CREDIT = sql.raw("COALESCE(ve.base_credit_amount, ve.credit_amount, 0)");

interface IncreaseRow {
  party_id: number;
  booked_on: string;
  increase: string;
}

/** Per party and booked date, the amounts that raised what is owed (debits for a customer, credits for a supplier). */
async function loadIncreases(
  executor: DatabaseOrTransaction,
  companyId: number,
  kind: AgingKind,
  asOf: string | null
): Promise<IncreaseRow[]> {
  const live = liveVouchersOf(companyId, asOf);
  if (kind === "customer") {
    const result = await executor.execute<IncreaseRow & Record<string, unknown>>(sql`
      WITH customer_links AS (${sql.raw(customerLinksBody(intLiteral(companyId)))}),
      owned AS (
        SELECT COALESCE(cl.customer_id,
                        CASE WHEN ${sql.raw(noNonCustomerTarget("ve"))} THEN ve.customer_id END) AS party_id,
               ${VOUCHER_BOOKED_ON} AS booked_on,
               ${BASE_DEBIT} - ${BASE_CREDIT} AS net
          FROM voucher_entries ve
          JOIN vouchers v ON v.id = ve.voucher_id
          LEFT JOIN customer_links cl ON cl.ledger_account_id = ve.ledger_account_id
         WHERE v.company_id = ${companyId} AND ${live}
      )
      SELECT party_id, booked_on::text AS booked_on, SUM(GREATEST(net, 0))::text AS increase
        FROM owned
       WHERE party_id IS NOT NULL
       GROUP BY party_id, booked_on
      HAVING SUM(GREATEST(net, 0)) > 0
    `);
    return result.rows;
  }
  // Suppliers and factory suppliers: the lines the engine attributes to them
  // (no target of higher priority), credits raise what is owed.
  const column = kind === "supplier" ? sql.raw("ve.supplier_id") : sql.raw("ve.factory_supplier_id");
  const owned = sql.raw(higherPriorityTargetsAbsent("ve", kind === "supplier" ? "supplier_id" : "factory_supplier_id"));
  const result = await executor.execute<IncreaseRow & Record<string, unknown>>(sql`
    SELECT ${column} AS party_id, (${VOUCHER_BOOKED_ON})::text AS booked_on,
           SUM(GREATEST(${BASE_CREDIT} - ${BASE_DEBIT}, 0))::text AS increase
      FROM voucher_entries ve
      JOIN vouchers v ON v.id = ve.voucher_id
     WHERE v.company_id = ${companyId} AND ${live}
       AND ${column} IS NOT NULL
       AND ${owned}
     GROUP BY ${column}, ${VOUCHER_BOOKED_ON}
    HAVING SUM(GREATEST(${BASE_CREDIT} - ${BASE_DEBIT}, 0)) > 0
  `);
  return result.rows;
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

function bucketOf(bookedOn: string, referenceDate: string): AgingBucket {
  const age = daysBetween(bookedOn, referenceDate);
  if (age < 0) return "future";
  if (age <= 30) return "current";
  if (age <= 60) return "days31to60";
  if (age <= 90) return "days61to90";
  return "over90";
}

function emptyBuckets(): Record<AgingBucket, Decimal> {
  return Object.fromEntries(AGING_BUCKETS.map((bucket) => [bucket, new MoneyDecimal(0)])) as Record<
    AgingBucket,
    Decimal
  >;
}

function money(buckets: Record<AgingBucket, Decimal>): Record<AgingBucket, string> {
  return Object.fromEntries(AGING_BUCKETS.map((bucket) => [bucket, buckets[bucket].toFixed(2)])) as Record<
    AgingBucket,
    string
  >;
}

export async function getAgingReport(
  companyId: number,
  kind: AgingKind,
  asOf: string | null,
  executor: DatabaseOrTransaction = db
): Promise<AgingReport> {
  const referenceDate = asOf ?? (await companyBusinessDate(companyId, executor));
  const [balances, increases] = await Promise.all([
    getPartyBalances(executor, { companyId, kind, asOf }),
    loadIncreases(executor, companyId, kind, asOf),
  ]);

  const increasesByParty = new Map<number, Array<{ bookedOn: string; amount: Decimal }>>();
  for (const row of increases) {
    const id = Number(row.party_id);
    const list = increasesByParty.get(id) ?? [];
    list.push({ bookedOn: String(row.booked_on).slice(0, 10), amount: toMoney(row.increase) });
    increasesByParty.set(id, list);
  }

  const totals = emptyBuckets();
  let totalBalance = new MoneyDecimal(0);
  const parties: AgingPartyRow[] = [];
  for (const party of balances.parties) {
    const base = toMoney(party.historicalBaseClosing);
    const owed = kind === "customer" ? base : base.negated();
    if (owed.isZero()) continue;
    const buckets = emptyBuckets();
    if (owed.isNegative()) {
      buckets.unappliedCredit = owed;
    } else {
      let remaining = owed;
      const lines = [...(party.id === null ? [] : (increasesByParty.get(party.id) ?? []))].sort((a, b) =>
        b.bookedOn.localeCompare(a.bookedOn)
      );
      for (const line of lines) {
        if (!remaining.isPositive()) break;
        const part = MoneyDecimal.min(remaining, line.amount);
        const bucket = bucketOf(line.bookedOn, referenceDate);
        buckets[bucket] = buckets[bucket].plus(part);
        remaining = remaining.minus(part);
      }
      if (remaining.isPositive()) buckets.opening = buckets.opening.plus(remaining);
    }
    for (const bucket of AGING_BUCKETS) totals[bucket] = totals[bucket].plus(buckets[bucket]);
    totalBalance = totalBalance.plus(owed);
    parties.push({
      id: party.id,
      code: party.code,
      name: party.name,
      balance: owed.toFixed(2),
      buckets: money(buckets),
    });
  }
  parties.sort((a, b) => toMoney(b.balance).comparedTo(toMoney(a.balance)) || a.name.localeCompare(b.name));

  return {
    companyId,
    kind,
    basis: "ledger",
    amountBasis: "historicalBase",
    asOf,
    referenceDate,
    bucketDays: { current: "0-30", days31to60: "31-60", days61to90: "61-90", over90: ">90" },
    parties,
    totals: { balance: totalBalance.toFixed(2), buckets: money(totals) },
  };
}
