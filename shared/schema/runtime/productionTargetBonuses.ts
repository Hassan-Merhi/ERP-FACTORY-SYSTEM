/**
 * Production Targets bonus rates, reviews, category allocations, checkout
 * details and daily/weekly/manual payments.
 *
 * These tables are created by runtime DDL (server/startup/factoryStaffTrackingSchema.ts
 * and server/startup/ensureFactoryTargetBonusPaymentSchema.ts). They are declared here so
 * drizzle-kit and the type system see the real schema; the definitions match the
 * runtime DDL column for column, with its constraint and index names
 * (tests/runtime-declared-tables-ddl.test.ts).
 */
import {
  bigint,
  bigserial,
  boolean,
  char,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { factoryWorkers } from "../factory/workers-payroll";
import { ledgerAccounts } from "../accounting";
import { vouchers } from "../erp/vouchers";

export const factoryProductionTargetBonusRates = pgTable(
  "factory_production_target_bonus_rates",
  {
    id: serial().primaryKey().notNull(),
    companyId: integer("company_id").notNull(),
    scope: varchar({ length: 12 }).notNull(),
    workerId: integer("worker_id"),
    effectiveFrom: date("effective_from").notNull(),
    enabled: boolean().default(false).notNull(),
    ratePerExtraBale: numeric("rate_per_extra_bale", { precision: 20, scale: 4 })
      .default(sql`0`)
      .notNull(),
    note: varchar({ length: 500 }),
    requestKey: varchar("request_key", { length: 128 }).notNull(),
    createdBy: varchar("created_by", { length: 255 }),
    createdAt: timestamp("created_at", { mode: "string" }).defaultNow().notNull(),
  },
  (table) => [
    index("factory_production_target_bonus_history_idx").using(
      "btree",
      table.companyId,
      table.workerId,
      table.effectiveFrom.desc().nullsFirst(),
      table.id.desc().nullsFirst()
    ),
    uniqueIndex("factory_production_target_bonus_req_unique").using("btree", table.companyId, table.requestKey),
    foreignKey({
      columns: [table.workerId],
      foreignColumns: [factoryWorkers.id],
      name: "factory_production_target_bonus_rates_worker_id_fkey",
    }).onDelete("restrict"),
    check("factory_production_target_bonus_rates_scope_check", sql`scope IN ('company', 'worker')`),
    check(
      "factory_production_target_bonus_rates_rate_per_extra_bale_check",
      sql`(rate_per_extra_bale >= (0)::numeric) AND (rate_per_extra_bale <= (10000)::numeric)`
    ),
    check(
      "factory_production_target_bonus_scope_check",
      sql`(((scope)::text = 'company'::text) AND (worker_id IS NULL)) OR (((scope)::text = 'worker'::text) AND (worker_id IS NOT NULL))`
    ),
  ]
);

export const factoryProductionTargetBonusCategoryRates = pgTable(
  "factory_production_target_bonus_category_rates",
  {
    id: bigserial({ mode: "number" }).primaryKey().notNull(),
    companyId: integer("company_id").notNull(),
    categoryKey: varchar("category_key", { length: 100 }).notNull(),
    categoryLabel: varchar("category_label", { length: 100 }).notNull(),
    effectiveFrom: date("effective_from").notNull(),
    enabled: boolean().default(false).notNull(),
    ratePerExtraBale: numeric("rate_per_extra_bale", { precision: 20, scale: 4 })
      .default(sql`0`)
      .notNull(),
    note: varchar({ length: 500 }),
    requestKey: varchar("request_key", { length: 128 }).notNull(),
    createdBy: varchar("created_by", { length: 255 }),
    createdAt: timestamp("created_at", { mode: "string" }).defaultNow().notNull(),
  },
  (table) => [
    index("factory_bonus_category_rate_effective_idx").using(
      "btree",
      table.companyId,
      table.categoryKey,
      table.effectiveFrom.desc().nullsFirst(),
      table.id.desc().nullsFirst()
    ),
    unique("factory_bonus_category_rate_request_key_unique").on(table.companyId, table.requestKey),
    check(
      "factory_production_target_bonus_categ_rate_per_extra_bale_check",
      sql`(rate_per_extra_bale >= (0)::numeric) AND (rate_per_extra_bale <= (10000)::numeric)`
    ),
    check("factory_bonus_category_key_not_empty", sql`btrim((category_key)::text) <> ''::text`),
  ]
);

export const factoryProductionTargetBonusWeeklyMethods = pgTable(
  "factory_production_target_bonus_weekly_methods",
  {
    id: bigserial({ mode: "number" }).primaryKey().notNull(),
    companyId: integer("company_id").notNull(),
    effectiveWeek: date("effective_week").notNull(),
    method: varchar({ length: 20 }).notNull(),
    flatBonusUsd: numeric("flat_bonus_usd", { precision: 20, scale: 2 })
      .default(sql`0`)
      .notNull(),
    note: varchar({ length: 500 }),
    requestKey: varchar("request_key", { length: 128 }).notNull(),
    createdBy: varchar("created_by", { length: 255 }).notNull(),
    createdAt: timestamp("created_at", { mode: "string" }).defaultNow().notNull(),
  },
  (table) => [
    index("factory_bonus_weekly_method_history_idx").using(
      "btree",
      table.companyId,
      table.effectiveWeek.desc().nullsFirst(),
      table.id.desc().nullsFirst()
    ),
    unique("factory_bonus_weekly_method_request_unique").on(table.companyId, table.requestKey),
    check(
      "factory_production_target_bonus_weekly_methods_method_check",
      sql`method IN ('per_extra_bale', 'weekly_flat')`
    ),
    check(
      "factory_production_target_bonus_weekly_met_flat_bonus_usd_check",
      sql`(flat_bonus_usd >= (0)::numeric) AND (flat_bonus_usd <= (100000)::numeric)`
    ),
    check(
      "factory_bonus_weekly_method_amount_check",
      sql`(((method)::text = 'per_extra_bale'::text) AND (flat_bonus_usd = (0)::numeric)) OR (((method)::text = 'weekly_flat'::text) AND (flat_bonus_usd > (0)::numeric))`
    ),
    check("factory_bonus_weekly_method_monday_check", sql`EXTRACT(isodow FROM effective_week) = (1)::numeric`),
  ]
);

export const factoryTargetBonusCategoryBaleSnapshots = pgTable(
  "factory_target_bonus_category_bale_snapshots",
  {
    id: bigserial({ mode: "number" }).primaryKey().notNull(),
    companyId: integer("company_id").notNull(),
    productionDate: date("production_date").notNull(),
    baleId: integer("bale_id").notNull(),
    workerId: integer("worker_id").notNull(),
    categoryLabel: text("category_label"),
    finalizedAt: timestamp("finalized_at", { mode: "string" }),
    sourceStockDate: date("source_stock_date").notNull(),
    capturedAt: timestamp("captured_at", { mode: "string" }).defaultNow().notNull(),
  },
  (table) => [
    index("factory_bonus_category_bale_worker_idx").using(
      "btree",
      table.companyId,
      table.productionDate,
      table.workerId
    ),
    foreignKey({
      columns: [table.companyId, table.productionDate],
      foreignColumns: [
        factoryTargetBonusCategoryDayCaptures.companyId,
        factoryTargetBonusCategoryDayCaptures.productionDate,
      ],
      name: "factory_bonus_bale_capture_fk",
    }).onDelete("restrict"),
    unique("factory_bonus_bale_once_per_day").on(table.companyId, table.productionDate, table.baleId),
  ]
);

export const factoryTargetBonusCategoryAllocationSets = pgTable(
  "factory_target_bonus_category_allocation_sets",
  {
    id: bigserial({ mode: "number" }).primaryKey().notNull(),
    companyId: integer("company_id").notNull(),
    productionDate: date("production_date").notNull(),
    workerId: integer("worker_id").notNull(),
    dailyTargetBales: numeric("daily_target_bales", { precision: 12, scale: 2 }).notNull(),
    allocatedBy: varchar("allocated_by", { length: 255 }).notNull(),
    allocatedAt: timestamp("allocated_at", { mode: "string" }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.companyId, table.productionDate],
      foreignColumns: [
        factoryTargetBonusCategoryDayCaptures.companyId,
        factoryTargetBonusCategoryDayCaptures.productionDate,
      ],
      name: "factory_bonus_category_set_capture_fk",
    }).onDelete("restrict"),
    unique("factory_bonus_category_set_unique").on(table.companyId, table.productionDate, table.workerId),
    check("factory_target_bonus_category_allocati_daily_target_bales_check", sql`daily_target_bales >= (0)::numeric`),
  ]
);

