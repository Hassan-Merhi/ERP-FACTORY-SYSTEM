/**
 * AR/AP credit and debit notes that reference an invoice (accounting audit
 * phase 25, AR-7; owner decision decided by default):
 *
 *   - a Credit Note for a customer credits the customer (it replaces the cash
 *     refund line) and names the customer's invoice it reduces; a Debit Note
 *     for a supplier debits the supplier and names the supplier's invoice;
 *   - the invoice must be an open invoice of that party in the company, and
 *     the note is allocated to it (allocation method `note`, allocationService);
 *   - a customer return restocks at the ORIGINAL cost: each returned item's
 *     inventory cost is the cost the invoice's sale lines moved
 *     (sales_items.value_moved, else total_cost, per unit); an item that is
 *     not on the invoice, or more than was sold less what earlier notes on
 *     that invoice returned, is refused. An invoice with no sale lines (a
 *     journal invoice) keeps the cost entered on the note;
 *   - no tax lines: no tax is configured in the system.
 */
import { sql } from "drizzle-orm";
import type Decimal from "decimal.js";

import { db, type DatabaseOrTransaction, type DbTransaction } from "../../../db";
import { HttpError } from "../../../lib/httpHandlers";
import { MoneyDecimal, toMoney } from "../../../lib/money";
import type { AllocationPartyKind } from "./allocationEvents";
import { loadPartyOpenItems } from "./openItems";

export interface NoteParty {
  kind: Extract<AllocationPartyKind, "customer" | "supplier">;
  id: number;
  invoiceVoucherId: number;
}

/** The party a note names (body fields `customerId` / `supplierId` + `invoiceVoucherId`), or null for a cash note. */
export function noteParty(noteType: string, body: Record<string, unknown>): NoteParty | null {
  const customerId = Number(body.customerId);
  const supplierId = Number(body.supplierId);
  const invoiceVoucherId = Number(body.invoiceVoucherId);
  const hasCustomer = body.customerId !== undefined && body.customerId !== null && body.customerId !== "";
  const hasSupplier = body.supplierId !== undefined && body.supplierId !== null && body.supplierId !== "";
  if (!hasCustomer && !hasSupplier) return null;
  if (hasCustomer && hasSupplier) throw new HttpError(400, "A note names either a customer or a supplier");
  if (noteType === "Credit Note" && !hasCustomer) throw new HttpError(400, "A credit note is for a customer");
  if (noteType === "Debit Note" && !hasSupplier) throw new HttpError(400, "A debit note is for a supplier");
  const id = hasCustomer ? customerId : supplierId;
  if (!Number.isSafeInteger(id) || id <= 0) throw new HttpError(400, "Invalid party");
  if (!Number.isSafeInteger(invoiceVoucherId) || invoiceVoucherId <= 0) {
    throw new HttpError(400, "invoiceVoucherId is required: a note references the invoice it adjusts");
  }
  return { kind: hasCustomer ? "customer" : "supplier", id, invoiceVoucherId };
}

/** Refuses a note whose invoice is not an open invoice of the party in the company. */
export async function assertOpenInvoiceTx(
  tx: DbTransaction,
  companyId: number,
  party: NoteParty
): Promise<{ voucherNumber: string | null; amount: Decimal }> {
  const [items] = await loadPartyOpenItems(tx, { companyId, kind: party.kind, partyIds: [party.id] });
  const invoice = items?.invoices.find((item) => item.voucherId === party.invoiceVoucherId);
  if (!invoice) {
    throw new HttpError(
      409,
      `Voucher ${party.invoiceVoucherId} is not an invoice of this ${party.kind} in this company`
    );
  }
  return { voucherNumber: invoice.voucherNumber, amount: invoice.amount };
}

interface ReturnLine {
  stockItemId: unknown;
  quantity: unknown;
  inventoryCost?: unknown;
}

/**
 * Sets each customer-return line's inventory cost to the invoice's original
 * unit cost (see the header). Mutates and returns the lines.
 */
export async function applyOriginalCostTx<T extends ReturnLine>(
  tx: DbTransaction,
  companyId: number,
  invoiceVoucherId: number,
  lines: T[]
): Promise<T[]> {
  const sold = await tx.execute<
    { stock_item_id: number; quantity: string; value: string } & Record<string, unknown>
  >(sql`
    SELECT si.stock_item_id, SUM(si.quantity)::text AS quantity,
           SUM(COALESCE(si.value_moved, si.total_cost))::text AS value
      FROM sales_items si
      JOIN vouchers v ON v.id = si.voucher_id AND v.company_id = ${companyId}
     WHERE si.voucher_id = ${invoiceVoucherId}
     GROUP BY si.stock_item_id
  `);
  if (sold.rows.length === 0) return lines;
  const returned = await tx.execute<{ stock_item_id: number; quantity: string } & Record<string, unknown>>(sql`
    SELECT cni.stock_item_id, SUM(cni.quantity)::text AS quantity
      FROM party_open_item_allocations a
      JOIN vouchers v ON v.id = a.payment_voucher_id AND v.deleted_at IS NULL
      JOIN credit_note_items cni ON cni.voucher_id = v.id
     WHERE a.company_id = ${companyId} AND a.invoice_voucher_id = ${invoiceVoucherId}
       AND a.method = 'note' AND a.released_at IS NULL
     GROUP BY cni.stock_item_id
  `);
  const soldByItem = new Map(
    sold.rows.map((row) => [Number(row.stock_item_id), { quantity: toMoney(row.quantity), value: toMoney(row.value) }])
  );
  const returnedByItem = new Map(returned.rows.map((row) => [Number(row.stock_item_id), toMoney(row.quantity)]));
  const asked = new Map<number, Decimal>();
  for (const line of lines) {
    const itemId = Number(line.stockItemId);
    const sale = soldByItem.get(itemId);
    if (!sale || !sale.quantity.greaterThan(0)) {
      throw new HttpError(409, `Item ${itemId} is not on invoice ${invoiceVoucherId}`);
    }
    const total = (asked.get(itemId) ?? new MoneyDecimal(0)).plus(toMoney(line.quantity as string));
    asked.set(itemId, total);
    const available = sale.quantity.minus(returnedByItem.get(itemId) ?? 0);
    if (total.greaterThan(available)) {
      throw new HttpError(
        409,
        `Item ${itemId}: returning ${total.toFixed()} but invoice ${invoiceVoucherId} has ${available.toFixed()} left to return`
      );
    }
    line.inventoryCost = sale.value.dividedBy(sale.quantity).toDecimalPlaces(6).toFixed();
  }
  return lines;
}

/** Whether a note was issued against an invoice (an allocation of method `note`, live or released). */
export async function noteReferencesInvoice(
  noteVoucherId: number,
  executor: DatabaseOrTransaction = db
): Promise<boolean> {
  const result = await executor.execute(sql`
    SELECT 1 FROM party_open_item_allocations WHERE payment_voucher_id = ${noteVoucherId} AND method = 'note' LIMIT 1
  `);
  return result.rows.length > 0;
}
