/**
 * The open-item allocation rule (accounting audit phase 25, AR-4), pure.
 *
 * Owner decision (decided by default): automatic FIFO by due date. Given a
 * party's items and its live allocation rows, the plan
 *
 *   1. releases what no longer fits: an allocation whose item is gone (the
 *      voucher deleted, reversed into nothing, no longer the party's) or that
 *      takes more than the item now holds (edited down) — newest first, the
 *      automatic rows before the manual and note rows;
 *   2. allocates every remaining credit (receipts, payments, credit notes,
 *      advances; the oldest booked first, the opening before any voucher) to
 *      the open invoices in due-date order (the opening first, then by due
 *      date, booked date, voucher id).
 *
 * The same function serves the persisting service (allocationService.ts) and
 * the reports (agingReport.ts), so a report always shows what the next
 * allocation run will write.
 */
import type Decimal from "decimal.js";

import { MoneyDecimal } from "../../../lib/money";

export type AllocationMethod = "auto_fifo" | "manual" | "note";

export interface OpenItem {
  /** `opening` or the voucher id as text. */
  key: string;
  voucherId: number | null;
  voucherNumber: string | null;
  voucherType: string | null;
  /** YYYY-MM-DD, null for the opening. */
  bookedOn: string | null;
  /** YYYY-MM-DD, null for the opening (treated as the oldest). */
  dueDate: string | null;
  /** Book amount of the item, positive. */
  amount: Decimal;
}

export interface ExistingAllocation {
  id: number;
  invoiceKey: string;
  paymentKey: string;
  amount: Decimal;
  method: AllocationMethod;
  /** Ordering of creation (id order is enough). */
  sequence: number;
}

export interface PlannedAllocation {
  invoiceKey: string;
  paymentKey: string;
  amount: Decimal;
}

export interface OpenItemState {
  item: OpenItem;
  allocated: Decimal;
  remaining: Decimal;
}

export interface FifoPlan {
  releases: number[];
  creates: PlannedAllocation[];
  invoices: OpenItemState[];
  credits: OpenItemState[];
}

const ZERO = new MoneyDecimal(0);

const METHOD_RELEASE_ORDER: Record<AllocationMethod, number> = { auto_fifo: 0, manual: 1, note: 2 };

function invoiceOrder(a: OpenItem, b: OpenItem): number {
  if (a.voucherId === null || b.voucherId === null) return a.voucherId === null ? (b.voucherId === null ? 0 : -1) : 1;
  return (
    (a.dueDate ?? "").localeCompare(b.dueDate ?? "") ||
    (a.bookedOn ?? "").localeCompare(b.bookedOn ?? "") ||
    a.voucherId - b.voucherId
  );
}

function creditOrder(a: OpenItem, b: OpenItem): number {
  if (a.voucherId === null || b.voucherId === null) return a.voucherId === null ? (b.voucherId === null ? 0 : -1) : 1;
  return (a.bookedOn ?? "").localeCompare(b.bookedOn ?? "") || a.voucherId - b.voucherId;
}

/**
 * `releaseMissing`: release allocations whose item is not in the lists (true
 * when the lists hold every posted item; false for an as-of view, where a
 * later item is simply not loaded and its allocations are ignored).
 */
export function planFifoAllocations(input: {
  invoices: readonly OpenItem[];
  credits: readonly OpenItem[];
  allocations: readonly ExistingAllocation[];
  releaseMissing: boolean;
  /** Persisting only the releases (a read that must not invent allocations). */
  allocate?: boolean;
}): FifoPlan {
  const invoiceState = new Map(input.invoices.map((item) => [item.key, { item, allocated: ZERO, remaining: ZERO }]));
  const creditState = new Map(input.credits.map((item) => [item.key, { item, allocated: ZERO, remaining: ZERO }]));
  const releases: number[] = [];

  // Newest first within each method, automatic rows released before manual / note rows.
  const ordered = [...input.allocations].sort(
    (a, b) => METHOD_RELEASE_ORDER[a.method] - METHOD_RELEASE_ORDER[b.method] || b.sequence - a.sequence
  );
  const invoiceTaken = new Map<string, Decimal>();
  const creditTaken = new Map<string, Decimal>();
  for (const row of input.allocations) {
    invoiceTaken.set(row.invoiceKey, (invoiceTaken.get(row.invoiceKey) ?? ZERO).plus(row.amount));
    creditTaken.set(row.paymentKey, (creditTaken.get(row.paymentKey) ?? ZERO).plus(row.amount));
  }
  const kept: ExistingAllocation[] = [];
  for (const row of ordered) {
    const invoice = invoiceState.get(row.invoiceKey);
    const credit = creditState.get(row.paymentKey);
    if (!invoice || !credit) {
      if (input.releaseMissing) {
        releases.push(row.id);
        invoiceTaken.set(row.invoiceKey, (invoiceTaken.get(row.invoiceKey) ?? ZERO).minus(row.amount));
        creditTaken.set(row.paymentKey, (creditTaken.get(row.paymentKey) ?? ZERO).minus(row.amount));
      }
      continue;
    }
    const overInvoice = (invoiceTaken.get(row.invoiceKey) ?? ZERO).greaterThan(invoice.item.amount);
    const overCredit = (creditTaken.get(row.paymentKey) ?? ZERO).greaterThan(credit.item.amount);
    if (overInvoice || overCredit) {
      releases.push(row.id);
      invoiceTaken.set(row.invoiceKey, (invoiceTaken.get(row.invoiceKey) ?? ZERO).minus(row.amount));
      creditTaken.set(row.paymentKey, (creditTaken.get(row.paymentKey) ?? ZERO).minus(row.amount));
      continue;
    }
    kept.push(row);
  }
  for (const row of kept) {
    const invoice = invoiceState.get(row.invoiceKey)!;
    const credit = creditState.get(row.paymentKey)!;
    invoice.allocated = invoice.allocated.plus(row.amount);
    credit.allocated = credit.allocated.plus(row.amount);
  }
  for (const state of [...invoiceState.values(), ...creditState.values()]) {
    state.remaining = state.item.amount.minus(state.allocated);
  }

  const creates: PlannedAllocation[] = [];
  if (input.allocate !== false) {
    const openInvoices = [...invoiceState.values()]
      .filter((state) => state.remaining.greaterThan(0))
      .sort((a, b) => invoiceOrder(a.item, b.item));
    const openCredits = [...creditState.values()]
      .filter((state) => state.remaining.greaterThan(0))
      .sort((a, b) => creditOrder(a.item, b.item));
    let index = 0;
    for (const credit of openCredits) {
      while (credit.remaining.greaterThan(0) && index < openInvoices.length) {
        const invoice = openInvoices[index];
        const part = MoneyDecimal.min(credit.remaining, invoice.remaining);
        creates.push({ invoiceKey: invoice.item.key, paymentKey: credit.item.key, amount: part });
        credit.remaining = credit.remaining.minus(part);
        credit.allocated = credit.allocated.plus(part);
        invoice.remaining = invoice.remaining.minus(part);
        invoice.allocated = invoice.allocated.plus(part);
        if (!invoice.remaining.greaterThan(0)) index += 1;
      }
    }
  }

  return { releases, creates, invoices: [...invoiceState.values()], credits: [...creditState.values()] };
}