export const factoryTargetBonusCategoryAllocations = pgTable(
  "factory_target_bonus_category_allocations",
  {
    id: bigserial({ mode: "number" }).primaryKey().notNull(),
    // You can use { mode: "number" } if numbers are exceeding js number limitations
    allocationSetId: bigint("allocation_set_id", { mode: "number" }).notNull(),
    categoryKey: varchar("category_key", { length: 100 }).notNull(),
    categoryLabel: varchar("category_label", { length: 100 }).notNull(),
    creditedBales: integer("credited_bales").notNull(),
    targetBales: numeric("target_bales", { precision: 12, scale: 2 }).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.allocationSetId],
      foreignColumns: [factoryTargetBonusCategoryAllocationSets.id],
      name: "factory_target_bonus_category_allocation_allocation_set_id_fkey",
    }).onDelete("restrict"),
    unique("factory_bonus_category_once_per_set").on(table.allocationSetId, table.categoryKey),
    check("factory_target_bonus_category_allocations_credited_bales_check", sql`credited_bales >= 0`),
    check("factory_target_bonus_category_allocations_target_bales_check", sql`target_bales >= (0)::numeric`),
  ]
);

export const factoryTargetBonusRates = pgTable(
  "factory_target_bonus_rates",
  {
    id: serial().primaryKey().notNull(),
    companyId: integer("company_id").notNull(),
    workerId: integer("worker_id").notNull(),
    effectiveFrom: date("effective_from").notNull(),
    ratePerBale: numeric("rate_per_bale", { precision: 16, scale: 4 }).notNull(),
    createdBy: varchar("created_by", { length: 255 }),
    createdAt: timestamp("created_at", { mode: "string" }).defaultNow().notNull(),
  },
  (table) => [
    index("factory_target_bonus_rate_history_idx").using(
      "btree",
      table.companyId,
      table.workerId,
      table.effectiveFrom.desc().nullsFirst()
    ),
    unique("factory_target_bonus_rate_unique").on(table.companyId, table.workerId, table.effectiveFrom),
    check("factory_target_bonus_rates_rate_per_bale_check", sql`rate_per_bale > (0)::numeric`),
  ]
);

