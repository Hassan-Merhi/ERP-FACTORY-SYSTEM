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
  serial,
  bigserial,
  bigint,
  integer,
  varchar,
  text,
  boolean,
  timestamp,
  date,
  decimal,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { ledgerAccounts } from "./accounting";
import { companies } from "./common";
import { containers, purchaseOrders, poLineItems, containerCharges } from "./containers";
import { users } from "./users";
import { companyScopedSuppliers } from "./supplierCompanyScope";
import { vouchers } from "./erp/vouchers";

export const intercompanyRelationshipPolicies = pgTable(
  "intercompany_relationship_policies",
  {
    id: serial("id").primaryKey(),
    sourceCompanyId: integer("source_company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    destinationCompanyId: integer("destination_company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    relationshipType: varchar("relationship_type", { length: 40 }).notNull(),
    sourceReceivableAccountId: integer("source_receivable_account_id").references(() => ledgerAccounts.id, {
      onDelete: "restrict",
    }),
    destinationPayableAccountId: integer("destination_payable_account_id").references(() => ledgerAccounts.id, {
      onDelete: "restrict",
    }),
    destinationSupplierId: integer("destination_supplier_id").references(() => companyScopedSuppliers.id, {
      onDelete: "restrict",
    }),
    sourcePurchaseAccountId: integer("source_purchase_account_id").references(() => ledgerAccounts.id, {
      onDelete: "restrict",
    }),
    sourceSalesAccountId: integer("source_sales_account_id").references(() => ledgerAccounts.id, {
      onDelete: "restrict",
    }),
    sourceCostAccountId: integer("source_cost_account_id").references(() => ledgerAccounts.id, {
      onDelete: "restrict",
    }),
    sourceChargeAccrualAccountId: integer("source_charge_accrual_account_id").references(() => ledgerAccounts.id, {
      onDelete: "restrict",
    }),
    destinationGitAccountId: integer("destination_git_account_id").references(() => ledgerAccounts.id, {
      onDelete: "restrict",
    }),
    baseCurrency: varchar("base_currency", { length: 3 }).notNull().default("USD"),
    tradeEnabled: boolean("trade_enabled").notNull().default(false),
    immediateReconciliationEnabled: boolean("immediate_reconciliation_enabled").notNull().default(false),
    nightlyReconciliationEnabled: boolean("nightly_reconciliation_enabled").notNull().default(false),
    historicalAuditEnabled: boolean("historical_audit_enabled").notNull().default(false),
    historicalRepairEnabled: boolean("historical_repair_enabled").notNull().default(false),
    historicalBaselineVerifiedAt: timestamp("historical_baseline_verified_at", { withTimezone: true }),
    historicalRepairActivatedAt: timestamp("historical_repair_activated_at", { withTimezone: true }),
    historicalRepairActivatedBy: varchar("historical_repair_activated_by").references(() => users.id, {
      onDelete: "restrict",
    }),
    autoRepairPerItemLimit: decimal("auto_repair_per_item_limit", { precision: 20, scale: 2 }),
    autoRepairDailyLimit: decimal("auto_repair_daily_limit", { precision: 20, scale: 2 }),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniquePairType: uniqueIndex("intercompany_policy_pair_type_unique").on(
      t.sourceCompanyId,
      t.destinationCompanyId,
      t.relationshipType
    ),
    destinationIdx: index("intercompany_policy_destination_idx").on(t.destinationCompanyId),
  })
);

