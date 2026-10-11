/**
 * A party's open items (accounting audit phase 25, AR-4).
 *
 * Items are the party's posted vouchers, on the balance engine's line
 * ownership (partyLineRules.ts) in the voucher company, netted per voucher on
 * the book amounts (debit_amount / credit_amount, owner decision AR-3), dated
 * COALESCE(effective_date, voucher_date):
 *
 *   - a voucher that raises what is owed (a customer's net debit; a
 *     supplier's, factory supplier's or employee's net credit) is an
 *     invoice, due its booked date + the party's payment terms (days; 30 when
 *     the party has none — owner decision, decided by default);
 *   - a voucher on the other side (receipt, payment, credit/debit note,
 *     advance) is a credit;
 *   - the party's master opening (engine rule 1, with its side) is an invoice
 *     or a credit with no voucher and no date: it is the oldest item.
 *
 * So the items of a party always net to its engine closing.
 */
import { sql, type SQL } from "drizzle-orm";
import type Decimal from "decimal.js";

import type { DatabaseOrTransaction } from "../../../db";
import { MoneyDecimal, toMoney } from "../../../lib/money";
import { getPartyBalances, liveVouchersOf, VOUCHER_BOOKED_ON } from "../balances/ledgerBalanceEngine";
import {
  customerLinksBody,
  higherPriorityTargetsAbsent,
  intLiteral,
  noNonCustomerTarget,
  type PartyTargetColumn,
} from "../balances/partyLineRules";
import type { AllocationPartyKind } from "./allocationEvents";
import type { ExistingAllocation, OpenItem } from "./fifoPlan";

export const OPEN_ITEM_PARTY_KINDS: readonly AllocationPartyKind[] = [
  "customer",
  "supplier",
  "employee",
  "factorySupplier",
];

/** Payment terms when the party has none (owner decision AR-4, decided by default). */
export const DEFAULT_PAYMENT_TERMS_DAYS = 30;

export const OPENING_ITEM_KEY = "opening";

/** +1 when a debit raises what is owed (customers), −1 when a credit does. */
export function owedSign(kind: AllocationPartyKind): 1 | -1 {
  return kind === "customer" ? 1 : -1;
}

const PARTY_COLUMN: Record<Exclude<AllocationPartyKind, "customer">, PartyTargetColumn> = {
  supplier: "supplier_id",
  employee: "employee_id",
  factorySupplier: "factory_supplier_id",
};

export interface PartyOpenItems {
  partyId: number;
  code: string | null;
  name: string;
  /** Engine closing, what is owed (positive) in the kind's direction. */
  owed: Decimal;
  paymentTermsDays: number;
  invoices: OpenItem[];
  credits: OpenItem[];
}

interface VoucherNetRow {
  party_id: number;
  voucher_id: number;
  voucher_number: string;
  voucher_type: string | null;
  booked_on: string;
  net: string;
}