export const factoryTargetBonusReviews = pgTable(
  "factory_target_bonus_reviews",
  {
    id: serial().primaryKey().notNull(),
    companyId: integer("company_id").notNull(),
    productionDate: date("production_date").notNull(),
    workerId: integer("worker_id").notNull(),
    targetBales: numeric("target_bales", { precision: 12, scale: 2 }).notNull(),
    producedBales: integer("produced_bales").notNull(),
    extraBales: numeric("extra_bales", { precision: 12, scale: 2 }).notNull(),
    ratePerBale: numeric("rate_per_bale", { precision: 16, scale: 4 }).notNull(),
    bonusAmount: numeric("bonus_amount", { precision: 18, scale: 2 }).notNull(),
    status: varchar({ length: 12 }).notNull(),
    reviewedBy: varchar("reviewed_by", { length: 255 }).notNull(),
    reviewedAt: timestamp("reviewed_at", { mode: "string" }).defaultNow().notNull(),
  },
  (table) => [
    index("factory_target_bonus_review_history_idx").using(
      "btree",
      table.companyId,
      table.productionDate.desc().nullsFirst(),
      table.status
    ),
    unique("factory_target_bonus_review_unique").on(table.companyId, table.productionDate, table.workerId),
    check("factory_target_bonus_reviews_target_bales_check", sql`target_bales >= (0)::numeric`),
    check("factory_target_bonus_reviews_produced_bales_check", sql`produced_bales >= 0`),
    check("factory_target_bonus_reviews_extra_bales_check", sql`extra_bales >= (0)::numeric`),
    check("factory_target_bonus_reviews_rate_per_bale_check", sql`rate_per_bale >= (0)::numeric`),
    check("factory_target_bonus_reviews_bonus_amount_check", sql`bonus_amount >= (0)::numeric`),
    check("factory_target_bonus_reviews_status_check", sql`status IN ('approved', 'rejected')`),
  ]
);

