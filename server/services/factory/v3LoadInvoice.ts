/**
 * The factory invoice of a V3 stock-allocation load (accounting audit wave 17
 * B, owner decision 1).
 *
 * Before: `POST /api/factory/v3/loads/:id/finalize` marked the load's bales
 * SOLD and closed the load, outside a transaction, for any signed-in user, and
 * nothing else: no invoice, so no receivable, no revenue and no cost of sales;
 * after the cut-over the bales simply left Factory Finished Goods (the daily
 * factory journal moved the difference to Production Variance).
 *
 * Now the finalize is one transaction that invoices the load the way every
 * other factory sale is invoiced (finalize.ts, dispatch invoicing):
 *
 *   - the load row is locked; a load already finalized with an invoice is
 *     returned as it is, its invoice journal re-synced (re-finalize is
 *     idempotent: no second invoice, no second receivable);
 *   - the load's proforma (and its customer) must exist in the company; each
 *     live bale must still be stock (IN_STOCK or reserved), have an ERP
 *     location (customer_order_bales.location_id) and an article on the
 *     proforma, which gives its price (per bale, or weight × the per-kg rate
 *     of a per-kg line); otherwise the finalize is refused and nothing is
 *     written;
 *   - an invoice number is taken from the company's sequence, a FINALIZED
 *     customer_orders row is written with the load's bales
 *     (customer_order_bales) and its lines and totals
 *     (recalculateOrderTotals), the bales are marked SOLD, the customer's SALE
 *     row is written to customer_balances, and syncFactoryInvoiceTx posts the
 *     invoice journal (INV-GL-{company}-{order}: receivable, revenue, COGS at
 *     the bales' recorded cost) under the same rules as every factory invoice
 *     (only once the company's cut-over applies to the invoice date);
 *   - the load records the order (`customer_order_id`) and one audit row is
 *     written in the transaction.
 *
 * Access: the route needs the Factory Invoicing page with its Invoices tab,
 * the access factory invoicing itself needs (an invoice is created here).
 */
import { and, eq, sql } from "drizzle-orm";
import {
  customerBalances,
  customerInvoiceSequences,
  customerOrderBales,
  customerOrders,
  factoryV3Loads,
} from "@shared/schema";

import type { DbTransaction } from "../../db";
import { HttpError } from "../../lib/httpHandlers";
import { toMoney } from "../../lib/money";
import { firstRow, resultRows } from "../../lib/queryResult";
import { syncFactoryInvoiceTx } from "../accounting/perpetualInventory/factoryInvoice";
import { writeAuditEvent } from "../audit";
import { recalculateOrderTotals } from "../../routes/factory/_helpers";
import { acquireProformaCapacityTransactionLock } from "../../routes/factory/customer-orders/proformaCapacityConcurrency";

export const V3_LOAD_NOT_LOADING_MESSAGE = "Can only finalize a load that is currently Loading";
export const V3_LOAD_PROFORMA_MISSING_MESSAGE = "The load's proforma or its customer was not found in this company.";
export const V3_LOAD_EMPTY_MESSAGE = "The load has no bales to invoice.";
export const V3_LOAD_BALES_UNAVAILABLE_MESSAGE =
  "Some bales of this load are no longer in stock. Remove them from the load before finalizing it.";
export const V3_LOAD_BALES_WITHOUT_LOCATION_MESSAGE =
  "Some bales of this load have no stock location. Set their location before finalizing the load.";
export const V3_LOAD_BALES_NOT_ON_PROFORMA_MESSAGE =
  "Some bales of this load have an article that is not on the load's proforma, so they have no price. Add the article to the proforma before finalizing the load.";

const STOCK_STATUSES = new Set(["IN_STOCK", "RESERVED_FOR_ORDER", "RESERVED_FOR_DISPATCH"]);

/** A load the finalize cannot invoice: nothing is written. */
export class V3LoadFinalizeRefusalError extends HttpError {
  constructor(
    statusCode: number,
    message: string,
    readonly code: string,
    readonly bales: string[] = []
  ) {
    super(statusCode, message);
    this.name = "V3LoadFinalizeRefusalError";
  }

  get body() {
    return { code: this.code, message: this.message, ...(this.bales.length > 0 ? { bales: this.bales } : {}) };
  }
}

export interface V3LoadFinalizeResult {
  load: typeof factoryV3Loads.$inferSelect;
  invoice: { orderId: number; invoiceNumber: string | null; grandTotal: string } | null;
  /** True when the load was already finalized (nothing new was written). */
  alreadyFinalized: boolean;
}

