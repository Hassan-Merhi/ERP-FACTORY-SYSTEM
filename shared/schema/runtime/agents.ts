/**
 * GIT agent and transporter payment tracking.
 *
 * These tables are created by runtime DDL (CREATE TABLE IF NOT EXISTS in the
 * startup migrations and ensure* services). They are declared here so
 * drizzle-kit and the type system see the real schema; the definitions match
 * production column for column and the runtime DDL constraint for constraint
 * (tests/runtime-declared-tables-ddl.test.ts).
 */
import {
  pgTable,
  check,
  serial,
  text,
  timestamp,
  integer,
  varchar,
  numeric,
  index,
  unique,
  date,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const gitAgentAdjustments = pgTable(
  "git_agent_adjustments",
  {
    id: serial().primaryKey().notNull(),
    companyId: integer("company_id").notNull(),
    agentName: text("agent_name").notNull(),
    description: text().default("").notNull(),
    amount: numeric({ precision: 15, scale: 2 }).notNull(),
    type: text().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("idx_git_agent_adjustments_lookup").using("btree", table.companyId, table.agentName),
    check("git_agent_adjustments_type_check", sql`type = ANY (ARRAY['debit'::text, 'credit'::text])`),
  ]
);

export const gitPrepaidDesignations = pgTable(
  "git_prepaid_designations",
  {
    id: serial().primaryKey().notNull(),
    companyId: integer("company_id").notNull(),
    agentName: text("agent_name").notNull(),
    containerId: integer("container_id").notNull(),
    designatedBy: varchar("designated_by", { length: 255 }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("idx_git_prepaid_lookup").using("btree", table.companyId, table.agentName),
    unique("git_prepaid_designations_company_id_agent_name_container_id_key").on(
      table.companyId,
      table.agentName,
      table.containerId
    ),
  ]
);

export const transporterPaymentSettings = pgTable(
  "transporter_payment_settings",
  {
    id: serial().primaryKey().notNull(),
    companyId: integer("company_id").notNull(),
    ledgerAccountId: integer("ledger_account_id").notNull(),
    paymentTermsDays: integer("payment_terms_days").default(0).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [unique("transporter_payment_settings_uniq").on(table.companyId, table.ledgerAccountId)]
);

export const transporterEntryDueDates = pgTable(
  "transporter_entry_due_dates",
  {
    id: serial().primaryKey().notNull(),
    voucherEntryId: integer("voucher_entry_id").notNull(),
    companyId: integer("company_id").notNull(),
    dueDate: date("due_date").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [unique("transporter_entry_due_dates_entry_uniq").on(table.voucherEntryId)]
);

export const gitPrepaidActivityLog = pgTable("git_prepaid_activity_log", {
  id: serial().primaryKey().notNull(),
  companyId: integer("company_id").notNull(),
  agentName: text("agent_name").notNull(),
  action: text().notNull(),
  oldContainerId: integer("old_container_id"),
  newContainerId: integer("new_container_id"),
  oldContainerNumber: text("old_container_number"),
  newContainerNumber: text("new_container_number"),
  amount: numeric({ precision: 15, scale: 2 }),
  performedBy: varchar("performed_by", { length: 255 }),
  note: text(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const transporterPaymentAllocations = pgTable(
  "transporter_payment_allocations",
  {
    id: serial().primaryKey().notNull(),
    companyId: integer("company_id").notNull(),
    debitEntryId: integer("debit_entry_id").notNull(),
    creditEntryId: integer("credit_entry_id").notNull(),
    allocatedAmount: numeric("allocated_amount", { precision: 15, scale: 2 })
      .default(sql`0`)
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("transporter_alloc_company_idx").using("btree", table.companyId),
    index("transporter_alloc_credit_idx").using("btree", table.creditEntryId),
    index("transporter_alloc_debit_idx").using("btree", table.debitEntryId),
  ]
);

export const gitAgentNotes = pgTable(
  "git_agent_notes",
  {
    id: serial().primaryKey().notNull(),
    companyId: integer("company_id").notNull(),
    agentName: text("agent_name").notNull(),
    note: text().default("").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [unique("git_agent_notes_company_id_agent_name_key").on(table.companyId, table.agentName)]
);
