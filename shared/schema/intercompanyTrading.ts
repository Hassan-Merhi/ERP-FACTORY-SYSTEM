/**
 * Phase 1: inert intercompany-trading foundation.
 *
 * These declarations add no routes, posting hooks, background jobs or UI.
 * Every live workflow remains behind an explicit, initially disabled policy.
 * A physical container is stored only once; linked companies see it via trades.
 */
import { sql } from "drizzle-orm";
import {
  pgTable,
  bigserial,
  bigint,
  integer,
  varchar,
  text,
  timestamp,
  date,
  decimal,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { ledgerAccounts } from "./accounting";
import { companies, locations } from "./common";
import { stockItems } from "./inventory";
import { purchaseOrders, containerCharges } from "./containers";
import { users } from "./users";
import { companyScopedSuppliers } from "./supplierCompanyScope";
import { vouchers } from "./erp/vouchers";
import {
  intercompanyImportBatches,
  intercompanyPermissionGrants,
  intercompanyReconciliationFindings,
  intercompanyRelationshipPolicies,
  intercompanyRepairRequests,
  intercompanyTradeLineLinks,
  intercompanyTradeRevisions,
  intercompanyTrades,
} from "./intercompanyRelationshipPolicies";
export {
  intercompanyAuditEvents,
  intercompanyImportBatchContainers,
  intercompanyImportBatches,
  intercompanyPermissionGrants,
  intercompanyReconciliationFindings,
  intercompanyReconciliationRuns,
  intercompanyRelationshipPolicies,
  intercompanyRepairRequests,
  intercompanyTradeLineLinks,
  intercompanyTradeRevisions,
  intercompanyTrades,
} from "./intercompanyRelationshipPolicies";

/** Each original supplier PO is retained even when an Excel container has several PO numbers. */
export const intercompanyTradeSourcePos = pgTable(
  "intercompany_trade_source_pos",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    tradeId: integer("trade_id")
      .notNull()
      .references(() => intercompanyTrades.id, { onDelete: "restrict" }),
    sourcePoId: integer("source_po_id")
      .notNull()
      .unique()
      .references(() => purchaseOrders.id, { onDelete: "restrict" }),
    originalPoNumber: text("original_po_number").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tradeIdx: index("intercompany_trade_source_pos_trade_idx").on(t.tradeId),
  })
);

export const intercompanySharedChargeInvoices = pgTable(
  "intercompany_shared_charge_invoices",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    sourceCompanyId: integer("source_company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    externalInvoiceKey: varchar("external_invoice_key", { length: 120 }).notNull(),
    chargeType: varchar("charge_type", { length: 32 }).notNull(),
    faceAmount: decimal("face_amount", { precision: 20, scale: 2 }).notNull(),
    currency: varchar("currency", { length: 3 }).notNull().default("USD"),
    evidenceReference: text("evidence_reference").notNull(),
    state: varchar("state", { length: 16 }).notNull().default("draft"),
    version: integer("version").notNull().default(1),
    createdBy: varchar("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  },
  (t) => ({
    sourceIdx: index("ic_shared_invoice_source_idx").on(t.sourceCompanyId, t.createdAt),
    uniqueKey: uniqueIndex("ic_invoice_unique_source_key").on(t.sourceCompanyId, t.externalInvoiceKey),
  })
);

export const intercompanySharedChargeAllocations = pgTable(
  "intercompany_shared_charge_allocations",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    invoiceId: bigint("invoice_id", { mode: "number" })
      .notNull()
      .references(() => intercompanySharedChargeInvoices.id, { onDelete: "restrict" }),
    tradeId: integer("trade_id")
      .notNull()
      .references(() => intercompanyTrades.id, { onDelete: "restrict" }),
    amount: decimal("amount", { precision: 20, scale: 2 }).notNull(),
    containerChargeId: integer("container_charge_id")
      .unique()
      .references(() => containerCharges.id, { onDelete: "restrict" }),
  },
  (t) => ({
    tradeIdx: index("ic_shared_charge_trade_idx").on(t.tradeId),
    uniqueTrade: uniqueIndex("ic_charge_trade_unique").on(t.invoiceId, t.tradeId),
  })
);

export const intercompanySharedChargePoAllocations = pgTable(
  "intercompany_shared_charge_po_allocations",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    invoiceId: bigint("invoice_id", { mode: "number" })
      .notNull()
      .references(() => intercompanySharedChargeInvoices.id, { onDelete: "restrict" }),
    tradeId: integer("trade_id")
      .notNull()
      .references(() => intercompanyTrades.id, { onDelete: "restrict" }),
    sourcePoId: integer("source_po_id")
      .notNull()
      .references(() => purchaseOrders.id, { onDelete: "restrict" }),
    amount: decimal("amount", { precision: 20, scale: 2 }).notNull(),
  },
  (t) => ({
    tradeIdx: index("ic_shared_charge_po_trade_idx").on(t.tradeId),
    uniqueSourcePo: uniqueIndex("ic_charge_po_unique").on(t.invoiceId, t.sourcePoId),
  })
);

