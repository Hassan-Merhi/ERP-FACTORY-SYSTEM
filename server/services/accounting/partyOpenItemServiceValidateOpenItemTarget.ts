// Extracted from ./partyOpenItemService.ts to keep that module under the source-size cap.
import Decimal from "decimal.js";
import { sql, type SQL } from "drizzle-orm";
import type { DbTransaction } from "../../db";
import { resultRows } from "../../lib/queryResult";
import { customerOwnedLinePredicate, higherPriorityTargetsAbsent, intLiteral } from "./balances/partyLineRules";

export type OpenItemDomain = "customer" | "supplier" | "factory_supplier";

export interface PartyOpenItemTarget {
  companyId: number;
  domain: OpenItemDomain;
  partyId: number;
  asOfDate?: string | null;
}

export class OpenItemError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 409
  ) {
    super(message);
    this.name = "OpenItemError";
  }
}

export interface PartyOpenItem {
  entryId: number;
  voucherId: number;
  voucherNumber: string;
  voucherType: string;
  businessDate: string;
  dueDate: string | null;
  overdueDays: number | null;
  side: "charge" | "settlement";
  currency: string;
  originalAmount: string;
  matchedAmount: string;
  outstandingAmount: string;
  status: "open" | "partial" | "settled" | "inconsistent";
  allocations: Array<{ matchId: number; otherEntryId: number; amount: string }>;
  currencyVerified: boolean;
}

export interface OpenItemSummary {
  domain: OpenItemDomain;
  partyId: number;
  companyId: number;
  asOfDate: string | null;
  items: PartyOpenItem[];
  currencies: Record<string, { charges: string; settlements: string; unapplied: string; outstanding: string }>;
  openingBalance: { amount: string; side: string | null; includedInMatching: false };
}

export const DECIMAL_DP = 6;

const DOMAIN_LIST = ["customer", "supplier", "factory_supplier"] as const;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isValidDate(v: string): boolean {
  if (!DATE_RE.test(v)) return false;
  const d = new Date(v + "T00:00:00Z");
  return !Number.isNaN(d.valueOf()) && d.toISOString().slice(0, 10) === v;
}

export function positiveId(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new OpenItemError("OPEN_ITEM_ID_INVALID", `${field} must be a positive integer`, 400);
  return value;
}

export function money(value: unknown): Decimal {
  const amount = new Decimal(String(value ?? "0"));
  if (!amount.isFinite()) throw new OpenItemError("OPEN_ITEM_AMOUNT_INVALID", "Invalid financial amount");
  return amount;
}

export function fmt(value: Decimal): string {
  return value.toFixed(DECIMAL_DP);
}

export function validateOpenItemTarget(target: PartyOpenItemTarget): PartyOpenItemTarget {
  positiveId(target.companyId, "companyId");
  positiveId(target.partyId, "partyId");
  if (!DOMAIN_LIST.includes(target.domain))
    throw new OpenItemError("OPEN_ITEM_DOMAIN_INVALID", "Unsupported party domain", 400);
  if (target.asOfDate != null && !isValidDate(target.asOfDate))
    throw new OpenItemError("OPEN_ITEM_DATE_INVALID", "asOfDate must be a valid YYYY-MM-DD", 400);
  return target;
}

function ownershipPredicate(domain: OpenItemDomain, companyId: number, partyId: number): SQL {
  if (domain === "customer") {
    return sql.raw(customerOwnedLinePredicate("e", intLiteral(companyId), intLiteral(partyId)));
  }
  if (domain === "supplier") {
    return sql`e.supplier_id = ${partyId} AND ${sql.raw(higherPriorityTargetsAbsent("e", "supplier_id"))}`;
  }
  return sql`e.factory_supplier_id = ${partyId} AND ${sql.raw(higherPriorityTargetsAbsent("e", "factory_supplier_id"))}`;
}

export interface EntryRow extends Record<string, unknown> {
  entry_id: number;
  voucher_id: number;
  voucher_number: string;
  voucher_type: string;
  booked_on: string;
  voucher_currency: string;
  currency: string | null;
  native_debit: string | null;
  native_credit: string | null;
  base_debit: string;
  base_credit: string;
}

interface AllocationRow extends Record<string, unknown> {
  id: number;
  charge_entry_id: number;
  settlement_entry_id: number;
  amount: string;
  currency: string;
}

