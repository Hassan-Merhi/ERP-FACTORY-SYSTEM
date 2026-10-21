/**
 * Unified accounting (Phases 3, 4, 5, 8, 13, 15) metadata tables.
 *
 * None of these tables is a ledger: they hold reconciliation matches,
 * statement imports, review sign-offs and rollout policy. No row here posts,
 * rewrites or revalues a voucher.
 *
 * Production creates them through the always-run startup DDL (the ensure*
 * services named on each table). The declarations below mirror that DDL —
 * same table, constraint and index names, the same CHECKs, FKs and partial
 * indexes — so a fresh database built by drizzle-kit has the same shape and
 * the startup DDL then finds every object already present. Row-level security
 * policies and the immutability triggers are added by the startup DDL only.
 */
import { sql } from "drizzle-orm";
import {
  pgTable,
  bigserial,
  bigint,
  integer,
  varchar,
  char,
  text,
  numeric,
  boolean,
  date,
  timestamp,
  index,
  unique,
  uniqueIndex,
  foreignKey,
  check,
} from "drizzle-orm/pg-core";
import { companies } from "./common";
import { ledgerAccounts } from "./accounting";
import { fiscalPeriodClosures, voucherEntries, vouchers } from "./erp/vouchers";
import { propertyContracts, propertyUnits } from "./properties";

const createdAt = (name: string) => timestamp(name, { withTimezone: true }).notNull().defaultNow();
const voidConsistent = (name: string, at: string, by: string, reason: string) =>
  check(
    name,
    sql.raw(
      `(${at} IS NULL AND ${by} IS NULL AND ${reason} IS NULL) OR (${at} IS NOT NULL AND ${by} IS NOT NULL AND ${reason} IS NOT NULL)`
    )
  );

/** Phase 3 party open-item matches — server/services/accounting/ensurePartyOpenItemSchema.ts */
export const accountingOpenItemMatches = pgTable(
  "accounting_open_item_matches",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    companyId: integer("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    domain: varchar("domain", { length: 24 }).notNull(),
    partyId: integer("party_id").notNull(),
    chargeEntryId: integer("charge_entry_id")
      .notNull()
      .references(() => voucherEntries.id, { onDelete: "restrict" }),
    settlementEntryId: integer("settlement_entry_id")
      .notNull()
      .references(() => voucherEntries.id, { onDelete: "restrict" }),
    amount: numeric("amount", { precision: 20, scale: 6 }).notNull(),
    currency: varchar("currency", { length: 10 }).notNull(),
    appliedOn: date("applied_on").notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 191 }).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt("created_at"),
    reason: text("reason"),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidedBy: text("voided_by"),
    voidReason: text("void_reason"),
  },
  (t) => ({
    domainCheck: check(
      "accounting_open_item_matches_domain_check",
      sql`${t.domain} IN ('customer', 'supplier', 'factory_supplier')`
    ),
    partyCheck: check("accounting_open_item_matches_party_id_check", sql`${t.partyId} > 0`),
    amountCheck: check("accounting_open_item_matches_amount_check", sql`${t.amount} > 0`),
    distinctEntries: check(
      "accounting_open_item_matches_distinct_entries",
      sql`${t.chargeEntryId} <> ${t.settlementEntryId}`
    ),
    voidConsistent: voidConsistent(
      "accounting_open_item_matches_void_consistent",
      "voided_at",
      "voided_by",
      "void_reason"
    ),
    idempotency: unique("accounting_open_item_matches_idempotency").on(t.companyId, t.idempotencyKey),
    chargeIdx: index("accounting_open_item_matches_charge_idx")
      .on(t.companyId, t.chargeEntryId)
      .where(sql`voided_at IS NULL`),
    settlementIdx: index("accounting_open_item_matches_settlement_idx")
      .on(t.companyId, t.settlementEntryId)
      .where(sql`voided_at IS NULL`),
    partyIdx: index("accounting_open_item_matches_party_idx").on(t.companyId, t.domain, t.partyId, t.appliedOn),
  })
);

