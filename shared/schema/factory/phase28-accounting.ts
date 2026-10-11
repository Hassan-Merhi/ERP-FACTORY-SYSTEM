/**
 * Accounting audit phases 28 and 29 (factory accounting complete, perpetual
 * inventory go-live). Also created at boot by the DDL in
 * server/services/factory/phase28Schema.ts (appended to
 * ensureFactoryCostBasisSchema), with the same columns and index names,
 * because production skips schema pushes. No foreign keys: the tables must be
 * creatable on any schema and never block a fixture delete.
 */
import {
  pgTable,
  text,
  serial,
  integer,
  decimal,
  date,
  timestamp,
  index,
  uniqueIndex,
  jsonb,
  primaryKey,
} from "drizzle-orm/pg-core";

/**
 * F1: the factory receivable cut-over. Factory invoices dated on or after
 * `effective_from` post their receivable and revenue (INV-GL) whatever the
 * inventory switch; the receivables of earlier invoices are carried by the
 * opening receivable journal(s) the Owner applied.
 */
export const factoryArCutovers = pgTable("factory_ar_cutovers", {
  companyId: integer("company_id").primaryKey(),
  effectiveFrom: date("effective_from").notNull(),
  openingVoucherIds: jsonb("opening_voucher_ids").notNull(),
  planHash: text("plan_hash").notNull(),
  openingPlan: jsonb("opening_plan").notNull(),
  appliedBy: text("applied_by"),
  appliedAt: timestamp("applied_at").notNull().defaultNow(),
});

/**
 * F4/F6: the reviewed resolution of a bale with no costed mix (assign to a
 * costed mix, write off to waste, or accept its cost with a sign-off), one row
 * per bale and action, with the cost before and after.
 */
export const factoryBaleCostResolutions = pgTable(
  "factory_bale_cost_resolutions",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    baleId: integer("bale_id").notNull(),
    action: text("action").notNull(),
    mixBatchId: integer("mix_batch_id"),
    oldTotalCost: decimal("old_total_cost", { precision: 20, scale: 7 }).notNull(),
    newTotalCost: decimal("new_total_cost", { precision: 20, scale: 7 }).notNull(),
    reason: text("reason"),
    planHash: text("plan_hash").notNull(),
    appliedBy: text("applied_by"),
    appliedAt: timestamp("applied_at").notNull().defaultNow(),
  },
  (t) => ({
    companyBaleIdx: index("factory_bale_cost_resolutions_company_bale_idx").on(t.companyId, t.baleId),
  })
);

/**
 * F9: the dated factory valuation, one row per company and business day,
 * written by that day's GL-FACTORY-STOCK journal (or its catch-up run): what
 * the factory costing held at the journal, so a past date can be reconciled.
 */
export const factoryStockValuationSnapshots = pgTable(
  "factory_stock_valuation_snapshots",
  {
    companyId: integer("company_id").notNull(),
    valuationDate: date("valuation_date").notNull(),
    raw: decimal("raw", { precision: 20, scale: 2 }).notNull(),
    wip: decimal("wip", { precision: 20, scale: 2 }).notNull(),
    finished: decimal("finished", { precision: 20, scale: 2 }).notNull(),
    unvalued: integer("unvalued").notNull().default(0),
    voucherId: integer("voucher_id"),
    basis: text("basis").notNull(),
    recordedAt: timestamp("recorded_at").notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.companyId, t.valuationDate] }),
  })
);

/** I8: the ERP bale-mirror quantity a factory invoice took out, per bale (idempotent re-sync). */
export const factoryInvoiceMirrorReductions = pgTable(
  "factory_invoice_mirror_reductions",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    orderId: integer("order_id").notNull(),
    baleId: integer("bale_id").notNull(),
    stockItemId: integer("stock_item_id").notNull(),
    locationId: integer("location_id").notNull(),
    quantity: decimal("quantity", { precision: 18, scale: 3 }).notNull(),
    value: decimal("value", { precision: 20, scale: 2 }).notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    orderBaleUnique: uniqueIndex("factory_invoice_mirror_reductions_order_bale_unique").on(t.orderId, t.baleId),
  })
);

/** I6: a Retail supplier invoice that cleared received-not-invoiced stock. */
export const retailSupplierInvoices = pgTable(
  "retail_supplier_invoices",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    supplierId: integer("supplier_id").notNull(),
    invoiceNumber: text("invoice_number").notNull(),
    invoiceDate: date("invoice_date").notNull(),
    amount: decimal("amount", { precision: 20, scale: 2 }).notNull(),
    grniCleared: decimal("grni_cleared", { precision: 20, scale: 2 }).notNull(),
    variance: decimal("variance", { precision: 20, scale: 2 }).notNull(),
    voucherId: integer("voucher_id"),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    supplierNumberUnique: uniqueIndex("retail_supplier_invoices_company_supplier_number_unique").on(
      t.companyId,
      t.supplierId,
      t.invoiceNumber
    ),
  })
);

/** I6: the Retail receipt journals (RETAIL-GRNI credits) an invoice cleared; a receipt is cleared once. */
export const retailSupplierInvoiceReceipts = pgTable(
  "retail_supplier_invoice_receipts",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    invoiceId: integer("invoice_id").notNull(),
    receiptVoucherId: integer("receipt_voucher_id").notNull(),
    amount: decimal("amount", { precision: 20, scale: 2 }).notNull(),
  },
  (t) => ({
    receiptUnique: uniqueIndex("retail_supplier_invoice_receipts_receipt_unique").on(t.receiptVoucherId),
  })
);

export type FactoryArCutover = typeof factoryArCutovers.$inferSelect;
export type FactoryStockValuationSnapshot = typeof factoryStockValuationSnapshots.$inferSelect;