/** Real, confirmed, balanced cash/bank transfer with immutable historic FX evidence. */
export const intercompanyContainerPayments = pgTable(
  "intercompany_container_payments",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    relationshipId: integer("relationship_id")
      .notNull()
      .references(() => intercompanyRelationshipPolicies.id, { onDelete: "restrict" }),
    sourceCompanyId: integer("source_company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    destinationCompanyId: integer("destination_company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    requestKey: varchar("request_key", { length: 160 }).notNull().unique(),
    requestFingerprint: varchar("request_fingerprint", { length: 64 }).notNull(),
    transferReference: varchar("transfer_reference", { length: 180 }).notNull(),
    confirmationEvidence: text("confirmation_evidence").notNull(),
    paymentDate: date("payment_date").notNull(),
    transactionCurrency: varchar("transaction_currency", { length: 3 }).notNull().default("USD"),
    transactionAmount: decimal("transaction_amount", { precision: 20, scale: 6 }).notNull(),
    historicalRate: decimal("historical_rate", { precision: 20, scale: 10 }).notNull().default("1"),
    baseAmount: decimal("base_amount", { precision: 20, scale: 2 }).notNull(),
    sourceCashType: varchar("source_cash_type", { length: 8 }).notNull(),
    sourceCashId: integer("source_cash_id").notNull(),
    destinationCashType: varchar("destination_cash_type", { length: 8 }).notNull(),
    destinationCashId: integer("destination_cash_id").notNull(),
    sourceReceivableAccountId: integer("source_receivable_account_id")
      .notNull()
      .references(() => ledgerAccounts.id, { onDelete: "restrict" }),
    destinationSupplierId: integer("destination_supplier_id")
      .notNull()
      .references(() => companyScopedSuppliers.id, { onDelete: "restrict" }),
    sourceReceiptVoucherId: integer("source_receipt_voucher_id")
      .notNull()
      .unique("ic_payment_source_receipt_uq")
      .references(() => vouchers.id, { onDelete: "restrict" }),
    destinationPaymentVoucherId: integer("destination_payment_voucher_id")
      .notNull()
      .unique("ic_payment_destination_pay_uq")
      .references(() => vouchers.id, { onDelete: "restrict" }),
    status: varchar("status", { length: 12 }).notNull().default("confirmed"),
    createdBy: varchar("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    reversedBy: varchar("reversed_by").references(() => users.id, { onDelete: "restrict" }),
    reversedAt: timestamp("reversed_at", { withTimezone: true }),
    reversalDate: date("reversal_date"),
    reversalReason: text("reversal_reason"),
    reversalKey: varchar("reversal_key", { length: 160 }).unique(),
    reversalFingerprint: varchar("reversal_fingerprint", { length: 64 }),
    sourceReversalVoucherId: integer("source_reversal_voucher_id")
      .unique("ic_payment_source_reverse_uq")
      .references(() => vouchers.id, { onDelete: "restrict" }),
    destinationReversalVoucherId: integer("destination_reversal_voucher_id")
      .unique("ic_payment_dest_reverse_uq")
      .references(() => vouchers.id, { onDelete: "restrict" }),
  },
  (t) => ({
    relationshipDateIdx: index("ic_payments_pair_date_idx").on(t.relationshipId, t.paymentDate, t.id),
    uniqueTransferRef: uniqueIndex("ic_payments_pair_transfer_ref").on(
      t.relationshipId,
      sql`upper(btrim(${t.transferReference}))`
    ),
  })
);

export const intercompanyPaymentAllocations = pgTable(
  "intercompany_payment_allocations",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    paymentId: bigint("payment_id", { mode: "number" })
      .notNull()
      .references(() => intercompanyContainerPayments.id, { onDelete: "restrict" }),
    tradeId: integer("trade_id")
      .notNull()
      .references(() => intercompanyTrades.id, { onDelete: "restrict" }),
    amount: decimal("amount", { precision: 20, scale: 2 }).notNull(),
    allocationKind: varchar("allocation_kind", { length: 32 }).notNull(),
    requestKey: varchar("request_key", { length: 180 }).notNull().unique(),
    createdBy: varchar("created_by").references(() => users.id, { onDelete: "restrict" }),
    reason: text("reason").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    paymentIdx: index("ic_payment_allocation_payment_idx").on(t.paymentId, t.id),
    tradeIdx: index("ic_payment_allocation_trade_idx").on(t.tradeId, t.id),
  })
);

