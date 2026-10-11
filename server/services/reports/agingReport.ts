/**
 * AR/AP aging on open items (accounting audit wave 17 A, phase 25 AR-4).
 *
 * GET /api/reports/aging?kind=customer|supplier|factorySupplier|employee&asOf=YYYY-MM-DD
 *
 *   - each party's balance is the engine's closing as of `asOf` (everything
 *     posted without it), in this company's vouchers, by
 *     COALESCE(effective_date, voucher_date), each line owned once by the
 *     engine's rules (partyLineRules.ts);
 *   - the items are the party's vouchers netted per voucher
 *     (allocations/openItems.ts): invoices (what raised the balance) and
 *     credits (receipts, payments, credit/debit notes, advances);
 *   - credits settle invoices through the allocation table (manual, note and
 *     automatic rows), and what no row settles yet is projected by the same
 *     FIFO-by-due-date rule the allocation run writes (`pendingAllocations`
 *     counts the projected rows not yet written);
 *   - an open invoice is aged by days past its due date (booked date + the
 *     party's payment terms, 30 days when it has none), counted to the
 *     reference date (`asOf`, else the company's business date): `notDue`,
 *     `days1to30`, `days31to60`, `days61to90`, `over90`; the master opening
 *     has no date and is in `opening`; an invoice booked after the reference
 *     date is in `future`;
 *   - credits no invoice takes are listed (`unappliedCredits`) and in the
 *     `unappliedCredit` bucket (negative).
 * The buckets of a party always add up to its engine balance, and the report
 * carries the tie-out of its total to the engine's rows of the kind (the
 * control account's party detail).
 *
 * Phase 25 (AR-3, owner decision decided by default): amounts are the book
 * amounts, debit_amount / credit_amount — the ledger's 2-dp columns, the same
 * as the trial balance — no longer the historical base columns.
 */
import type Decimal from "decimal.js";

import { db, type DatabaseOrTransaction } from "../../db";
import { MoneyDecimal } from "../../lib/money";
import { companyBusinessDate } from "../accounting/companyBusinessDate";
import { planFifoAllocations } from "../accounting/allocations/fifoPlan";
import { loadLiveAllocations, loadPartyOpenItems } from "../accounting/allocations/openItems";

export type AgingKind = "customer" | "supplier" | "factorySupplier" | "employee";
export const AGING_KINDS: readonly AgingKind[] = ["customer", "supplier", "factorySupplier", "employee"];

export const AGING_BUCKETS = [
  "future",
  "notDue",
  "days1to30",
  "days31to60",
  "days61to90",
  "over90",
  "opening",
  "unappliedCredit",
] as const;
export type AgingBucket = (typeof AGING_BUCKETS)[number];

export interface AgingOpenItem {
  voucherId: number | null;
  voucherNumber: string | null;
  voucherType: string | null;
  bookedOn: string | null;
  dueDate: string | null;
  amount: string;
  open: string;
  /** Days past the due date at the reference date (negative = not due yet); null for the opening. */
  daysPastDue: number | null;
  bucket: AgingBucket;
}

export interface AgingCredit {
  voucherId: number | null;
  voucherNumber: string | null;
  voucherType: string | null;
  bookedOn: string | null;
  amount: string;
  unapplied: string;
}

export interface AgingPartyRow {
  id: number;
  code: string | null;
  name: string;
  /** Owed to us (customers) or by us (suppliers, factory suppliers, employees), positive; negative when in credit. */
  balance: string;
  paymentTermsDays: number;
  buckets: Record<AgingBucket, string>;
  openItems: AgingOpenItem[];
  unappliedCredits: AgingCredit[];
  /** Allocations the report projected that the allocation run has not written yet. */
  pendingAllocations: number;
}