export async function loadEntriesTx(tx: DbTransaction, input: PartyOpenItemTarget): Promise<EntryRow[]> {
  const { companyId, partyId, domain } = input;
  const owned = ownershipPredicate(domain, companyId, partyId);
  const asOf = input.asOfDate ? sql`AND COALESCE(v.effective_date,v.voucher_date) <= ${input.asOfDate}::date` : sql``;
  const data = await tx.execute(sql`
    SELECT e.id AS entry_id, v.id AS voucher_id,
           v.voucher_number, v.voucher_type,
           COALESCE(v.effective_date,v.voucher_date)::text AS booked_on,
           v.currency AS voucher_currency,
           e.transaction_currency AS currency,
           e.transaction_debit_amount::text AS native_debit,
           e.transaction_credit_amount::text AS native_credit,
           COALESCE(e.base_debit_amount,e.debit_amount,0)::text AS base_debit,
           COALESCE(e.base_credit_amount,e.credit_amount,0)::text AS base_credit
      FROM voucher_entries e JOIN vouchers v ON v.id=e.voucher_id
     WHERE v.company_id=${companyId} AND v.optional=false AND v.deleted_at IS NULL
       AND (${owned}) ${asOf}
       -- An explicitly recognized FX difference closes the USD residual of
       -- an already matched native-currency charge and payment. The matching
       -- report must not turn the FX journal/reversal into a fresh invoice or
       -- unallocated payment. Both remain fully posted in the GL.
       AND NOT EXISTS (
         SELECT 1 FROM accounting_fx_realizations fx
          WHERE fx.company_id=v.company_id
            AND (fx.voucher_id=v.id OR fx.voucher_id=v.reversal_of_voucher_id)
       )
     ORDER BY COALESCE(v.effective_date,v.voucher_date),v.id,e.id
  `);
  return resultRows<EntryRow>(data);
}

export async function ensurePartyExistsTx(
  tx: DbTransaction,
  input: PartyOpenItemTarget
): Promise<{ opening_balance: string | null; opening_balance_side: string | null; payment_terms_days: number | null }> {
  // Domain is an enum, so these are fixed trusted table names, never user SQL.
  const table = { customer: "customers", supplier: "suppliers", factory_supplier: "factory_suppliers" }[input.domain];
  // factory_suppliers has is_active, but no deleted_at column.
  const active = input.domain === "factory_supplier" ? sql`` : sql`AND deleted_at IS NULL`;
  const side = input.domain === "customer" ? sql`opening_balance_side` : sql`NULL::text`;
  const terms = input.domain === "customer" ? sql`payment_terms_days` : sql`NULL::integer`;
  const row = resultRows<{
    id: number;
    opening_balance: string | null;
    opening_balance_side: string | null;
    payment_terms_days: number | null;
  }>(
    await tx.execute(sql`
    SELECT id, opening_balance::text, ${side} AS opening_balance_side,
      ${terms} AS payment_terms_days FROM ${sql.raw(table)}
    WHERE id=${input.partyId} AND company_id=${input.companyId} ${active} LIMIT 1
  `)
  )[0];
  if (!row) throw new OpenItemError("OPEN_ITEM_PARTY_NOT_FOUND", "Party does not belong to this company", 404);
  return row;
}

export async function loadAllocationsTx(tx: DbTransaction, input: PartyOpenItemTarget): Promise<AllocationRow[]> {
  const asOf = input.asOfDate
    ? sql`AND m.applied_on <= ${input.asOfDate}::date
        AND (m.voided_at IS NULL OR m.voided_at::date > ${input.asOfDate}::date)`
    : sql`AND m.voided_at IS NULL`;
  return resultRows<AllocationRow>(
    await tx.execute(sql`
    SELECT m.id,m.charge_entry_id,m.settlement_entry_id,m.amount::text,m.currency
    FROM accounting_open_item_matches m
    JOIN voucher_entries charge ON charge.id=m.charge_entry_id
    JOIN vouchers cv ON cv.id=charge.voucher_id AND cv.company_id=m.company_id
      AND cv.deleted_at IS NULL AND cv.optional=false
    JOIN voucher_entries payment ON payment.id=m.settlement_entry_id
    JOIN vouchers pv ON pv.id=payment.voucher_id AND pv.company_id=m.company_id
      AND pv.deleted_at IS NULL AND pv.optional=false
    WHERE m.company_id=${input.companyId} AND m.domain=${input.domain}
      AND m.party_id=${input.partyId} ${asOf}
  `)
  );
}