export const factoryTargetBonusCategoryReviews = pgTable(
  "factory_target_bonus_category_reviews",
  {
    id: bigserial({ mode: "number" }).primaryKey().notNull(),
    companyId: integer("company_id").notNull(),
    productionDate: date("production_date").notNull(),
    workerId: integer("worker_id").notNull(),
    // You can use { mode: "number" } if numbers are exceeding js number limitations
    allocationSetId: bigint("allocation_set_id", { mode: "number" }).notNull(),
    calculationVersion: varchar("calculation_version", { length: 80 }).notNull(),
    currencyCode: varchar("currency_code", { length: 3 }).default("USD").notNull(),
    targetBales: numeric("target_bales", { precision: 12, scale: 2 }).notNull(),
    creditedBales: integer("credited_bales").notNull(),
    extraBales: numeric("extra_bales", { precision: 12, scale: 2 }).notNull(),
    bonusAmount: numeric("bonus_amount", { precision: 18, scale: 2 }).notNull(),
    status: varchar({ length: 12 }).notNull(),
    snapshotJson: jsonb("snapshot_json").notNull(),
    snapshotHash: char("snapshot_hash", { length: 64 }).notNull(),
    reviewedBy: varchar("reviewed_by", { length: 255 }).notNull(),
    reviewedAt: timestamp("reviewed_at", { mode: "string" }).defaultNow().notNull(),
    reviewNote: varchar("review_note", { length: 500 }),
  },
  (table) => [
    index("factory_bonus_category_reviews_history_idx").using(
      "btree",
      table.companyId,
      table.productionDate.desc().nullsFirst(),
      table.workerId
    ),
    foreignKey({
      columns: [table.workerId],
      foreignColumns: [factoryWorkers.id],
      name: "factory_target_bonus_category_reviews_worker_id_fkey",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.allocationSetId],
      foreignColumns: [factoryTargetBonusCategoryAllocationSets.id],
      name: "factory_target_bonus_category_reviews_allocation_set_id_fkey",
    }).onDelete("restrict"),
    unique("factory_bonus_category_review_one_worker_day").on(table.companyId, table.productionDate, table.workerId),
    check("factory_target_bonus_category_reviews_currency_code_check", sql`(currency_code)::text = 'USD'::text`),
    check("factory_target_bonus_category_reviews_target_bales_check", sql`target_bales > (0)::numeric`),
    check("factory_target_bonus_category_reviews_credited_bales_check", sql`credited_bales >= 0`),
    check("factory_target_bonus_category_reviews_extra_bales_check", sql`extra_bales >= (0)::numeric`),
    check("factory_target_bonus_category_reviews_bonus_amount_check", sql`bonus_amount > (0)::numeric`),
    check("factory_target_bonus_category_reviews_status_check", sql`status IN ('approved', 'rejected')`),
    check(
      "factory_target_bonus_category_reviews_snapshot_json_check",
      sql`jsonb_typeof(snapshot_json) = 'object'::text`
    ),
    check("factory_bonus_category_review_hash_format", sql`snapshot_hash ~ '^[a-f0-9]{64}$'::text`),
  ]
);