export interface AgingReport {
  companyId: number;
  kind: AgingKind;
  basis: "ledger";
  /** Book amounts: debit_amount / credit_amount (owner decision AR-3). */
  amountBasis: "book";
  allocationMethod: "fifo_by_due_date";
  asOf: string | null;
  /** The date ages are counted from. */
  referenceDate: string;
  bucketDays: {
    notDue: "not yet due";
    days1to30: "1-30 past due";
    days31to60: "31-60 past due";
    days61to90: "61-90 past due";
    over90: ">90 past due";
  };
  parties: AgingPartyRow[];
  totals: { balance: string; buckets: Record<AgingBucket, string> };
  /**
   * The aging total against the engine's rows of the kind (the trial
   * balance's party detail under the control account): `tied` when equal.
   */
  controlTieOut: { engineTotal: string; agingTotal: string; difference: string; tied: boolean };
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

export function agingBucketOf(item: { bookedOn: string | null; dueDate: string | null }, referenceDate: string) {
  if (item.dueDate === null || item.bookedOn === null) return { bucket: "opening" as AgingBucket, daysPastDue: null };
  const daysPastDue = daysBetween(item.dueDate, referenceDate);
  let bucket: AgingBucket;
  if (daysBetween(item.bookedOn, referenceDate) < 0) bucket = "future";
  else if (daysPastDue <= 0) bucket = "notDue";
  else if (daysPastDue <= 30) bucket = "days1to30";
  else if (daysPastDue <= 60) bucket = "days31to60";
  else if (daysPastDue <= 90) bucket = "days61to90";
  else bucket = "over90";
  return { bucket, daysPastDue };
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
  const parties = await loadPartyOpenItems(executor, { companyId, kind, asOf });
  const allocations = await loadLiveAllocations(executor, { companyId, kind });

  const totals = emptyBuckets();
  let agingTotal = new MoneyDecimal(0);
  let engineTotal = new MoneyDecimal(0);
  const rows: AgingPartyRow[] = [];
  for (const party of parties) {
    engineTotal = engineTotal.plus(party.owed);
    const plan = planFifoAllocations({
      invoices: party.invoices,
      credits: party.credits,
      allocations: allocations.get(party.partyId) ?? [],
      // A full view drops rows whose source is gone, as the run will; an
      // as-of view does not load later items and ignores their rows.
      releaseMissing: asOf === null,
    });
    const buckets = emptyBuckets();
    const openItems: AgingOpenItem[] = [];
    for (const state of plan.invoices) {
      if (!state.remaining.greaterThan(0)) continue;
      const { bucket, daysPastDue } = agingBucketOf(state.item, referenceDate);
      buckets[bucket] = buckets[bucket].plus(state.remaining);
      openItems.push({
        voucherId: state.item.voucherId,
        voucherNumber: state.item.voucherNumber,
        voucherType: state.item.voucherType,
        bookedOn: state.item.bookedOn,
        dueDate: state.item.dueDate,
        amount: state.item.amount.toFixed(2),
        open: state.remaining.toFixed(2),
        daysPastDue,
        bucket,
      });
    }
    const unappliedCredits: AgingCredit[] = [];
    for (const state of plan.credits) {
      if (!state.remaining.greaterThan(0)) continue;
      buckets.unappliedCredit = buckets.unappliedCredit.minus(state.remaining);
      unappliedCredits.push({
        voucherId: state.item.voucherId,
        voucherNumber: state.item.voucherNumber,
        voucherType: state.item.voucherType,
        bookedOn: state.item.bookedOn,
        amount: state.item.amount.toFixed(2),
        unapplied: state.remaining.toFixed(2),
      });
    }
    const balance = AGING_BUCKETS.reduce((sum, bucket) => sum.plus(buckets[bucket]), new MoneyDecimal(0));
    if (balance.isZero() && openItems.length === 0 && unappliedCredits.length === 0) continue;
    for (const bucket of AGING_BUCKETS) totals[bucket] = totals[bucket].plus(buckets[bucket]);
    agingTotal = agingTotal.plus(balance);
    openItems.sort((a, b) => (a.dueDate ?? "").localeCompare(b.dueDate ?? ""));
    rows.push({
      id: party.partyId,
      code: party.code,
      name: party.name,
      balance: balance.toFixed(2),
      paymentTermsDays: party.paymentTermsDays,
      buckets: money(buckets),
      openItems,
      unappliedCredits,
      pendingAllocations: plan.creates.length + plan.releases.length,
    });
  }
  rows.sort(
    (a, b) => new MoneyDecimal(b.balance).comparedTo(new MoneyDecimal(a.balance)) || a.name.localeCompare(b.name)
  );
  const difference = agingTotal.minus(engineTotal);

  return {
    companyId,
    kind,
    basis: "ledger",
    amountBasis: "book",
    allocationMethod: "fifo_by_due_date",
    asOf,
    referenceDate,
    bucketDays: {
      notDue: "not yet due",
      days1to30: "1-30 past due",
      days31to60: "31-60 past due",
      days61to90: "61-90 past due",
      over90: ">90 past due",
    },
    parties: rows,
    totals: { balance: agingTotal.toFixed(2), buckets: money(totals) },
    controlTieOut: {
      engineTotal: engineTotal.toFixed(2),
      agingTotal: agingTotal.toFixed(2),
      difference: difference.toFixed(2),
      tied: difference.isZero(),
    },
  };
}
