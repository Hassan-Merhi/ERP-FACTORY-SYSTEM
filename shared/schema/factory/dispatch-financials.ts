/**
 * Phase 2: typed persistence for Factory truck-trip accounting.
 *
 * Manual SQL installation is deliberately separate. These declarations do not
 * create tables at boot and none of the Phase 2 paths post vouchers.
 *
 * The physical factory_loading_dispatch_* tables are runtime-managed and are
 * intentionally NOT redeclared here. Composite company/order/trip and signed
 * closure foreign keys are installed by the accompanying manual SQL file.
 */
import { sql } from "drizzle-orm";
import {
  bigint, bigserial, check, date, decimal, index, integer, jsonb,
  pgTable, text, timestamp, uniqueIndex, varchar,
} from "drizzle-orm/pg-core";

const id = (name: string) => bigint(name, { mode: "number" });
const money = (name: string) => decimal(name, { precision: 20, scale: 2 });
const utcTime = (name: string) => timestamp(name, { withTimezone: true });

/** Exactly one financial control row per physical dispatch. */
export const factoryDispatchTripFinancials = pgTable("factory_dispatch_trip_financials", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  companyId: integer("company_id").notNull(),
  orderId: integer("order_id").notNull(),
  dispatchId: id("dispatch_id").notNull(),
  closureHistoryId: id("closure_history_id"),
  status: varchar("status", { length: 16 }).notNull().default("DRAFT"),
  snapshotRevision: integer("snapshot_revision").notNull().default(0),
  postingRevision: integer("posting_revision").notNull().default(0),
  currency: varchar("currency", { length: 3 }).notNull().default("USD"),
  fxRate: decimal("fx_rate", { precision: 20, scale: 8 }),
  valuationDate: date("valuation_date"),
  manifestFingerprint: varchar("manifest_fingerprint", { length: 64 }),
  sourceFingerprint: varchar("source_fingerprint", { length: 64 }),
  goodsSubtotal: money("goods_subtotal").notNull().default("0"),
  billableChargesTotal: money("billable_charges_total").notNull().default("0"),
  discountTotal: money("discount_total").notNull().default("0"),
  customerTotal: money("customer_total").notNull().default("0"),
  postedAt: utcTime("posted_at"),
  postedByUserId: text("posted_by_user_id"),
  createdAt: utcTime("created_at").notNull().defaultNow(),
  updatedAt: utcTime("updated_at").notNull().defaultNow(),
}, (t) => ({
  tripUnique: uniqueIndex("factory_dispatch_trip_financials_trip_uq").on(t.companyId, t.orderId, t.dispatchId),
  scopeUnique: uniqueIndex("factory_dispatch_trip_financials_scope_uq").on(t.id, t.companyId, t.orderId, t.dispatchId),
  orderIdx: index("factory_dispatch_trip_financials_order_idx").on(t.companyId, t.orderId, t.status),
  statusValid: check("factory_dispatch_trip_financials_status_ck", sql`${t.status} IN ('DRAFT', 'POSTED', 'REVERSED', 'CONSOLIDATED')`),
  revisionValid: check("factory_dispatch_trip_financials_revision_ck", sql`${t.snapshotRevision} >= 0 AND ${t.postingRevision} >= 0`),
  totalsValid: check("factory_dispatch_trip_financials_totals_ck", sql`
    ${t.goodsSubtotal} >= 0 AND ${t.billableChargesTotal} >= 0 AND
    ${t.discountTotal} >= 0 AND ${t.customerTotal} >= 0`),
}));

/** Append-only price and barcode snapshot per financial revision. */
export const factoryDispatchTripFinancialBales = pgTable("factory_dispatch_trip_financial_bales", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  financialId: id("financial_id").notNull(),
  companyId: integer("company_id").notNull(),
  orderId: integer("order_id").notNull(),
  dispatchId: id("dispatch_id").notNull(),
  closureHistoryId: id("closure_history_id").notNull(),
  snapshotRevision: integer("snapshot_revision").notNull(),
  sourceScanId: id("source_scan_id").notNull(),
  baleId: integer("bale_id").notNull(),
  baleReference: text("bale_reference").notNull(),
  articleCode: varchar("article_code", { length: 50 }).notNull(),
  productName: text("product_name").notNull(),
  weightKg: decimal("weight_kg", { precision: 18, scale: 3 }).notNull(),
  priceSource: varchar("price_source", { length: 40 }).notNull(),
  pricingMode: varchar("pricing_mode", { length: 20 }).notNull().default("per_bale"),
  unitPrice: decimal("unit_price", { precision: 20, scale: 6 }).notNull(),
  lineTotal: money("line_total").notNull(),
  createdAt: utcTime("created_at").notNull().defaultNow(),
}, (t) => ({
  sourceBaleUnique: uniqueIndex("factory_dispatch_trip_financial_bales_bale_uq").on(t.financialId, t.snapshotRevision, t.baleId),
  sourceScanUnique: uniqueIndex("factory_dispatch_trip_financial_bales_scan_uq").on(t.financialId, t.snapshotRevision, t.sourceScanId),
  tripIdx: index("factory_dispatch_trip_financial_bales_order_idx").on(t.companyId, t.orderId, t.dispatchId),
  revisionValid: check("factory_dispatch_trip_financial_bales_revision_ck", sql`${t.snapshotRevision} > 0`),
  amountsValid: check("factory_dispatch_trip_financial_bales_amounts_ck", sql`${t.weightKg} >= 0 AND ${t.unitPrice} >= 0 AND ${t.lineTotal} >= 0`),
}));