export const factoryTargetBonusWeeklyReviews = pgTable(
  "factory_target_bonus_weekly_reviews",
  {
    id: bigserial({ mode: "number" }).primaryKey().notNull(),
    companyId: integer("company_id").notNull(),
    weekStart: date("week_start").notNull(),
    weekEnd: date("week_end").notNull(),
    workerId: integer("worker_id").notNull(),
    // You can use { mode: "number" } if numbers are exceeding js number limitations
    methodVersionId: bigint("method_version_id", { mode: "number" }).notNull(),
    calculationVersion: varchar("calculation_version", { length: 80 }).notNull(),
    currencyCode: char("currency_code", { length: 3 }).default("USD").notNull(),
    workerNameSnapshot: text("worker_name_snapshot").notNull(),
    targetBales: numeric("target_bales", { precision: 12, scale: 2 }).notNull(),
    creditedBales: integer("credited_bales").notNull(),
    extraBales: numeric("extra_bales", { precision: 12, scale: 2 }).notNull(),
    bonusAmount: numeric("bonus_amount", { precision: 18, scale: 2 }).notNull(),
    status: varchar({ length: 12 }).notNull(),
    snapshotJson: jsonb("snapshot_json").notNull(),
    snapshotHash: char("snapshot_hash", { length: 64 }).notNull(),
    reviewedBy: varchar("reviewed_by", { length: 255 }).notNull(),
    reviewedAt: timestamp("reviewed_at", { mode: "string" }).defaultNow().notNull(),
    reviewNote: varchar("review_note", { length: 500 }),
  },
  (table) => [
    index("factory_bonus_weekly_review_history_idx").using(
      "btree",
      table.companyId,
      table.weekStart.desc().nullsFirst(),
      table.workerId
    ),
    foreignKey({
      columns: [table.methodVersionId],
      foreignColumns: [factoryProductionTargetBonusWeeklyMethods.id],
      name: "factory_target_bonus_weekly_reviews_method_version_id_fkey",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.workerId],
      foreignColumns: [factoryWorkers.id],
      name: "factory_target_bonus_weekly_reviews_worker_id_fkey",
    }).onDelete("restrict"),
    unique("factory_bonus_weekly_one_worker_week").on(table.companyId, table.weekStart, table.workerId),
    check("factory_target_bonus_weekly_reviews_currency_code_check", sql`currency_code = 'USD'::bpchar`),
    check("factory_target_bonus_weekly_reviews_target_bales_check", sql`target_bales > (0)::numeric`),
    check("factory_target_bonus_weekly_reviews_credited_bales_check", sql`credited_bales >= 0`),
    check("factory_target_bonus_weekly_reviews_extra_bales_check", sql`extra_bales > (0)::numeric`),
    check("factory_target_bonus_weekly_reviews_bonus_amount_check", sql`bonus_amount > (0)::numeric`),
    check("factory_target_bonus_weekly_reviews_status_check", sql`status IN ('approved', 'rejected')`),
    check("factory_target_bonus_weekly_reviews_snapshot_json_check", sql`jsonb_typeof(snapshot_json) = 'object'::text`),
    check("factory_target_bonus_weekly_reviews_snapshot_hash_check", sql`snapshot_hash ~ '^[a-f0-9]{64}$'::text`),
    check("factory_bonus_weekly_monday", sql`EXTRACT(isodow FROM week_start) = (1)::numeric`),
    check("factory_bonus_weekly_end", sql`week_end = (week_start + 6)`),
  ]
);

