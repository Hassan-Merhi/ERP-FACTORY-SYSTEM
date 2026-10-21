/**
 * Phase 3 — source-document matching for ERP customers, ERP suppliers, and
 * Factory suppliers. Matching is metadata: it NEVER posts journals, nets FX
 * buckets, changes party balances or edits the source vouchers.
 *
 * The canonical party-line ownership predicate comes from partyLineRules;
 * accounting entries and their original historical currency values are read
 * intact. Rent is handled by its already-existing contract/month allocations.
 */
import Decimal from "decimal.js";
import { sql, type SQL } from "drizzle-orm";
import type { DbTransaction } from "../../db";
import { resultRows } from "../../lib/queryResult";
import { customerOwnedLinePredicate, higherPriorityTargetsAbsent, intLiteral } from "./balances/partyLineRules";
import { companyBusinessDate } from "./companyBusinessDate";
import { assertTransactionCompanyScope } from "../security/transactionCompanyScope";
import { writeAuditEvent } from "../audit";
import { loadHeldChargeSnapshot } from "../../routes/factory/customers-core/heldUnfinalizedCustomerCharges";

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

const DECIMAL_DP = 6;
const DOMAIN_LIST = ["customer", "supplier", "factory_supplier"] as const;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function isValidDate(v: string): boolean {
  if (!DATE_RE.test(v)) return false;
  const d = new Date(v + "T00:00:00Z");
  return !Number.isNaN(d.valueOf()) && d.toISOString().slice(0, 10) === v;
}
function positiveId(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new OpenItemError("OPEN_ITEM_ID_INVALID", `${field} must be a positive integer`, 400);
  return value;
}
function money(value: unknown): Decimal {
  const amount = new Decimal(String(value ?? "0"));
  if (!amount.isFinite()) throw new OpenItemError("OPEN_ITEM_AMOUNT_INVALID", "Invalid financial amount");
  return amount;
}
function fmt(value: Decimal): string {
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
interface EntryRow extends Record<string, unknown> {
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
async function loadEntriesTx(tx: DbTransaction, input: PartyOpenItemTarget): Promise<EntryRow[]> {
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
async function ensurePartyExistsTx(
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
async function loadAllocationsTx(tx: DbTransaction, input: PartyOpenItemTarget): Promise<AllocationRow[]> {
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
function rowValue(row: EntryRow): { debit: Decimal; credit: Decimal; currency: string; verified: boolean } {
  const code = String(row.currency ?? "")
    .trim()
    .toUpperCase();
  const header = String(row.voucher_currency ?? "USD")
    .trim()
    .toUpperCase();
  const nativeAvailable = !!code && row.native_debit !== null && row.native_credit !== null;
  if (nativeAvailable) {
    return { debit: money(row.native_debit), credit: money(row.native_credit), currency: code, verified: true };
  }
  // A legacy non-USD line with no native amounts must never be matched based
  // on a guessed FX rate. Its base amount is displayed but marked unverified.
  return { debit: money(row.base_debit), credit: money(row.base_credit), currency: "USD", verified: header === "USD" };
}
export async function loadPartyOpenItemsTx(tx: DbTransaction, target: PartyOpenItemTarget): Promise<OpenItemSummary> {
  validateOpenItemTarget(target);
  await assertTransactionCompanyScope(tx, target.companyId);
  const party = await ensurePartyExistsTx(tx, target);
  const [entries, allocations] = await Promise.all([loadEntriesTx(tx, target), loadAllocationsTx(tx, target)]);
  const allocated = new Map<number, Decimal>();
  const links = new Map<number, Array<{ matchId: number; otherEntryId: number; amount: string }>>();
  for (const m of allocations) {
    const amount = money(m.amount);
    for (const [id, other] of [
      [m.charge_entry_id, m.settlement_entry_id],
      [m.settlement_entry_id, m.charge_entry_id],
    ]) {
      const entryId = Number(id);
      allocated.set(entryId, (allocated.get(entryId) ?? new Decimal(0)).plus(amount));
      links.set(entryId, [
        ...(links.get(entryId) ?? []),
        { matchId: Number(m.id), otherEntryId: Number(other), amount: fmt(amount) },
      ]);
    }
  }
  // Factory customer charge vouchers tied to unfinalized orders are held out
  // of operational customer balances: never offer them for invoice matching.
  const held =
    target.domain === "customer"
      ? (await loadHeldChargeSnapshot(target.companyId, [target.partyId], target.asOfDate)).voucherIds
      : new Set<number>();
  const currencies: OpenItemSummary["currencies"] = {};
  const asOfBusinessDate = target.asOfDate ?? (await companyBusinessDate(target.companyId, tx));
  const items: PartyOpenItem[] = [];
  for (const entry of entries) {
    if (held.has(Number(entry.voucher_id))) continue;
    const value = rowValue(entry);
    const charge = target.domain === "customer" ? value.debit : value.credit;
    const settlement = target.domain === "customer" ? value.credit : value.debit;
    if (charge.isZero() && settlement.isZero()) continue;
    if (charge.gt(0) && settlement.gt(0)) continue; // ambiguous legacy line, not a standalone item
    const isCharge = charge.gt(0);
    const original = isCharge ? charge : settlement;
    const matched = allocated.get(Number(entry.entry_id)) ?? new Decimal(0);
    const outstanding = Decimal.max(new Decimal(0), original.minus(matched));
    const side = isCharge ? "charge" : "settlement";
    const days = Number(party.payment_terms_days);
    const invoiceLike = /^(sales?|invoice)$/i.test(String(entry.voucher_type).trim());
    const dueDate =
      isCharge &&
      target.domain === "customer" &&
      invoiceLike &&
      party.payment_terms_days !== null &&
      Number.isInteger(days) &&
      days >= 0 &&
      days <= 3650
        ? new Date(Date.parse(String(entry.booked_on).slice(0, 10) + "T00:00:00Z") + days * 86400000)
            .toISOString()
            .slice(0, 10)
        : null;
    const overdueDays =
      dueDate && outstanding.gt(0) && dueDate < asOfBusinessDate
        ? Math.max(
            0,
            Math.round((Date.parse(asOfBusinessDate + "T00:00:00Z") - Date.parse(dueDate + "T00:00:00Z")) / 86400000)
          )
        : null;
    items.push({
      entryId: Number(entry.entry_id),
      voucherId: Number(entry.voucher_id),
      voucherNumber: String(entry.voucher_number),
      voucherType: String(entry.voucher_type),
      businessDate: String(entry.booked_on),
      dueDate,
      overdueDays,
      side,
      currency: value.currency,
      originalAmount: fmt(original),
      matchedAmount: fmt(matched),
      outstandingAmount: fmt(outstanding),
      currencyVerified: value.verified,
      status: matched.gt(original)
        ? "inconsistent"
        : outstanding.isZero()
          ? "settled"
          : matched.isZero()
            ? "open"
            : "partial",
      allocations: links.get(Number(entry.entry_id)) ?? [],
    });
    const c = currencies[value.currency] ?? {
      charges: "0.000000",
      settlements: "0.000000",
      unapplied: "0.000000",
      outstanding: "0.000000",
    };
    c[isCharge ? "charges" : "settlements"] = fmt(money(c[isCharge ? "charges" : "settlements"]).plus(original));
    c[isCharge ? "outstanding" : "unapplied"] = fmt(money(c[isCharge ? "outstanding" : "unapplied"]).plus(outstanding));
    currencies[value.currency] = c;
  }
  return {
    companyId: target.companyId,
    domain: target.domain,
    partyId: target.partyId,
    asOfDate: target.asOfDate ?? null,
    items,
    currencies,
    // Legacy party opening balances are not individual posted documents: never
    // invent a synthetic invoice or silently allocate a payment to them.
    openingBalance: {
      amount: fmt(money(party.opening_balance)),
      side: party.opening_balance_side,
      includedInMatching: false,
    },
  };
}

export interface ApplyOpenItemMatch extends PartyOpenItemTarget {
  chargeEntryId: number;
  settlementEntryId: number;
  amount: string;
  idempotencyKey: string;
  actor: { userId: string; username: string };
  reason?: string | null;
}
export async function applyPartyOpenItemMatchTx(tx: DbTransaction, input: ApplyOpenItemMatch) {
  validateOpenItemTarget(input);
  const chargeId = positiveId(input.chargeEntryId, "chargeEntryId");
  const paymentId = positiveId(input.settlementEntryId, "settlementEntryId");
  if (chargeId === paymentId) throw new OpenItemError("OPEN_ITEM_SAME_ENTRY", "Charge and settlement must differ", 400);
  const amount = money(input.amount);
  if (amount.lte(0) || amount.decimalPlaces() > DECIMAL_DP)
    throw new OpenItemError(
      "OPEN_ITEM_AMOUNT_INVALID",
      "Match amount must be positive, with at most six decimals",
      400
    );
  if (!/^[A-Za-z0-9._:-]{1,191}$/.test(input.idempotencyKey))
    throw new OpenItemError("OPEN_ITEM_KEY_INVALID", "Invalid idempotency key", 400);
  const appliedOn = await companyBusinessDate(input.companyId, tx);
  // Matching is dated accounting metadata: do not change it inside closed books.
  await tx.execute(sql`SELECT erp_assert_accounting_date_open(${input.companyId},${appliedOn}::date)`);
  // All allocations for one party serialize to avoid matching the same
  // available payment twice. The idempotency lookup and inserts share this tx.
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`open-item:${input.companyId}:${input.domain}:${input.partyId}`}))`
  );
  const prior = resultRows<{
    id: number;
    charge_entry_id: number;
    settlement_entry_id: number;
    amount: string;
    voided_at: string | null;
  }>(
    await tx.execute(sql`SELECT id,charge_entry_id,settlement_entry_id,amount::text,voided_at
      FROM accounting_open_item_matches
      WHERE company_id=${input.companyId} AND idempotency_key=${input.idempotencyKey} LIMIT 1`)
  )[0];
  if (prior) {
    if (
      prior.voided_at ||
      Number(prior.charge_entry_id) !== chargeId ||
      Number(prior.settlement_entry_id) !== paymentId ||
      !money(prior.amount).eq(amount)
    )
      throw new OpenItemError(
        "OPEN_ITEM_IDEMPOTENCY_CONFLICT",
        "The request key already belongs to another/voided match"
      );
    return { id: Number(prior.id), replayed: true };
  }
  // Reading as-of today avoids matching future-dated accounting entries.
  const summary = await loadPartyOpenItemsTx(tx, {
    companyId: input.companyId,
    domain: input.domain,
    partyId: input.partyId,
    asOfDate: appliedOn,
  });
  const charge = summary.items.find((item) => item.entryId === chargeId && item.side === "charge");
  const payment = summary.items.find((item) => item.entryId === paymentId && item.side === "settlement");
  if (!charge || !payment)
    throw new OpenItemError(
      "OPEN_ITEM_NOT_ELIGIBLE",
      "Both entries must be live, posted, company-owned charges/settlements of this party"
    );
  if (!charge.currencyVerified || !payment.currencyVerified)
    throw new OpenItemError(
      "OPEN_ITEM_CURRENCY_UNVERIFIED",
      "Legacy foreign-currency amounts require reviewed normalization before matching"
    );
  if (charge.currency !== payment.currency)
    throw new OpenItemError(
      "OPEN_ITEM_CURRENCY_MISMATCH",
      "A match cannot convert currencies; exchange settlement requires a separate FX posting"
    );
  if (amount.gt(money(charge.outstandingAmount)) || amount.gt(money(payment.outstandingAmount)))
    throw new OpenItemError("OPEN_ITEM_OVERALLOCATION", "Match exceeds the available charge or settlement");
  const inserted = resultRows<{ id: number }>(
    await tx.execute(sql`
    INSERT INTO accounting_open_item_matches
      (company_id,domain,party_id,charge_entry_id,settlement_entry_id,amount,currency,
       applied_on,idempotency_key,created_by,reason)
    VALUES (${input.companyId},${input.domain},${input.partyId},${chargeId},${paymentId},
      ${fmt(amount)}::numeric,${charge.currency},${appliedOn}::date,
      ${input.idempotencyKey},${input.actor.userId},${input.reason ?? null})
    RETURNING id
  `)
  )[0];
  if (!inserted) throw new OpenItemError("OPEN_ITEM_WRITE_FAILED", "Match could not be saved");
  await writeAuditEvent(
    {
      companyId: input.companyId,
      userId: input.actor.userId,
      username: input.actor.username,
      action: "create",
      tableName: "accounting_open_item_matches",
      recordId: Number(inserted.id),
      recordIdentifier: input.idempotencyKey,
      changes: {
        domain: { new: input.domain },
        partyId: { new: input.partyId },
        chargeEntryId: { new: chargeId },
        settlementEntryId: { new: paymentId },
        amount: { new: fmt(amount) },
        currency: { new: charge.currency },
        reason: { new: input.reason ?? null },
      },
    },
    tx
  );
  return { id: Number(inserted.id), replayed: false };
}
export async function voidPartyOpenItemMatchTx(
  tx: DbTransaction,
  input: {
    companyId: number;
    matchId: number;
    actor: { userId: string; username: string };
    reason: string;
  }
) {
  positiveId(input.companyId, "companyId");
  positiveId(input.matchId, "matchId");
  if (!input.reason.trim()) throw new OpenItemError("OPEN_ITEM_REASON_REQUIRED", "Reason is required", 400);
  await assertTransactionCompanyScope(tx, input.companyId);
  const record = resultRows<{
    id: number;
    domain: OpenItemDomain;
    party_id: number;
    voided_at: string | null;
    applied_on: string;
  }>(
    await tx.execute(sql`SELECT id,domain,party_id,voided_at::text,applied_on::text FROM accounting_open_item_matches
      WHERE id=${input.matchId} AND company_id=${input.companyId} FOR UPDATE`)
  )[0];
  if (!record) throw new OpenItemError("OPEN_ITEM_MATCH_NOT_FOUND", "Match not found", 404);
  if (record.voided_at) throw new OpenItemError("OPEN_ITEM_MATCH_VOIDED", "Match is already voided");
  // A realized FX voucher changes the GL party balance. Its linked
  // allocation cannot be silently cancelled while that journal is active.
  // First reverse the FX journal through the audited voucher reversal flow.
  const recognized = resultRows<{ voucher_id: number; reversed_id: number | null } & Record<string, unknown>>(
    await tx.execute(sql`
      SELECT r.voucher_id,reversal.id AS reversed_id
        FROM accounting_fx_realizations r
        JOIN vouchers v ON v.id=r.voucher_id AND v.company_id=r.company_id
        LEFT JOIN vouchers reversal ON reversal.reversal_of_voucher_id=v.id
          AND reversal.company_id=r.company_id AND reversal.deleted_at IS NULL
       WHERE r.company_id=${input.companyId} AND r.match_id=${input.matchId}
         AND v.deleted_at IS NULL LIMIT 1
    `)
  )[0];
  if (recognized && !recognized.reversed_id)
    throw new OpenItemError(
      "OPEN_ITEM_REALIZED_FX_POSTED",
      `Reverse the realized FX journal #${recognized.voucher_id} before cancelling this match`
    );

  await tx.execute(sql`SELECT erp_assert_accounting_date_open(${input.companyId},${record.applied_on}::date)`);
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`open-item:${input.companyId}:${record.domain}:${record.party_id}`}))`
  );
  await tx.execute(sql`UPDATE accounting_open_item_matches SET
    voided_at=NOW(),voided_by=${input.actor.userId},void_reason=${input.reason}
    WHERE id=${input.matchId} AND company_id=${input.companyId} AND voided_at IS NULL`);
  await writeAuditEvent(
    {
      companyId: input.companyId,
      userId: input.actor.userId,
      username: input.actor.username,
      action: "update",
      tableName: "accounting_open_item_matches",
      recordId: input.matchId,
      recordIdentifier: `open-item:${input.matchId}`,
      changes: { voided: { old: false, new: true }, reason: { new: input.reason } },
    },
    tx
  );
  return { id: input.matchId, voided: true };
}