/** Phase 4 cash/bank statements — server/services/accounting/ensureCashBankReconciliationSchema.ts */
export const accountingCashBankStatements = pgTable(
  "accounting_cash_bank_statements",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    companyId: integer("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    accountKind: varchar("account_kind", { length: 10 }).notNull(),
    accountId: integer("account_id").notNull(),
    currency: varchar("currency", { length: 10 }).notNull(),
    periodStart: date("period_start").notNull(),
    periodEnd: date("period_end").notNull(),
    openingBalance: numeric("opening_balance", { precision: 20, scale: 6 }).notNull(),
    closingBalance: numeric("closing_balance", { precision: 20, scale: 6 }).notNull(),
    fileHash: varchar("file_hash", { length: 64 }).notNull(),
    fileName: varchar("file_name", { length: 255 }).notNull(),
    importedBy: text("imported_by").notNull(),
    importedAt: createdAt("imported_at"),
  },
  (t) => ({
    kindCheck: check("accounting_cash_bank_statements_account_kind_check", sql`${t.accountKind} IN ('bank','ledger')`),
    accountCheck: check("accounting_cash_bank_statements_account_id_check", sql`${t.accountId} > 0`),
    validPeriod: check("cash_bank_statement_valid_period", sql`${t.periodStart} <= ${t.periodEnd}`),
    fileUnique: unique("cash_bank_statement_file_unique").on(t.companyId, t.accountKind, t.accountId, t.fileHash),
    accountIdx: index("accounting_cash_bank_statements_account_idx").on(
      t.companyId,
      t.accountKind,
      t.accountId,
      t.periodEnd.desc().nullsFirst()
    ),
  })
);