export const intercompanyTrades = pgTable(
  "intercompany_trades",
  {
    id: serial("id").primaryKey(),
    relationshipId: integer("relationship_id")
      .notNull()
      .references(() => intercompanyRelationshipPolicies.id, { onDelete: "restrict" }),
    physicalContainerId: integer("physical_container_id")
      .notNull()
      .references(() => containers.id, { onDelete: "restrict" }),
    sourceCompanyId: integer("source_company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    destinationCompanyId: integer("destination_company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    originalSupplierPoId: integer("original_supplier_po_id").references(() => purchaseOrders.id, {
      onDelete: "restrict",
    }),
    destinationPoId: integer("destination_po_id").references(() => purchaseOrders.id, { onDelete: "restrict" }),
    state: varchar("state", { length: 20 }).notNull().default("pending"),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    canceledAt: timestamp("canceled_at", { withTimezone: true }),
  },
  (t) => ({
    activeContainerUnique: uniqueIndex("intercompany_trade_one_active_container")
      .on(t.physicalContainerId)
      .where(sql.raw("state = 'active'")),
    activeDestinationPoUnique: uniqueIndex("intercompany_trade_active_dest_po_unique")
      .on(t.destinationPoId)
      .where(sql.raw("state = 'active' AND destination_po_id IS NOT NULL")),
    relationshipIdx: index("intercompany_trade_relationship_idx").on(t.relationshipId),
    sourcePoIdx: index("intercompany_trade_source_po_idx").on(t.originalSupplierPoId),
  })
);

export const intercompanyImportBatches = pgTable(
  "intercompany_import_batches",
  {
    id: serial("id").primaryKey(),
    sourceCompanyId: integer("source_company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    fileName: text("file_name").notNull(),
    fileSha256: varchar("file_sha256", { length: 64 }).notNull(),
    requestFingerprint: varchar("request_fingerprint", { length: 64 }).notNull(),
    state: varchar("state", { length: 20 }).notNull().default("pending"),
    createdBy: varchar("created_by").references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  },
  (t) => ({
    uniqueSourceFile: uniqueIndex("intercompany_import_source_file_unique").on(t.sourceCompanyId, t.fileSha256),
  })
);

export const intercompanyImportBatchContainers = pgTable(
  "intercompany_import_batch_containers",
  {
    id: serial("id").primaryKey(),
    batchId: integer("batch_id")
      .notNull()
      .references(() => intercompanyImportBatches.id, { onDelete: "restrict" }),
    containerNumber: varchar("container_number", { length: 100 }).notNull(),
    destinationCompanyId: integer("destination_company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    physicalContainerId: integer("physical_container_id").references(() => containers.id, { onDelete: "restrict" }),
    tradeId: integer("trade_id").references(() => intercompanyTrades.id, { onDelete: "restrict" }),
    chargesConfirmed: boolean("charges_confirmed").notNull().default(false),
    chargeEvidenceReference: text("charge_evidence_reference"),
    confirmedLandedCost: decimal("confirmed_landed_cost", { precision: 20, scale: 2 }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqueBatchContainer: uniqueIndex("intercompany_import_batch_container_unique").on(t.batchId, t.containerNumber),
  })
);

export const intercompanyPermissionGrants = pgTable(
  "intercompany_permission_grants",
  {
    id: serial("id").primaryKey(),
    userId: varchar("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    grantingCompanyId: integer("granting_company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    relationshipId: integer("relationship_id")
      .notNull()
      .references(() => intercompanyRelationshipPolicies.id, { onDelete: "restrict" }),
    permission: varchar("permission", { length: 50 }).notNull().default("shared_charge_editor"),
    scope: varchar("scope", { length: 20 }).notNull().default("invoice"),
    invoiceKey: varchar("invoice_key", { length: 120 }),
    grantedBy: varchar("granted_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedBy: varchar("revoked_by").references(() => users.id, { onDelete: "restrict" }),
  },
  (t) => ({
    userCompanyIdx: index("intercompany_grant_user_company_idx").on(t.userId, t.grantingCompanyId),
    activeGrantUnique: uniqueIndex("intercompany_grant_active_unique")
      .on(
        t.userId,
        t.grantingCompanyId,
        t.permission,
        t.scope,
        sql.raw("coalesce(invoice_key, '')"),
        sql.raw("coalesce(relationship_id, 0)")
      )
      .where(sql.raw("revoked_at IS NULL")),
  })
);

export const intercompanyAuditEvents = pgTable(
  "intercompany_audit_events",
  {
    id: serial("id").primaryKey(),
    eventKey: varchar("event_key", { length: 160 }).notNull().unique(),
    relationshipId: integer("relationship_id").references(() => intercompanyRelationshipPolicies.id, {
      onDelete: "restrict",
    }),
    sourceCompanyId: integer("source_company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    actorUserId: varchar("actor_user_id").references(() => users.id, { onDelete: "restrict" }),
    eventType: varchar("event_type", { length: 100 }).notNull(),
    sourceReference: text("source_reference"),
    payload: jsonb("payload").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    relationshipIdx: index("intercompany_audit_relationship_idx").on(t.relationshipId, t.createdAt),
  })
);

export const intercompanyReconciliationRuns = pgTable(
  "intercompany_reconciliation_runs",
  {
    id: serial("id").primaryKey(),
    relationshipId: integer("relationship_id").references(() => intercompanyRelationshipPolicies.id, {
      onDelete: "restrict",
    }),
    runKind: varchar("run_kind", { length: 32 }).notNull(),
    state: varchar("state", { length: 20 }).notNull().default("pending"),
    auditOnly: boolean("audit_only").notNull().default(true),
    cutoffDate: date("cutoff_date").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    error: text("error"),
  },
  (t) => ({
    relationshipRunIdx: index("intercompany_run_relationship_idx").on(t.relationshipId, t.startedAt),
  })
);

export const intercompanyReconciliationFindings = pgTable(
  "intercompany_reconciliation_findings",
  {
    id: serial("id").primaryKey(),
    runId: integer("run_id")
      .notNull()
      .references(() => intercompanyReconciliationRuns.id, { onDelete: "restrict" }),
    relationshipId: integer("relationship_id")
      .notNull()
      .references(() => intercompanyRelationshipPolicies.id, { onDelete: "restrict" }),
    findingFingerprint: varchar("finding_fingerprint", { length: 64 }).notNull(),
    evidenceFingerprint: varchar("evidence_fingerprint", { length: 64 }),
    status: varchar("status", { length: 24 }).notNull().default("investigate"),
    verified: boolean("verified").notNull().default(false),
    differenceBaseAmount: decimal("difference_base_amount", { precision: 20, scale: 2 }).notNull().default("0"),
    originalTransactionDate: date("original_transaction_date"),
    evidence: jsonb("evidence").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqueRunFinding: uniqueIndex("intercompany_run_finding_unique").on(t.runId, t.findingFingerprint),
    relationshipStatusIdx: index("intercompany_finding_relationship_status_idx").on(t.relationshipId, t.status),
  })
);

export const intercompanyRepairRequests = pgTable(
  "intercompany_repair_requests",
  {
    id: serial("id").primaryKey(),
    findingId: integer("finding_id")
      .notNull()
      .references(() => intercompanyReconciliationFindings.id, { onDelete: "restrict" }),
    relationshipId: integer("relationship_id")
      .notNull()
      .references(() => intercompanyRelationshipPolicies.id, { onDelete: "restrict" }),
    requestKey: varchar("request_key", { length: 160 }).notNull().unique(),
    evidenceFingerprint: varchar("evidence_fingerprint", { length: 64 }).notNull(),
    absoluteBaseAmount: decimal("absolute_base_amount", { precision: 20, scale: 2 }).notNull(),
    state: varchar("state", { length: 24 }).notNull().default("held"),
    originalTransactionDate: date("original_transaction_date").notNull(),
    proposedPostingDate: date("proposed_posting_date"),
    approvedBy: varchar("approved_by").references(() => users.id, { onDelete: "restrict" }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    postedVoucherId: integer("posted_voucher_id").references(() => vouchers.id, { onDelete: "restrict" }),
    postedAt: timestamp("posted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    relationshipStateIdx: index("intercompany_repair_relationship_state_idx").on(t.relationshipId, t.state),
  })
);

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


/** Exact source/destination row correspondence; never pair lines by name or approximate cost. */
export const intercompanyTradeLineLinks = pgTable(
  "intercompany_trade_line_links",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    tradeId: integer("trade_id").notNull().references(() => intercompanyTrades.id, { onDelete: "restrict" }),
    sourceLineId: integer("source_line_id").notNull().unique().references(() => poLineItems.id, { onDelete: "restrict" }),
    destinationLineId: integer("destination_line_id").notNull().unique().references(() => poLineItems.id, { onDelete: "restrict" }),
    originalExcelRow: integer("original_excel_row").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tradeIdx: index("ic_trade_line_trade_idx").on(t.tradeId),
    uniqueRow: uniqueIndex("ic_trade_line_excel_row_unique").on(t.tradeId, t.originalExcelRow),
  })
);

export const intercompanyTradeRevisions = pgTable(
  "intercompany_trade_revisions",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    tradeId: integer("trade_id").notNull().references(() => intercompanyTrades.id, { onDelete: "restrict" }),
    revisionNumber: integer("revision_number").notNull(),
    kind: varchar("kind", { length: 40 }).notNull(),
    requestKey: varchar("request_key", { length: 160 }).notNull().unique(),
    actorUserId: varchar("actor_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
    initiatingCompanyId: integer("initiating_company_id").notNull().references(() => companies.id, { onDelete: "restrict" }),
    state: varchar("state", { length: 20 }).notNull().default("posting"),
    amountBefore: decimal("amount_before", { precision: 20, scale: 2 }).notNull(),
    amountAfter: decimal("amount_after", { precision: 20, scale: 2 }).notNull(),
    postingDate: date("posting_date").notNull(),
    reason: text("reason").notNull(),
    evidence: jsonb("evidence").notNull().default({}),
    postedVoucherIds: integer("posted_voucher_ids").array().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => ({
    tradeIdx: index("ic_trade_revision_trade_idx").on(t.tradeId, t.createdAt),
    uniqueRevision: uniqueIndex("ic_trade_revision_number_unique").on(t.tradeId, t.revisionNumber),
  })
);

export const intercompanySharedChargeInvoices = pgTable(
  "intercompany_shared_charge_invoices",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    sourceCompanyId: integer("source_company_id").notNull().references(() => companies.id, { onDelete: "restrict" }),
    externalInvoiceKey: varchar("external_invoice_key", { length: 120 }).notNull(),
    chargeType: varchar("charge_type", { length: 32 }).notNull(),
    faceAmount: decimal("face_amount", { precision: 20, scale: 2 }).notNull(),
    currency: varchar("currency", { length: 3 }).notNull().default("USD"),
    evidenceReference: text("evidence_reference").notNull(),
    state: varchar("state", { length: 16 }).notNull().default("draft"),
    version: integer("version").notNull().default(1),
    createdBy: varchar("created_by").notNull().references(() => users.id, { onDelete: "restrict" }),
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
      .notNull().references(() => intercompanySharedChargeInvoices.id, { onDelete: "restrict" }),
    tradeId: integer("trade_id").notNull().references(() => intercompanyTrades.id, { onDelete: "restrict" }),
    amount: decimal("amount", { precision: 20, scale: 2 }).notNull(),
    containerChargeId: integer("container_charge_id").unique().references(() => containerCharges.id, { onDelete: "restrict" }),
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
      .notNull().references(() => intercompanySharedChargeInvoices.id, { onDelete: "restrict" }),
    tradeId: integer("trade_id").notNull().references(() => intercompanyTrades.id, { onDelete: "restrict" }),
    sourcePoId: integer("source_po_id").notNull().references(() => purchaseOrders.id, { onDelete: "restrict" }),
    amount: decimal("amount", { precision: 20, scale: 2 }).notNull(),
  },
  (t) => ({
    tradeIdx: index("ic_shared_charge_po_trade_idx").on(t.tradeId),
    uniqueSourcePo: uniqueIndex("ic_charge_po_unique").on(t.invoiceId, t.sourcePoId),
  })
);

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