/** Phase 5 single, append-only destination receipt without a duplicate container. */
export const intercompanyDestinationReceipts = pgTable(
  "intercompany_destination_receipts",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    tradeId: integer("trade_id")
      .notNull()
      .unique()
      .references(() => intercompanyTrades.id, { onDelete: "restrict" }),
    relationshipId: integer("relationship_id")
      .notNull()
      .references(() => intercompanyRelationshipPolicies.id, { onDelete: "restrict" }),
    destinationCompanyId: integer("destination_company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    locationId: integer("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "restrict" }),
    inventoryAccountId: integer("inventory_account_id")
      .notNull()
      .references(() => ledgerAccounts.id, { onDelete: "restrict" }),
    gitAccountId: integer("git_account_id")
      .notNull()
      .references(() => ledgerAccounts.id, { onDelete: "restrict" }),
    receiptVoucherId: integer("receipt_voucher_id")
      .notNull()
      .unique("ic_receipt_posting_voucher_uq")
      .references(() => vouchers.id, { onDelete: "restrict" }),
    requestKey: varchar("request_key", { length: 128 }).notNull().unique(),
    requestFingerprint: varchar("request_fingerprint", { length: 64 }).notNull(),
    postingDate: date("posting_date").notNull(),
    landedCost: decimal("landed_cost", { precision: 20, scale: 2 }).notNull(),
    arrivalEvidence: text("arrival_evidence").notNull(),
    reason: text("reason").notNull(),
    actorUserId: varchar("actor_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index("ic_destination_receipts_company_idx").on(t.destinationCompanyId, t.postingDate),
  })
);

export const intercompanyDestinationReceiptItems = pgTable(
  "intercompany_destination_receipt_items",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    receiptId: bigint("receipt_id", { mode: "number" })
      .notNull()
      .references(() => intercompanyDestinationReceipts.id, { onDelete: "restrict" }),
    stockItemId: integer("stock_item_id")
      .notNull()
      .references(() => stockItems.id, { onDelete: "restrict" }),
    quantity: decimal("quantity", { precision: 18, scale: 3 }).notNull(),
    landedValue: decimal("landed_value", { precision: 20, scale: 2 }).notNull(),
    valueMoved: decimal("value_moved", { precision: 20, scale: 2 }).notNull(),
    canonicalMovementId: bigint("canonical_movement_id", { mode: "number" }).notNull().unique(),
  },
  (t) => ({
    uniqueReceiptItem: uniqueIndex("ic_receipt_one_item").on(t.receiptId, t.stockItemId),
  })
);