export const accountingCashBankStatementLines = pgTable(
  "accounting_cash_bank_statement_lines",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    companyId: integer("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    statementId: bigint("statement_id", { mode: "number" })
      .notNull()
      .references(() => accountingCashBankStatements.id, { onDelete: "restrict" }),
    rowNumber: integer("row_number").notNull(),
    transactionDate: date("transaction_date").notNull(),
    amount: numeric("amount", { precision: 20, scale: 6 }).notNull(),
    reference: text("reference"),
    description: text("description"),
    runningBalance: numeric("running_balance", { precision: 20, scale: 6 }),
    reviewCategory: varchar("review_category", { length: 32 }),
    reviewNote: text("review_note"),
    reviewedBy: text("reviewed_by"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  },
  (t) => ({
    rowCheck: check("accounting_cash_bank_statement_lines_row_number_check", sql`${t.rowNumber} > 0`),
    amountCheck: check("accounting_cash_bank_statement_lines_amount_check", sql`${t.amount} <> 0`),
    reviewCategoryCheck: check(
      "cash_bank_line_review_category_check",
      sql`${t.reviewCategory} IS NULL OR ${t.reviewCategory} IN ('bank_fee','transfer','unidentified_receipt','unidentified_payment','other')`
    ),
    lineUnique: unique("cash_bank_statement_line_unique").on(t.statementId, t.rowNumber),
    statementIdx: index("accounting_cash_bank_statement_lines_statement_idx").on(
      t.companyId,
      t.statementId,
      t.transactionDate
    ),
  })
);

export const accountingCashBankMatches = pgTable(
  "accounting_cash_bank_matches",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    companyId: integer("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    statementLineId: bigint("statement_line_id", { mode: "number" })
      .notNull()
      .references(() => accountingCashBankStatementLines.id, { onDelete: "restrict" }),
    voucherEntryId: integer("voucher_entry_id")
      .notNull()
      .references(() => voucherEntries.id, { onDelete: "restrict" }),
    matchedOn: date("matched_on").notNull(),
    matchedBy: text("matched_by").notNull(),
    reason: text("reason"),
    matchedAt: createdAt("matched_at"),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidedBy: text("voided_by"),
    voidReason: text("void_reason"),
  },
  (t) => ({
    voidConsistent: voidConsistent("cash_bank_match_void_consistent", "voided_at", "voided_by", "void_reason"),
    activeLine: uniqueIndex("cash_bank_match_active_line_uq")
      .on(t.statementLineId)
      .where(sql`voided_at IS NULL`),
    activeEntry: uniqueIndex("cash_bank_match_active_entry_uq")
      .on(t.voucherEntryId)
      .where(sql`voided_at IS NULL`),
    companyIdx: index("cash_bank_match_company_idx").on(t.companyId, t.statementLineId),
  })
);

/** Phase 5 realized FX evidence — server/services/accounting/ensureMonetaryFxSchema.ts */
export const accountingFxRealizations = pgTable(
  "accounting_fx_realizations",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    companyId: integer("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    matchId: bigint("match_id", { mode: "number" })
      .notNull()
      .references(() => accountingOpenItemMatches.id, { onDelete: "restrict" }),
    voucherId: integer("voucher_id")
      .notNull()
      .references(() => vouchers.id, { onDelete: "restrict" }),
    nativeCurrency: varchar("native_currency", { length: 10 }).notNull(),
    nativeAmount: numeric("native_amount", { precision: 20, scale: 6 }).notNull(),
    historicalChargeBase: numeric("historical_charge_base", { precision: 20, scale: 6 }).notNull(),
    historicalSettlementBase: numeric("historical_settlement_base", { precision: 20, scale: 6 }).notNull(),
    realizedGainBase: numeric("realized_gain_base", { precision: 20, scale: 6 }).notNull(),
    recognizedDate: date("recognized_date").notNull(),
    actor: text("actor").notNull(),
    createdAt: createdAt("created_at"),
  },
  (t) => ({
    matchUnique: unique("accounting_fx_realizations_match_unique").on(t.companyId, t.matchId),
    voucherUnique: unique("accounting_fx_realizations_voucher_unique").on(t.companyId, t.voucherId),
    companyIdx: index("accounting_fx_realizations_company_idx").on(t.companyId, t.recognizedDate),
  })
);

/** Phase 8 rental expense attribution — server/services/rental/ensureRentalAccountingLinksSchema.ts */
export const accountingRentalExpenseLinks = pgTable(
  "accounting_rental_expense_links",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    companyId: integer("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    module: varchar("module", { length: 12 }).notNull(),
    contractId: integer("contract_id")
      .notNull()
      .references(() => propertyContracts.id, { onDelete: "restrict" }),
    unitId: integer("unit_id")
      .notNull()
      .references(() => propertyUnits.id, { onDelete: "restrict" }),
    voucherId: integer("voucher_id")
      .notNull()
      .references(() => vouchers.id, { onDelete: "restrict" }),
    category: varchar("category", { length: 32 }).notNull(),
    allocatedUsd: numeric("allocated_usd", { precision: 20, scale: 6 }).notNull(),
    note: text("note"),
    taggedBy: text("tagged_by").notNull(),
    clientRequestKey: varchar("client_request_key", { length: 128 }),
    taggedAt: createdAt("tagged_at"),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidedBy: text("voided_by"),
    voidReason: text("void_reason"),
  },
  (t) => ({
    moduleCheck: check(
      "accounting_rental_expense_links_module_check",
      sql`${t.module} IN ('ERP','FACTORY','PROPERTIES')`
    ),
    categoryCheck: check(
      "accounting_rental_expense_links_category_check",
      sql`${t.category} IN ('maintenance','repairs','utilities','insurance','property_tax','other_property_cost')`
    ),
    allocatedCheck: check("accounting_rental_expense_links_allocated_usd_check", sql`${t.allocatedUsd} > 0`),
    voidConsistent: voidConsistent("rental_expense_link_void_consistent", "voided_at", "voided_by", "void_reason"),
    unitIdx: index("accounting_rental_expense_links_unit_idx")
      .on(t.companyId, t.module, t.unitId)
      .where(sql`voided_at IS NULL`),
    contractIdx: index("accounting_rental_expense_links_contract_idx")
      .on(t.companyId, t.module, t.contractId)
      .where(sql`voided_at IS NULL`),
    requestUnique: uniqueIndex("accounting_rental_expense_link_request_uq")
      .on(t.companyId, t.clientRequestKey)
      .where(sql`client_request_key IS NOT NULL`),
    voucherIdx: index("accounting_rental_expense_links_voucher_idx")
      .on(t.companyId, t.voucherId)
      .where(sql`voided_at IS NULL`),
  })
);

/** Phase 13 fiscal review — server/services/accounting/ensureFiscalReviewSchema.ts */
export const accountingFiscalReviewSignoffs = pgTable(
  "accounting_fiscal_review_signoffs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    companyId: integer("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    periodStartDate: date("period_start_date").notNull(),
    periodEndDate: date("period_end_date").notNull(),
    retainedEarningsAccountId: integer("retained_earnings_account_id")
      .notNull()
      .references(() => ledgerAccounts.id, { onDelete: "restrict" }),
    evidenceHash: char("evidence_hash", { length: 64 }).notNull(),
    reviewKind: varchar("review_kind", { length: 20 }).notNull(),
    reviewerId: text("reviewer_id").notNull(),
    reviewerName: text("reviewer_name").notNull(),
    reviewedAt: createdAt("reviewed_at"),
    note: text("note").notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedBy: text("revoked_by"),
    revokeReason: text("revoke_reason"),
  },
  (t) => ({
    kindCheck: check(
      "accounting_fiscal_review_signoffs_review_kind_check",
      sql`${t.reviewKind} IN ('ACCOUNTING','OWNER')`
    ),
    period: check("fiscal_signoff_period", sql`${t.periodStartDate} <= ${t.periodEndDate}`),
    revoke: voidConsistent("fiscal_signoff_revoke", "revoked_at", "revoked_by", "revoke_reason"),
    liveUnique: uniqueIndex("accounting_fiscal_review_live_unique")
      .on(t.companyId, t.periodStartDate, t.periodEndDate, t.retainedEarningsAccountId, t.evidenceHash, t.reviewKind)
      .where(sql`revoked_at IS NULL`),
    historyIdx: index("accounting_fiscal_review_history_idx").on(
      t.companyId,
      t.periodEndDate,
      t.reviewedAt.desc().nullsFirst()
    ),
    // A table constraint (backed by an index of this name) so the composite
    // company FKs below can reference it in the same push.
    companyIdUnique: unique("accounting_fiscal_review_signoffs_company_id_uq").on(t.companyId, t.id),
  })
);