export const factoryTargetBonusWeeklyPayments = pgTable(
  "factory_target_bonus_weekly_payments",
  {
    id: bigserial({ mode: "number" }).primaryKey().notNull(),
    companyId: integer("company_id").notNull(),
    // You can use { mode: "number" } if numbers are exceeding js number limitations
    reviewId: bigint("review_id", { mode: "number" }).notNull(),
    workerId: integer("worker_id").notNull(),
    weekStart: date("week_start").notNull(),
    weekEnd: date("week_end").notNull(),
    bonusAmount: numeric("bonus_amount", { precision: 18, scale: 2 }).notNull(),
    currencyCode: varchar("currency_code", { length: 3 }).default("USD").notNull(),
    paymentDate: date("payment_date").notNull(),
    cashLedgerAccountId: integer("cash_ledger_account_id").notNull(),
    expenseLedgerAccountId: integer("expense_ledger_account_id").notNull(),
    paymentVoucherId: integer("payment_voucher_id").notNull(),
    status: varchar({ length: 12 }).default("POSTED").notNull(),
    postedBy: varchar("posted_by", { length: 255 }).notNull(),
    postedAt: timestamp("posted_at", { mode: "string" }).defaultNow().notNull(),
    reversalVoucherId: integer("reversal_voucher_id"),
    reversedBy: varchar("reversed_by", { length: 255 }),
    reversedAt: timestamp("reversed_at", { mode: "string" }),
    reversalReason: text("reversal_reason"),
  },
  (table) => [
    index("factory_bonus_weekly_payments_date_idx").using(
      "btree",
      table.companyId,
      table.paymentDate.desc().nullsFirst(),
      table.workerId
    ),
    foreignKey({
      columns: [table.reviewId],
      foreignColumns: [factoryTargetBonusWeeklyReviews.id],
      name: "factory_target_bonus_weekly_payments_review_id_fkey",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.workerId],
      foreignColumns: [factoryWorkers.id],
      name: "factory_target_bonus_weekly_payments_worker_id_fkey",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.cashLedgerAccountId],
      foreignColumns: [ledgerAccounts.id],
      name: "factory_target_bonus_weekly_payment_cash_ledger_account_id_fkey",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.expenseLedgerAccountId],
      foreignColumns: [ledgerAccounts.id],
      name: "factory_target_bonus_weekly_paym_expense_ledger_account_id_fkey",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.paymentVoucherId],
      foreignColumns: [vouchers.id],
      name: "factory_target_bonus_weekly_payments_payment_voucher_id_fkey",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.reversalVoucherId],
      foreignColumns: [vouchers.id],
      name: "factory_target_bonus_weekly_payments_reversal_voucher_id_fkey",
    }).onDelete("restrict"),
    unique("factory_bonus_weekly_payment_review_unique").on(table.companyId, table.reviewId),
    unique("factory_bonus_weekly_payment_worker_week_unique").on(table.companyId, table.weekStart, table.workerId),
    unique("factory_bonus_weekly_payment_voucher_unique").on(table.paymentVoucherId),
    check("factory_target_bonus_weekly_payments_bonus_amount_check", sql`bonus_amount > (0)::numeric`),
    check("factory_target_bonus_weekly_payments_currency_code_check", sql`(currency_code)::text = 'USD'::text`),
    check("factory_target_bonus_weekly_payments_status_check", sql`status IN ('POSTED', 'REVERSED')`),
    check("factory_bonus_weekly_payment_end", sql`week_end = (week_start + 6)`),
    check(
      "factory_bonus_weekly_payment_reversal",
      sql`(((status)::text = 'POSTED'::text) AND (reversal_voucher_id IS NULL) AND (reversed_at IS NULL)) OR (((status)::text = 'REVERSED'::text) AND (reversal_voucher_id IS NOT NULL) AND (reversed_at IS NOT NULL))`
    ),
  ]
);

export const factoryTargetBonusPayments = pgTable(
  "factory_target_bonus_payments",
  {
    id: bigserial({ mode: "number" }).primaryKey().notNull(),
    companyId: integer("company_id").notNull(),
    reviewId: integer("review_id").notNull(),
    workerId: integer("worker_id").notNull(),
    productionDate: date("production_date").notNull(),
    bonusAmount: numeric("bonus_amount", { precision: 18, scale: 2 }).notNull(),
    currencyCode: varchar("currency_code", { length: 3 }).default("USD").notNull(),
    paymentDate: date("payment_date").notNull(),
    cashLedgerAccountId: integer("cash_ledger_account_id").notNull(),
    expenseLedgerAccountId: integer("expense_ledger_account_id").notNull(),
    paymentVoucherId: integer("payment_voucher_id").notNull(),
    status: varchar({ length: 12 }).default("POSTED").notNull(),
    postedBy: varchar("posted_by", { length: 255 }).notNull(),
    postedAt: timestamp("posted_at", { mode: "string" }).defaultNow().notNull(),
    reversalVoucherId: integer("reversal_voucher_id"),
    reversedBy: varchar("reversed_by", { length: 255 }),
    reversedAt: timestamp("reversed_at", { mode: "string" }),
    reversalReason: text("reversal_reason"),
  },
  (table) => [
    index("factory_target_bonus_payments_date").using("btree", table.companyId, table.paymentDate.desc().nullsFirst()),
    index("factory_target_bonus_payments_worker_day").using(
      "btree",
      table.companyId,
      table.workerId,
      table.productionDate
    ),
    foreignKey({
      columns: [table.reviewId],
      foreignColumns: [factoryTargetBonusReviews.id],
      name: "factory_target_bonus_payments_review_id_fkey",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.workerId],
      foreignColumns: [factoryWorkers.id],
      name: "factory_target_bonus_payments_worker_id_fkey",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.cashLedgerAccountId],
      foreignColumns: [ledgerAccounts.id],
      name: "factory_target_bonus_payments_cash_ledger_account_id_fkey",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.expenseLedgerAccountId],
      foreignColumns: [ledgerAccounts.id],
      name: "factory_target_bonus_payments_expense_ledger_account_id_fkey",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.paymentVoucherId],
      foreignColumns: [vouchers.id],
      name: "factory_target_bonus_payments_payment_voucher_id_fkey",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.reversalVoucherId],
      foreignColumns: [vouchers.id],
      name: "factory_target_bonus_payments_reversal_voucher_id_fkey",
    }).onDelete("restrict"),
    unique("factory_target_bonus_payments_review_unique").on(table.companyId, table.reviewId),
    unique("factory_target_bonus_payments_voucher_unique").on(table.paymentVoucherId),
    check("factory_target_bonus_payments_bonus_amount_check", sql`bonus_amount > (0)::numeric`),
    check("factory_target_bonus_payments_currency_code_check", sql`(currency_code)::text = 'USD'::text`),
    check("factory_target_bonus_payments_status_check", sql`status IN ('POSTED', 'REVERSED')`),
    check(
      "factory_target_bonus_payments_reversal_consistency",
      sql`(((status)::text = 'POSTED'::text) AND (reversal_voucher_id IS NULL) AND (reversed_at IS NULL)) OR (((status)::text = 'REVERSED'::text) AND (reversal_voucher_id IS NOT NULL) AND (reversed_at IS NOT NULL))`
    ),
  ]
);