type LoadBaleRow = {
  bale_id: number;
  bale_reference: string;
  status: string | null;
  deleted_at: string | null;
  erp_location_id: number | null;
  weight_kg: string | null;
  article_code: string | null;
  product_name: string | null;
};

async function invoiceSummaryTx(tx: DbTransaction, companyId: number, orderId: number) {
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

async function nextInvoiceNumberTx(tx: DbTransaction, companyId: number): Promise<string> {
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

/** Finalizes and invoices a V3 load (see the module comment). */
export async function finalizeV3LoadTx(
  tx: DbTransaction,
  params: {
    companyId: number;
    loadId: number;
    user: { id: string | null; name: string | null };
    /** The statement date of the customer's SALE row (the client's date). */
    statementDate: string;
  }
): Promise<V3LoadFinalizeResult> {
  const { companyId, loadId } = params;
  const [load] = await tx
    .select()
    .from(factoryV3Loads)
    .where(and(eq(factoryV3Loads.id, loadId), eq(factoryV3Loads.companyId, companyId)))
    .for("update");
  if (!load) throw new V3LoadFinalizeRefusalError(404, "Load not found", "V3_LOAD_NOT_FOUND");
  if (load.status === "finalized") {
    if (load.customerOrderId) await syncFactoryInvoiceTx(tx, companyId, load.customerOrderId);
    const invoice = load.customerOrderId ? await invoiceSummaryTx(tx, companyId, load.customerOrderId) : null;
    return { load, invoice, alreadyFinalized: true };
  }
  if (load.status !== "loading") {
    throw new V3LoadFinalizeRefusalError(400, V3_LOAD_NOT_LOADING_MESSAGE, "V3_LOAD_NOT_LOADING");
  }

  await acquireProformaCapacityTransactionLock(tx, { companyId, proformaId: load.proformaId });
  const proformaRows = resultRows<{ id: number; customer_id: number }>(
    await tx.execute(sql`
      SELECT p.id, p.customer_id FROM customer_proformas p
        JOIN customers c ON c.id = p.customer_id AND c.company_id = ${companyId}
       WHERE p.id = ${load.proformaId} AND p.company_id = ${companyId} AND p.deleted_at IS NULL
    `)
  );
  const proforma = proformaRows[0];
  if (!proforma)
    throw new V3LoadFinalizeRefusalError(409, V3_LOAD_PROFORMA_MISSING_MESSAGE, "V3_LOAD_PROFORMA_MISSING");
  const pricing = new Map<string, { pricingMode: string; pricePerBale: string; pricePerKg: string | null }>();
  for (const line of resultRows<{
    article_code: string;
    pricing_mode: string | null;
    price_per_bale: string;
    price_per_kg: string | null;
  }>(
    await tx.execute(sql`
      SELECT article_code, pricing_mode, price_per_bale::text AS price_per_bale, price_per_kg::text AS price_per_kg
        FROM customer_proforma_lines WHERE proforma_id = ${proforma.id} ORDER BY id
    `)
  )) {
    const key = line.article_code.toLowerCase();
    if (!pricing.has(key)) {
      pricing.set(key, {
        pricingMode: line.pricing_mode ?? "per_bale",
        pricePerBale: line.price_per_bale,
        pricePerKg: line.price_per_kg,
      });
    }
  }

  const bales = resultRows<LoadBaleRow>(
    await tx.execute(sql`
      SELECT lb.bale_id, lb.bale_reference, b.status, b.deleted_at::text AS deleted_at, b.erp_location_id,
             COALESCE(b.weight_kg, lb.weight_kg)::text AS weight_kg,
             COALESCE(b.article_code, lb.article_code) AS article_code,
             COALESCE(b.product_name, lb.product_name) AS product_name
        FROM factory_v3_load_bales lb
        LEFT JOIN factory_bales b ON b.id = lb.bale_id AND b.company_id = ${companyId}
       WHERE lb.load_id = ${loadId} AND lb.removed_at IS NULL
       ORDER BY lb.id
       FOR UPDATE OF lb
    `)
  );
  if (bales.length === 0) throw new V3LoadFinalizeRefusalError(400, V3_LOAD_EMPTY_MESSAGE, "V3_LOAD_EMPTY");
  const unavailable = bales.filter((bale) => bale.deleted_at !== null || !STOCK_STATUSES.has(String(bale.status)));
  if (unavailable.length > 0) {
    throw new V3LoadFinalizeRefusalError(
      409,
      V3_LOAD_BALES_UNAVAILABLE_MESSAGE,
      "V3_LOAD_BALES_UNAVAILABLE",
      unavailable.map((bale) => bale.bale_reference)
    );
  }
  const withoutLocation = bales.filter((bale) => !bale.erp_location_id);
  if (withoutLocation.length > 0) {
    throw new V3LoadFinalizeRefusalError(
      409,
      V3_LOAD_BALES_WITHOUT_LOCATION_MESSAGE,
      "V3_LOAD_BALES_WITHOUT_LOCATION",
      withoutLocation.map((bale) => bale.bale_reference)
    );
  }
  const unpriced = bales.filter((bale) => !pricing.has(String(bale.article_code ?? "").toLowerCase()));
  if (unpriced.length > 0) {
    throw new V3LoadFinalizeRefusalError(
      409,
      V3_LOAD_BALES_NOT_ON_PROFORMA_MESSAGE,
      "V3_LOAD_BALES_NOT_ON_PROFORMA",
      unpriced.map((bale) => bale.bale_reference)
    );
  }

  const invoiceNumber = await nextInvoiceNumberTx(tx, companyId);
  const finalizedAt = new Date();
  const orderDate = String(load.expectedLoadDate);
  const [order] = await tx
    .insert(customerOrders)
    .values({
      companyId,
      customerId: proforma.customer_id,
      invoiceNumber,
      orderDate,
      proformaIdUsed: proforma.id,
      status: "FINALIZED",
      previousStatus: "LOADING",
      loadingFinalizedAt: finalizedAt,
      finalizedAt,
      containerNotes: `V3 load ${load.loadName} (#${load.id})`,
    })
    .returning();

  await tx.insert(customerOrderBales).values(
    bales.map((bale) => {
      const line = pricing.get(String(bale.article_code ?? "").toLowerCase())!;
      const weight = toMoney(bale.weight_kg ?? 0);
      const perKg = toMoney(line.pricePerKg ?? 0);
      const price =
        line.pricingMode === "per_kg" && perKg.gt(0) && weight.gt(0) ? weight.times(perKg) : toMoney(line.pricePerBale);
      return {
        orderId: order.id,
        baleId: bale.bale_id,
        baleReference: bale.bale_reference,
        locationId: bale.erp_location_id!,
        weight: weight.toFixed(3),
        articleCode: bale.article_code,
        baleName: bale.product_name,
        priceUsed: price.toFixed(2),
        scannedBy: params.user.name,
      };
    })
  );
  await recalculateOrderTotals(tx, order.id);

  const baleIds = bales.map((bale) => Number(bale.bale_id));
  await tx.execute(sql`
    UPDATE factory_bales SET status = 'SOLD', updated_at = now()
     WHERE company_id = ${companyId} AND id = ANY(${`{${baleIds.join(",")}}`}::int[])
  `);

  const [totals] = await tx
    .select({ grandTotal: customerOrders.grandTotal })
    .from(customerOrders)
    .where(eq(customerOrders.id, order.id));
  const grandTotal = toMoney(totals?.grandTotal ?? 0).toFixed(2);
  await tx.insert(customerBalances).values({
    companyId,
    customerId: proforma.customer_id,
    transactionDate: params.statementDate,
    transactionType: "SALE",
    debitAmount: grandTotal,
    creditAmount: "0",
    balance: grandTotal,
    referenceType: "INVOICE",
    referenceId: order.id,
    description: `Invoice ${invoiceNumber}`,
    currency: "USD",
  });

  const journalId = await syncFactoryInvoiceTx(tx, companyId, order.id);

  const [updated] = await tx
    .update(factoryV3Loads)
    .set({
      status: "finalized",
      finalizedAt,
      finalizedBy: params.user.id,
      finalizedByName: params.user.name,
      customerOrderId: order.id,
    })
    .where(and(eq(factoryV3Loads.id, loadId), eq(factoryV3Loads.companyId, companyId)))
    .returning();

  await writeAuditEvent(
    {
      action: "update",
      tableName: "factory_v3_loads",
      recordId: loadId,
      recordIdentifier: `v3-load-finalize:${loadId}`,
      companyId,
      userId: params.user.id ?? "system",
      username: params.user.name ?? "system",
      changes: {
        status: { old: load.status, new: "finalized" },
        customerOrderId: { old: null, new: order.id },
        invoice: {
          old: null,
          new: { invoiceNumber, grandTotal, bales: baleIds.length, journalId, customerId: proforma.customer_id },
        },
      },
    },
    tx
  );

  return {
    load: updated,
    invoice: { orderId: order.id, invoiceNumber, grandTotal },
    alreadyFinalized: false,
  };
}
