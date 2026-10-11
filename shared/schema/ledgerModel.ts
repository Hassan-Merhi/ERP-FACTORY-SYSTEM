/**
 * Phase 23 (chart of accounts and general ledger model) tables.
 *
 *   - fiscal_period_closure_history: every closure as it was when it was
 *     reopened (G12: the reopen used to hard-delete the closure row, so the
 *     close left no trace once undone). Append-only by convention; the reopen
 *     writes it in its own transaction.
 *   - opening_journal_applications: the reviewed opening journal of a company
 *     (G6): one applied row per company, with the cut-over date, the journal,
 *     the plan hash and the master openings it moved into the journal.
 *   - legacy_line_repairs: each legacy line a reviewed repair reclassified
 *     (G7), so a line is repaired at most once.
 */
import { pgTable, serial, integer, text, date, timestamp, jsonb, uniqueIndex, index } from "drizzle-orm/pg-core";

export const fiscalPeriodClosureHistory = pgTable(
  "fiscal_period_closure_history",
  {
    id: serial("id").primaryKey(),
    closureId: integer("closure_id").notNull(),
    companyId: integer("company_id").notNull(),
    periodStartDate: date("period_start_date").notNull(),
    periodEndDate: date("period_end_date").notNull(),
    closingVoucherId: integer("closing_voucher_id"),
    retainedEarningsAccountId: integer("retained_earnings_account_id"),
    closedByUserId: text("closed_by_user_id"),
    closedAt: timestamp("closed_at"),
    reopenedByUserId: text("reopened_by_user_id"),
    reopenedAt: timestamp("reopened_at").notNull().defaultNow(),
    reason: text("reason"),
    /** The closure row as it was, every column. */
    closure: jsonb("closure").$type<Record<string, unknown>>().notNull(),
  },
  (t) => ({
    companyIdx: index("fiscal_period_closure_history_company_idx").on(t.companyId, t.periodEndDate),
  })
);

export type FiscalPeriodClosureHistory = typeof fiscalPeriodClosureHistory.$inferSelect;

export const openingJournalApplications = pgTable(
  "opening_journal_applications",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    cutOverDate: date("cut_over_date").notNull(),
    voucherId: integer("voucher_id"),
    planHash: text("plan_hash").notNull(),
    status: text("status").notNull().default("APPLIED"),
    /** Every master opening the journal took over, as it was. */
    snapshot: jsonb("snapshot").$type<Record<string, unknown>[]>().notNull(),
    appliedByUserId: text("applied_by_user_id"),
    appliedAt: timestamp("applied_at").notNull().defaultNow(),
  },
  (t) => ({
    oneAppliedPerCompany: uniqueIndex("opening_journal_applications_company_unique").on(t.companyId),
  })
);

export type OpeningJournalApplication = typeof openingJournalApplications.$inferSelect;

export const legacyLineRepairs = pgTable(
  "legacy_line_repairs",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    entryId: integer("entry_id").notNull(),
    kind: text("kind").notNull(),
    repairVoucherId: integer("repair_voucher_id"),
    targetLedgerAccountId: integer("target_ledger_account_id"),
    placeholderLedgerAccountId: integer("placeholder_ledger_account_id"),
    planHash: text("plan_hash").notNull(),
    appliedByUserId: text("applied_by_user_id"),
    appliedAt: timestamp("applied_at").notNull().defaultNow(),
  },
  (t) => ({
    oneRepairPerLine: uniqueIndex("legacy_line_repairs_entry_unique").on(t.entryId),
    companyIdx: index("legacy_line_repairs_company_idx").on(t.companyId),
  })
);

export type LegacyLineRepair = typeof legacyLineRepairs.$inferSelect;