export const factoryTargetBonusCheckoutDetails = pgTable(
  "factory_target_bonus_checkout_details",
  {
    id: bigserial({ mode: "number" }).primaryKey().notNull(),
    companyId: integer("company_id").notNull(),
    reviewId: integer("review_id").notNull(),
    method: varchar({ length: 12 }).notNull(),
    breakdown: jsonb().notNull(),
    calculationHash: char("calculation_hash", { length: 64 }).notNull(),
    createdBy: varchar("created_by", { length: 255 }).notNull(),
    createdAt: timestamp("created_at", { mode: "string" }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.reviewId],
      foreignColumns: [factoryTargetBonusReviews.id],
      name: "factory_target_bonus_checkout_details_review_id_fkey",
    }).onDelete("restrict"),
    unique("factory_target_bonus_checkout_review_unique").on(table.companyId, table.reviewId),
    check("factory_target_bonus_checkout_details_method_check", sql`method IN ('standard', 'category')`),
    check("factory_target_bonus_checkout_details_breakdown_check", sql`jsonb_typeof(breakdown) = 'array'::text`),
    check(
      "factory_target_bonus_checkout_details_calculation_hash_check",
      sql`calculation_hash ~ '^[a-f0-9]{64}$'::text`
    ),
  ]
);

export const factoryTargetBonusUnpaidRateRevisions = pgTable(
  "factory_target_bonus_unpaid_rate_revisions",
  {
    id: bigserial({ mode: "number" }).primaryKey().notNull(),
    companyId: integer("company_id").notNull(),
    reviewId: integer("review_id").notNull(),
    workerId: integer("worker_id").notNull(),
    productionDate: date("production_date").notNull(),
    method: varchar({ length: 12 }).notNull(),
    oldAmount: numeric("old_amount", { precision: 18, scale: 2 }).notNull(),
    newAmount: numeric("new_amount", { precision: 18, scale: 2 }).notNull(),
    oldRate: numeric("old_rate", { precision: 16, scale: 4 }).notNull(),
    newRate: numeric("new_rate", { precision: 16, scale: 4 }).notNull(),
    oldBreakdown: jsonb("old_breakdown"),
    newBreakdown: jsonb("new_breakdown").notNull(),
    repricedBy: varchar("repriced_by", { length: 255 }).notNull(),
    repricedAt: timestamp("repriced_at", { mode: "string" }).defaultNow().notNull(),
  },
  (table) => [
    index("factory_bonus_unpaid_rate_revisions_history").using(
      "btree",
      table.companyId,
      table.reviewId,
      table.repricedAt.desc().nullsFirst()
    ),
    foreignKey({
      columns: [table.reviewId],
      foreignColumns: [factoryTargetBonusReviews.id],
      name: "factory_target_bonus_unpaid_rate_revisions_review_id_fkey",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.workerId],
      foreignColumns: [factoryWorkers.id],
      name: "factory_target_bonus_unpaid_rate_revisions_worker_id_fkey",
    }).onDelete("restrict"),
    check("factory_target_bonus_unpaid_rate_revisions_method_check", sql`method IN ('standard', 'category')`),
  ]
);