export const intercompanyTradeCancellations = pgTable("intercompany_trade_cancellations", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  tradeId: integer("trade_id")
    .notNull()
    .unique()
    .references(() => intercompanyTrades.id, { onDelete: "restrict" }),
  relationshipId: integer("relationship_id")
    .notNull()
    .references(() => intercompanyRelationshipPolicies.id, { onDelete: "restrict" }),
  sourceCompanyId: integer("source_company_id")
    .notNull()
    .references(() => companies.id, { onDelete: "restrict" }),
  destinationCompanyId: integer("destination_company_id")
    .notNull()
    .references(() => companies.id, { onDelete: "restrict" }),
  requestKey: varchar("request_key", { length: 128 }).notNull().unique(),
  requestFingerprint: varchar("request_fingerprint", { length: 64 }).notNull(),
  expectedVersion: integer("expected_version").notNull(),
  postingDate: date("posting_date").notNull(),
  landedCost: decimal("landed_cost", { precision: 20, scale: 2 }).notNull(),
  sourceSaleReversalVoucherId: integer("source_sale_reversal_voucher_id")
    .notNull()
    .unique("ic_cancel_src_sale_voucher_uq")
    .references(() => vouchers.id, { onDelete: "restrict" }),
  sourceCostReversalVoucherId: integer("source_cost_reversal_voucher_id")
    .notNull()
    .unique("ic_cancel_src_cost_voucher_uq")
    .references(() => vouchers.id, { onDelete: "restrict" }),
  destinationGitReversalVoucherId: integer("destination_git_reversal_voucher_id")
    .notNull()
    .unique("ic_cancel_dst_git_voucher_uq")
    .references(() => vouchers.id, { onDelete: "restrict" }),
  reason: text("reason").notNull(),
  cancellationEvidence: text("cancellation_evidence").notNull(),
  releasedCredit: decimal("released_credit", { precision: 20, scale: 2 }).notNull().default("0"),
  actorUserId: varchar("actor_user_id")
    .notNull()
    .references(() => users.id, { onDelete: "restrict" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type IntercompanyRelationshipPolicy = typeof intercompanyRelationshipPolicies.$inferSelect;
export type IntercompanyTrade = typeof intercompanyTrades.$inferSelect;
export type IntercompanyTradeSourcePo = typeof intercompanyTradeSourcePos.$inferSelect;
export type IntercompanyImportBatch = typeof intercompanyImportBatches.$inferSelect;
export type IntercompanyPermissionGrant = typeof intercompanyPermissionGrants.$inferSelect;
export type IntercompanyReconciliationFinding = typeof intercompanyReconciliationFindings.$inferSelect;
export type IntercompanyRepairRequest = typeof intercompanyRepairRequests.$inferSelect;

export type IntercompanyTradeLineLink = typeof intercompanyTradeLineLinks.$inferSelect;
export type IntercompanyTradeRevision = typeof intercompanyTradeRevisions.$inferSelect;
export type IntercompanySharedChargeInvoice = typeof intercompanySharedChargeInvoices.$inferSelect;

export type IntercompanyContainerPayment = typeof intercompanyContainerPayments.$inferSelect;
export type IntercompanyPaymentAllocation = typeof intercompanyPaymentAllocations.$inferSelect;

export type IntercompanyDestinationReceipt = typeof intercompanyDestinationReceipts.$inferSelect;
export type IntercompanyDestinationReceiptItem = typeof intercompanyDestinationReceiptItems.$inferSelect;
export type IntercompanyTradeCancellation = typeof intercompanyTradeCancellations.$inferSelect;