function idList(ids: readonly number[]): SQL {
  return sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `
  );
}

/** Per party and voucher, the net book amount (debit positive) of the owned lines. */
async function loadVoucherNets(
  executor: DatabaseOrTransaction,
  companyId: number,
  kind: AllocationPartyKind,
  asOf: string | null,
  partyIds: readonly number[] | undefined
): Promise<VoucherNetRow[]> {
  const live = liveVouchersOf(companyId, asOf);
  const net = sql.raw("COALESCE(ve.debit_amount, 0) - COALESCE(ve.credit_amount, 0)");
  if (kind === "customer") {
    const only = partyIds ? sql` AND o.party_id IN (${idList(partyIds)})` : sql``;
    const result = await executor.execute<VoucherNetRow & Record<string, unknown>>(sql`
      WITH customer_links AS (${sql.raw(customerLinksBody(intLiteral(companyId)))}),
      owned AS (
        SELECT COALESCE(cl.customer_id,
                        CASE WHEN ${sql.raw(noNonCustomerTarget("ve"))} THEN ve.customer_id END) AS party_id,
               v.id AS voucher_id, v.voucher_number, v.voucher_type, ${VOUCHER_BOOKED_ON} AS booked_on, ${net} AS net
          FROM voucher_entries ve
          JOIN vouchers v ON v.id = ve.voucher_id
          LEFT JOIN customer_links cl ON cl.ledger_account_id = ve.ledger_account_id
         WHERE v.company_id = ${companyId} AND ${live}
      )
      SELECT o.party_id, o.voucher_id, o.voucher_number, o.voucher_type, o.booked_on::text AS booked_on,
             SUM(o.net)::text AS net
        FROM owned o
       WHERE o.party_id IS NOT NULL${only}
       GROUP BY o.party_id, o.voucher_id, o.voucher_number, o.voucher_type, o.booked_on
      HAVING SUM(o.net) <> 0
    `);
    return result.rows;
  }
  const column = PARTY_COLUMN[kind];
  const target = sql.raw(`ve.${column}`);
  const owned = sql.raw(higherPriorityTargetsAbsent("ve", column));
  const only = partyIds ? sql` AND ${target} IN (${idList(partyIds)})` : sql``;
  const result = await executor.execute<VoucherNetRow & Record<string, unknown>>(sql`
    SELECT ${target} AS party_id, v.id AS voucher_id, v.voucher_number, v.voucher_type,
           (${VOUCHER_BOOKED_ON})::text AS booked_on, SUM(${net})::text AS net
      FROM voucher_entries ve
      JOIN vouchers v ON v.id = ve.voucher_id
     WHERE v.company_id = ${companyId} AND ${live} AND ${target} IS NOT NULL AND ${owned}${only}
     GROUP BY ${target}, v.id, v.voucher_number, v.voucher_type, ${VOUCHER_BOOKED_ON}
    HAVING SUM(${net}) <> 0
  `);
  return result.rows;
}

/** Payment terms (days) per party; parties without terms are absent (default applies). */
async function loadPaymentTerms(
  executor: DatabaseOrTransaction,
  kind: AllocationPartyKind,
  ids: readonly number[]
): Promise<Map<number, number>> {
  const terms = new Map<number, number>();
  if (ids.length === 0 || kind === "employee") return terms;
  const table = sql.raw(kind === "customer" ? "customers" : kind === "supplier" ? "suppliers" : "factory_suppliers");
  const result = await executor.execute<{ id: number; days: number | null } & Record<string, unknown>>(sql`
    SELECT id, payment_terms_days AS days FROM ${table} WHERE id IN (${idList(ids)})
  `);
  for (const row of result.rows) {
    const days = Number(row.days);
    if (row.days !== null && Number.isInteger(days) && days >= 0) terms.set(Number(row.id), days);
  }
  return terms;
}

export function addDays(date: string, days: number): string {
  const time = Date.parse(`${date.slice(0, 10)}T00:00:00Z`) + days * 86_400_000;
  return new Date(time).toISOString().slice(0, 10);
}

/**
 * Every party of the kind in the company (or `partyIds`) with its items, as
 * of `asOf` (everything posted when null). Parties with no item are left out.
 */
export async function loadPartyOpenItems(
  executor: DatabaseOrTransaction,
  query: { companyId: number; kind: AllocationPartyKind; asOf?: string | null; partyIds?: readonly number[] }
): Promise<PartyOpenItems[]> {
  const { companyId, kind } = query;
  const asOf = query.asOf ?? null;
  if (query.partyIds && query.partyIds.length === 0) return [];
  // Sequential: the executor may be a transaction (one client).
  const balances = await getPartyBalances(executor, { companyId, kind, asOf, ids: query.partyIds });
  const nets = await loadVoucherNets(executor, companyId, kind, asOf, query.partyIds);
  const sign = owedSign(kind);
  const ids = balances.parties.map((party) => party.id).filter((id): id is number => id !== null);
  const terms = await loadPaymentTerms(executor, kind, ids);

  const netsByParty = new Map<number, VoucherNetRow[]>();
  for (const row of nets) {
    const id = Number(row.party_id);
    const list = netsByParty.get(id) ?? [];
    list.push(row);
    netsByParty.set(id, list);
  }

  const out: PartyOpenItems[] = [];
  for (const party of balances.parties) {
    if (party.id === null) continue;
    const days = terms.get(party.id) ?? DEFAULT_PAYMENT_TERMS_DAYS;
    const invoices: OpenItem[] = [];
    const credits: OpenItem[] = [];
    const opening = toMoney(party.masterOpening).times(sign);
    if (!opening.isZero()) {
      const item: OpenItem = {
        key: OPENING_ITEM_KEY,
        voucherId: null,
        voucherNumber: null,
        voucherType: "Opening",
        bookedOn: null,
        dueDate: null,
        amount: opening.abs(),
      };
      (opening.greaterThan(0) ? invoices : credits).push(item);
    }
    for (const row of netsByParty.get(party.id) ?? []) {
      const owed = toMoney(row.net).times(sign);
      const bookedOn = String(row.booked_on).slice(0, 10);
      const item: OpenItem = {
        key: String(row.voucher_id),
        voucherId: Number(row.voucher_id),
        voucherNumber: row.voucher_number,
        voucherType: row.voucher_type,
        bookedOn,
        dueDate: owed.greaterThan(0) ? addDays(bookedOn, days) : null,
        amount: owed.abs(),
      };
      (owed.greaterThan(0) ? invoices : credits).push(item);
    }
    if (invoices.length === 0 && credits.length === 0) continue;
    out.push({
      partyId: party.id,
      code: party.code,
      name: party.name,
      owed: toMoney(party.closing).times(sign),
      paymentTermsDays: days,
      invoices,
      credits,
    });
  }
  return out;
}

interface AllocationRow {
  id: number;
  party_id: number;
  invoice_voucher_id: number | null;
  payment_voucher_id: number | null;
  amount: string;
  method: string;
}

/** Live (not released) allocation rows of the kind in the company, per party. */
export async function loadLiveAllocations(
  executor: DatabaseOrTransaction,
  query: { companyId: number; kind: AllocationPartyKind; partyIds?: readonly number[] }
): Promise<Map<number, ExistingAllocation[]>> {
  const out = new Map<number, ExistingAllocation[]>();
  if (query.partyIds && query.partyIds.length === 0) return out;
  const only = query.partyIds ? sql` AND party_id IN (${idList(query.partyIds)})` : sql``;
  const result = await executor.execute<AllocationRow & Record<string, unknown>>(sql`
    SELECT id, party_id, invoice_voucher_id, payment_voucher_id, amount::text AS amount, method
      FROM party_open_item_allocations
     WHERE company_id = ${query.companyId} AND party_kind = ${query.kind} AND released_at IS NULL${only}
     ORDER BY id
  `);
  for (const row of result.rows) {
    const partyId = Number(row.party_id);
    const list = out.get(partyId) ?? [];
    list.push({
      id: Number(row.id),
      invoiceKey: row.invoice_voucher_id === null ? OPENING_ITEM_KEY : String(row.invoice_voucher_id),
      paymentKey: row.payment_voucher_id === null ? OPENING_ITEM_KEY : String(row.payment_voucher_id),
      amount: toMoney(row.amount),
      method: row.method === "manual" || row.method === "note" ? row.method : "auto_fifo",
      sequence: Number(row.id),
    });
    out.set(partyId, list);
  }
  return out;
}

export const ZERO_MONEY = new MoneyDecimal(0);