export const factoryTargetBonusManualPayments = pgTable(
  "factory_target_bonus_manual_payments",
  {
    id: bigserial({ mode: "number" }).primaryKey().notNull(),
    companyId: integer("company_id").notNull(),
    workerId: integer("worker_id").notNull(),
    weekStart: date("week_start").notNull(),
    amountUsd: numeric("amount_usd", { precision: 18, scale: 2 }).notNull(),
    paymentDate: date("payment_date").notNull(),
    requestKey: uuid("request_key").notNull(),
    cashLedgerAccountId: integer("cash_ledger_account_id").notNull(),
    expenseLedgerAccountId: integer("expense_ledger_account_id").notNull(),
    paymentVoucherId: integer("payment_voucher_id").notNull(),
    status: varchar({ length: 12 }).default("POSTED").notNull(),
    postedBy: varchar("posted_by", { length: 255 }).notNull(),
    postedAt: timestamp("posted_at", { mode: "string" }).defaultNow().notNull(),
    reversalVoucherId: integer("reversal_voucher_id"),
    reversedBy: varchar("reversed_by", { length: 255 }),
    reversedAt: timestamp("reversed_at", { mode: "string" }),
    reversalReason: text("reversal_reason"),
  },
  (table) => [
    index("factory_manual_bonus_date_idx").using("btree", table.companyId, table.paymentDate.desc().nullsFirst()),
    index("factory_manual_bonus_worker_week_idx").using(
      "btree",
      table.companyId,
      table.workerId,
      table.weekStart,
      table.status
    ),
    foreignKey({
      columns: [table.workerId],
      foreignColumns: [factoryWorkers.id],
      name: "factory_target_bonus_manual_payments_worker_id_fkey",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.cashLedgerAccountId],
      foreignColumns: [ledgerAccounts.id],
      name: "factory_target_bonus_manual_payment_cash_ledger_account_id_fkey",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.expenseLedgerAccountId],
      foreignColumns: [ledgerAccounts.id],
      name: "factory_target_bonus_manual_paym_expense_ledger_account_id_fkey",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.paymentVoucherId],
      foreignColumns: [vouchers.id],
      name: "factory_target_bonus_manual_payments_payment_voucher_id_fkey",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.reversalVoucherId],
      foreignColumns: [vouchers.id],
      name: "factory_target_bonus_manual_payments_reversal_voucher_id_fkey",
    }).onDelete("restrict"),
    unique("factory_manual_bonus_request_worker_unique").on(table.companyId, table.requestKey, table.workerId),
    unique("factory_manual_bonus_voucher_unique").on(table.paymentVoucherId),
    check(
      "factory_target_bonus_manual_payments_amount_usd_check",
      sql`(amount_usd > (0)::numeric) AND (amount_usd <= (1000000)::numeric)`
    ),
    check("factory_target_bonus_manual_payments_check", sql`payment_date >= week_start`),
    check("factory_target_bonus_manual_payments_status_check", sql`status IN ('POSTED', 'REVERSED')`),
    check(
      "factory_manual_bonus_reversal_state",
      sql`(((status)::text = 'POSTED'::text) AND (reversal_voucher_id IS NULL) AND (reversed_at IS NULL)) OR (((status)::text = 'REVERSED'::text) AND (reversal_voucher_id IS NOT NULL) AND (reversed_at IS NOT NULL))`
    ),
  ]
);

export const factoryTargetBonusCategoryDayCaptures = pgTable(
  "factory_target_bonus_category_day_captures",
  {
    companyId: integer("company_id").notNull(),
    productionDate: date("production_date").notNull(),
    capturedAt: timestamp("captured_at", { mode: "string" }).defaultNow().notNull(),
    capturedBy: varchar("captured_by", { length: 255 }),
  },
  (table) => [
    primaryKey({
      columns: [table.companyId, table.productionDate],
      name: "factory_target_bonus_category_day_captures_pkey",
    }),
  ]
);