/** Trip-specific charges: no parallel customer-balance table. */
export const factoryDispatchTripCharges = pgTable("factory_dispatch_trip_charges", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  financialId: id("financial_id").notNull(),
  companyId: integer("company_id").notNull(),
  orderId: integer("order_id").notNull(),
  dispatchId: id("dispatch_id").notNull(),
  revision: integer("revision").notNull().default(1),
  name: text("name").notNull(),
  kind: varchar("kind", { length: 16 }).notNull(),
  amount: money("amount").notNull(),
  currency: varchar("currency", { length: 3 }).notNull().default("USD"),
  ledgerAccountId: integer("ledger_account_id").notNull(),
  offsetLedgerAccountId: integer("offset_ledger_account_id"),
  erpChargeType: varchar("erp_charge_type", { length: 32 }),
  notes: text("notes"),
  postedVoucherId: integer("posted_voucher_id"),
  lockedAt: utcTime("locked_at"),
  createdAt: utcTime("created_at").notNull().defaultNow(),
  updatedAt: utcTime("updated_at").notNull().defaultNow(),
}, (t) => ({
  tripIdx: index("factory_dispatch_trip_charges_trip_idx").on(t.companyId, t.orderId, t.dispatchId),
  chargeKind: check("factory_dispatch_trip_charges_kind_ck", sql`${t.kind} IN ('BILLABLE', 'INTERNAL', 'DISCOUNT')`),
  revisionValid: check("factory_dispatch_trip_charges_revision_ck", sql`${t.revision} > 0`),
  amountValid: check("factory_dispatch_trip_charges_amount_ck", sql`${t.amount} >= 0`),
}));

/** Idempotent, auditable accounting posting/reversal references. */
export const factoryDispatchTripPostings = pgTable("factory_dispatch_trip_postings", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  financialId: id("financial_id").notNull(),
  companyId: integer("company_id").notNull(),
  orderId: integer("order_id").notNull(),
  dispatchId: id("dispatch_id").notNull(),
  postingRevision: integer("posting_revision").notNull(),
  kind: varchar("kind", { length: 16 }).notNull(),
  idempotencyKey: varchar("idempotency_key", { length: 128 }).notNull(),
  sourceFingerprint: varchar("source_fingerprint", { length: 64 }).notNull(),
  amount: money("amount").notNull(),
  voucherIds: jsonb("voucher_ids").notNull().default(sql`'[]'::jsonb`),
  reversesPostingId: id("reverses_posting_id"),
  reason: text("reason"),
  postedAt: utcTime("posted_at").notNull().defaultNow(),
  postedByUserId: text("posted_by_user_id").notNull(),
}, (t) => ({
  postingUnique: uniqueIndex("factory_dispatch_trip_postings_revision_uq").on(t.financialId, t.postingRevision, t.kind),
  idempotencyUnique: uniqueIndex("factory_dispatch_trip_postings_idempotency_uq").on(t.companyId, t.idempotencyKey),
  tripIdx: index("factory_dispatch_trip_postings_trip_idx").on(t.companyId, t.orderId, t.dispatchId),
  kindValid: check("factory_dispatch_trip_postings_kind_ck", sql`${t.kind} IN ('POST', 'REVERSAL', 'ADJUSTMENT')`),
  amountValid: check("factory_dispatch_trip_postings_amount_ck", sql`${t.amount} >= 0 AND ${t.postingRevision} > 0`),
  voucherIdsValid: check("factory_dispatch_trip_postings_vouchers_ck", sql`jsonb_typeof(${t.voucherIds}) = 'array'`),
}));