export const accountingFiscalReviewPolicy = pgTable("accounting_fiscal_review_policy", {
  companyId: integer("company_id")
    .primaryKey()
    .references(() => companies.id, { onDelete: "restrict" }),
  enforceReviewedClose: boolean("enforce_reviewed_close").notNull().default(false),
  updatedBy: text("updated_by").notNull(),
  updatedAt: createdAt("updated_at"),
  reason: text("reason").notNull(),
});

export const accountingFiscalReviewedClosures = pgTable(
  "accounting_fiscal_reviewed_closures",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    companyId: integer("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    // An audited reopen deletes the closure row; the review evidence stays.
    fiscalClosureId: integer("fiscal_closure_id").references(() => fiscalPeriodClosures.id, { onDelete: "set null" }),
    closingVoucherId: integer("closing_voucher_id")
      .notNull()
      .references(() => vouchers.id, { onDelete: "restrict" }),
    accountingSignoffId: bigint("accounting_signoff_id", { mode: "number" })
      .notNull()
      .references(() => accountingFiscalReviewSignoffs.id, { onDelete: "restrict" }),
    ownerSignoffId: bigint("owner_signoff_id", { mode: "number" })
      .notNull()
      .references(() => accountingFiscalReviewSignoffs.id, { onDelete: "restrict" }),
    evidenceHash: char("evidence_hash", { length: 64 }).notNull(),
    certifiedAt: createdAt("certified_at"),
    reviewedBy: text("reviewed_by").notNull(),
  },
  (t) => ({
    distinctSignoffs: check(
      "fiscal_reviewed_closure_distinct_signoffs",
      sql`${t.accountingSignoffId} <> ${t.ownerSignoffId}`
    ),
    closureUnique: unique("fiscal_reviewed_closure_unique").on(t.companyId, t.fiscalClosureId),
    accountingCompanyFk: foreignKey({
      name: "fiscal_review_accounting_company_fk",
      columns: [t.companyId, t.accountingSignoffId],
      foreignColumns: [accountingFiscalReviewSignoffs.companyId, accountingFiscalReviewSignoffs.id],
    }).onDelete("restrict"),
    ownerCompanyFk: foreignKey({
      name: "fiscal_review_owner_company_fk",
      columns: [t.companyId, t.ownerSignoffId],
      foreignColumns: [accountingFiscalReviewSignoffs.companyId, accountingFiscalReviewSignoffs.id],
    }).onDelete("restrict"),
    dateIdx: index("accounting_fiscal_reviewed_closures_date_idx").on(t.companyId, t.certifiedAt.desc().nullsFirst()),
  })
);

