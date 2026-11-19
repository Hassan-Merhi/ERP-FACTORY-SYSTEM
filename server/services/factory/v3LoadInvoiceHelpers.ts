// Extracted from ./v3LoadInvoice.ts
import { and, eq, sql } from "drizzle-orm";
import { customerInvoiceSequences, customerOrders, factoryV3Loads } from "@shared/schema";
import type { DbTransaction } from "../../db";
import { toMoney } from "../../lib/money";
import { firstRow } from "../../lib/queryResult";

export const V3_LOAD_NOT_LOADING_MESSAGE = "Can only finalize a load that is currently Loading";

export const V3_LOAD_PROFORMA_MISSING_MESSAGE = "The load's proforma or its customer was not found in this company.";

export const V3_LOAD_EMPTY_MESSAGE = "The load has no bales to invoice.";

export const V3_LOAD_BALES_UNAVAILABLE_MESSAGE =
  "Some bales of this load are no longer in stock. Remove them from the load before finalizing it.";

export const V3_LOAD_BALES_WITHOUT_LOCATION_MESSAGE =
  "Some bales of this load have no stock location. Set their location before finalizing the load.";

export const V3_LOAD_BALES_NOT_ON_PROFORMA_MESSAGE =
  "Some bales of this load have an article that is not on the load's proforma, so they have no price. Add the article to the proforma before finalizing the load.";

export const STOCK_STATUSES = new Set(["IN_STOCK", "RESERVED_FOR_ORDER", "RESERVED_FOR_DISPATCH"]);

export interface V3LoadFinalizeResult {
  load: typeof factoryV3Loads.$inferSelect;
  invoice: { orderId: number; invoiceNumber: string | null; grandTotal: string } | null;
  /** True when the load was already finalized (nothing new was written). */
  alreadyFinalized: boolean;
}

export type LoadBaleRow = {
  bale_id: number;
  bale_reference: string;
  status: string | null;
  deleted_at: string | null;
  erp_location_id: number | null;
  weight_kg: string | null;
  article_code: string | null;
  product_name: string | null;
};

export async function invoiceSummaryTx(tx: DbTransaction, companyId: number, orderId: number) {
  const [order] = await tx
    .select({
      id: customerOrders.id,
      invoiceNumber: customerOrders.invoiceNumber,
      grandTotal: customerOrders.grandTotal,
    })
    .from(customerOrders)
    .where(and(eq(customerOrders.id, orderId), eq(customerOrders.companyId, companyId)));
  return order
    ? { orderId: order.id, invoiceNumber: order.invoiceNumber, grandTotal: toMoney(order.grandTotal).toFixed(2) }
    : null;
}

export async function nextInvoiceNumberTx(tx: DbTransaction, companyId: number): Promise<string> {
  const seqRows = await tx.execute(
    sql`SELECT * FROM customer_invoice_sequences WHERE company_id = ${companyId} FOR UPDATE`
  );
  const seqRow = firstRow<{ next_number?: number; nextNumber?: number }>(seqRows);
  let invoiceNum: number;
  if (!seqRow) {
    const [inserted] = await tx.insert(customerInvoiceSequences).values({ companyId, nextNumber: 1 }).returning();
    invoiceNum = inserted.nextNumber;
  } else {
    invoiceNum = Number(seqRow.next_number ?? seqRow.nextNumber);
  }
  await tx
    .update(customerInvoiceSequences)
    .set({ nextNumber: invoiceNum + 1 })
    .where(eq(customerInvoiceSequences.companyId, companyId));
  return `INV-${String(invoiceNum).padStart(6, "0")}`;
}
