import {
  boolean,
  date,
  decimal,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { companies } from "../common";
import { users } from "../users";
import { vouchers } from "./vouchers";

export type RecurringJournalAccountType =
  "ledger" | "bank" | "supplier" | "factorySupplier" | "employee" | "fixedAsset" | "customer";

export interface RecurringJournalEntryTemplate {
  type: "DR" | "CR";
  accountType: RecurringJournalAccountType;
  accountId: number;
  amount: string;
  narration?: string | null;
}

/**
 * A durable monthly journal template.
 *
 * The first implementation intentionally supports one schedule rule:
 * MONTH_END. That keeps posting semantics deterministic while covering the
 * recurring savings / accrual journal use case. Additional rules can be added
 * later without changing the stored entry template.
 */
export const recurringJournals = pgTable(
  "recurring_journals",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    sourceVoucherId: integer("source_voucher_id")
      .notNull()
      .references(() => vouchers.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    descriptionTemplate: text("description_template"),
    frequency: varchar("frequency", { length: 20 }).notNull().default("monthly"),
    scheduleRule: varchar("schedule_rule", { length: 30 }).notNull().default("month_end"),
    timezone: text("timezone").notNull().default("UTC"),
    currency: varchar("currency", { length: 3 }).notNull().default("USD"),
    exchangeRate: decimal("exchange_rate", { precision: 20, scale: 10 }),
    entryTemplate: jsonb("entry_template").$type<RecurringJournalEntryTemplate[]>().notNull(),
    active: boolean("active").notNull().default(true),
    startDate: date("start_date").notNull(),
    endDate: date("end_date"),
    nextRunDate: date("next_run_date").notNull(),
    lastRunDate: date("last_run_date"),
    lastGeneratedVoucherId: integer("last_generated_voucher_id").references(() => vouchers.id, {
      onDelete: "set null",
    }),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdByUserId: varchar("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companySourceUnique: uniqueIndex("recurring_journals_company_source_unique").on(
      table.companyId,
      table.sourceVoucherId
    ),
    dueIdx: index("recurring_journals_due_idx").on(table.active, table.nextRunDate),
    companyIdx: index("recurring_journals_company_idx").on(table.companyId),
  })
);

export type RecurringJournal = typeof recurringJournals.$inferSelect;