/** Download evidence only, never a claim that ERP received or imported the file. */
export const factoryDispatchTripExports = pgTable("factory_dispatch_trip_exports", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  financialId: id("financial_id").notNull(),
  companyId: integer("company_id").notNull(),
  orderId: integer("order_id").notNull(),
  dispatchId: id("dispatch_id").notNull(),
  snapshotRevision: integer("snapshot_revision").notNull(),
  sourceFingerprint: varchar("source_fingerprint", { length: 64 }).notNull(),
  exportFingerprint: varchar("export_fingerprint", { length: 64 }).notNull(),
  targetErpCompanyId: integer("target_erp_company_id"),
  supplierCode: varchar("supplier_code", { length: 100 }).notNull(),
  poNumber: varchar("po_number", { length: 100 }).notNull(),
  erpContainerNumber: varchar("erp_container_number", { length: 100 }).notNull(),
  preview: jsonb("preview").notNull().default(sql`'{}'::jsonb`),
  exportedByUserId: text("exported_by_user_id").notNull(),
  exportedAt: utcTime("exported_at").notNull().defaultNow(),
}, (t) => ({
  exportUnique: uniqueIndex("factory_dispatch_trip_exports_content_uq").on(t.financialId, t.exportFingerprint),
  containerUnique: uniqueIndex("factory_dispatch_trip_exports_container_uq").on(t.companyId, t.erpContainerNumber),
  orderIdx: index("factory_dispatch_trip_exports_order_idx").on(t.companyId, t.orderId),
  revisionValid: check("factory_dispatch_trip_exports_revision_ck", sql`${t.snapshotRevision} > 0`),
}));

/** One parent-order invoice; trip accounting is consolidated, not charged again. */
export const factoryDispatchOrderConsolidations = pgTable("factory_dispatch_order_consolidations", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  companyId: integer("company_id").notNull(),
  orderId: integer("order_id").notNull(),
  status: varchar("status", { length: 16 }).notNull().default("DRAFT"),
  reconciliationFingerprint: varchar("reconciliation_fingerprint", { length: 64 }),
  invoiceNumber: varchar("invoice_number", { length: 50 }),
  includedPostingIds: jsonb("included_posting_ids").notNull().default(sql`'[]'::jsonb`),
  goodsSubtotal: money("goods_subtotal").notNull().default("0"),
  billableChargesTotal: money("billable_charges_total").notNull().default("0"),
  discountTotal: money("discount_total").notNull().default("0"),
  customerTotal: money("customer_total").notNull().default("0"),
  finalizedAt: utcTime("finalized_at"),
  finalizedByUserId: text("finalized_by_user_id"),
  createdAt: utcTime("created_at").notNull().defaultNow(),
  updatedAt: utcTime("updated_at").notNull().defaultNow(),
}, (t) => ({
  orderUnique: uniqueIndex("factory_dispatch_order_consolidations_order_uq").on(t.companyId, t.orderId),
  statusValid: check("factory_dispatch_order_consolidations_status_ck", sql`${t.status} IN ('DRAFT', 'FINALIZED', 'REVERSED')`),
  totalsValid: check("factory_dispatch_order_consolidations_totals_ck", sql`${t.goodsSubtotal} >= 0 AND ${t.billableChargesTotal} >= 0 AND ${t.discountTotal} >= 0 AND ${t.customerTotal} >= 0`),
  postingListValid: check("factory_dispatch_order_consolidations_postings_ck", sql`jsonb_typeof(${t.includedPostingIds}) = 'array'`),
}));

/** Append-only trip/order financial history, distinct from physical dispatch events. */
export const factoryDispatchFinancialEvents = pgTable("factory_dispatch_financial_events", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  companyId: integer("company_id").notNull(),
  orderId: integer("order_id").notNull(),
  dispatchId: id("dispatch_id"),
  financialId: id("financial_id"),
  eventType: varchar("event_type", { length: 64 }).notNull(),
  details: jsonb("details").notNull().default(sql`'{}'::jsonb`),
  reason: text("reason"),
  actorUserId: text("actor_user_id").notNull(),
  actorUsername: text("actor_username").notNull(),
  createdAt: utcTime("created_at").notNull().defaultNow(),
}, (t) => ({
  orderIdx: index("factory_dispatch_financial_events_order_idx").on(t.companyId, t.orderId, t.id),
  tripIdx: index("factory_dispatch_financial_events_trip_idx").on(t.companyId, t.dispatchId, t.id),
}));

export type FactoryDispatchTripFinancial = typeof factoryDispatchTripFinancials.$inferSelect;
export type FactoryDispatchTripFinancialBale = typeof factoryDispatchTripFinancialBales.$inferSelect;
export type FactoryDispatchTripCharge = typeof factoryDispatchTripCharges.$inferSelect;
export type FactoryDispatchTripPosting = typeof factoryDispatchTripPostings.$inferSelect;
export type FactoryDispatchTripExport = typeof factoryDispatchTripExports.$inferSelect;
export type FactoryDispatchOrderConsolidation = typeof factoryDispatchOrderConsolidations.$inferSelect;
export type FactoryDispatchFinancialEvent = typeof factoryDispatchFinancialEvents.$inferSelect;