/** Phase 15 rollout governance — server/services/accounting/ensureUnifiedAccountingRolloutSchema.ts */
export const accountingUnifiedReleaseReviews = pgTable(
  "accounting_unified_release_reviews",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    companyId: integer("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    releaseSha: varchar("release_sha", { length: 64 }).notNull(),
    reviewKind: varchar("review_kind", { length: 16 }).notNull(),
    evidenceReference: varchar("evidence_reference", { length: 500 }).notNull(),
    reviewerId: text("reviewer_id").notNull(),
    reviewerName: text("reviewer_name").notNull(),
    notes: text("notes").notNull(),
    reviewedAt: createdAt("reviewed_at"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedBy: text("revoked_by"),
    revokeReason: text("revoke_reason"),
  },
  (t) => ({
    shaCheck: check("accounting_unified_release_reviews_release_sha_check", sql`${t.releaseSha} ~ '^[0-9a-f]{40,64}$'`),
    kindCheck: check(
      "accounting_unified_release_reviews_review_kind_check",
      sql`${t.reviewKind} IN ('TECHNICAL','SECURITY','FINANCE')`
    ),
    notesCheck: check(
      "accounting_unified_release_reviews_notes_check",
      sql`length(trim(${t.notes})) BETWEEN 10 AND 2000`
    ),
    revocation: check(
      "unified_release_review_revocation_consistent",
      sql`(revoked_at IS NULL AND revoked_by IS NULL AND revoke_reason IS NULL) OR (revoked_at IS NOT NULL AND revoked_by IS NOT NULL AND length(trim(revoke_reason)) BETWEEN 10 AND 1000)`
    ),
    liveUnique: uniqueIndex("unified_release_reviews_unique_live")
      .on(t.companyId, t.releaseSha, t.reviewKind)
      .where(sql`revoked_at IS NULL`),
    companyIdx: index("unified_release_reviews_company_idx").on(t.companyId, t.reviewedAt.desc().nullsFirst()),
  })
);

export const accountingUnifiedRolloutPolicy = pgTable(
  "accounting_unified_rollout_policy",
  {
    companyId: integer("company_id")
      .primaryKey()
      .references(() => companies.id, { onDelete: "restrict" }),
    releaseMode: varchar("release_mode", { length: 24 }).notNull().default("READ_ONLY"),
    releaseSha: varchar("release_sha", { length: 64 }),
    approvedBy: text("approved_by").notNull(),
    approvedAt: createdAt("approved_at"),
    reason: text("reason").notNull(),
  },
  (t) => ({
    modeCheck: check(
      "accounting_unified_rollout_policy_release_mode_check",
      sql`${t.releaseMode} IN ('READ_ONLY','METADATA_PILOT')`
    ),
    reasonCheck: check(
      "accounting_unified_rollout_policy_reason_check",
      sql`length(trim(${t.reason})) BETWEEN 10 AND 1000`
    ),
    shaRequired: check(
      "unified_rollout_release_sha_required",
      sql`${t.releaseMode} = 'READ_ONLY' OR (${t.releaseSha} IS NOT NULL AND ${t.releaseSha} ~ '^[0-9a-f]{40,64}$')`
    ),
  })
);
