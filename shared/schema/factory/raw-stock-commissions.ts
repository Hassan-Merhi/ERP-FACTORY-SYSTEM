/** Runtime Factory container commission and duty-audit tables, unchanged definitions. */
import { pgTable, text, varchar, serial, integer, decimal, boolean, timestamp, index } from "drizzle-orm/pg-core";
import { factoryContainers } from "./suppliers-containers";

// ─── Factory Container Commissions ───────────────────────────────────────────
export const factoryContainerCommissions = pgTable(
  "factory_container_commissions",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    containerId: integer("container_id")
      .notNull()
      .references(() => factoryContainers.id, { onDelete: "restrict" }),
    personName: text("person_name").notNull(),
    commissionType: text("commission_type").notNull().default("PER_KG"),
    commissionRate: decimal("commission_rate", { precision: 20, scale: 6 }).notNull(),
    commissionTotal: decimal("commission_total", { precision: 20, scale: 4 }).notNull(),
    currencyCode: varchar("currency_code", { length: 10 }).notNull().default("USD"),
    fxRateToUsd: decimal("fx_rate_to_usd", { precision: 20, scale: 8 }).notNull().default("1"),
    fxRateConfirmed: boolean("fx_rate_confirmed").notNull().default(false),
    commissionTotalUsd: decimal("commission_total_usd", { precision: 20, scale: 4 }),
    ledgerAccountId: integer("ledger_account_id"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    containerIdx: index("factory_container_commissions_container_idx").on(t.containerId),
    companyIdx: index("factory_container_commissions_company_idx").on(t.companyId),
  })
);

export type FactoryContainerCommission = typeof factoryContainerCommissions.$inferSelect;

// ─── Factory Duty Audit Log ───────────────────────────────────────────────────
export const factoryDutyAuditLog = pgTable(
  "factory_duty_audit_log",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    containerId: integer("container_id")
      .notNull()
      .references(() => factoryContainers.id, { onDelete: "restrict" }),
    oldDutyAmount: decimal("old_duty_amount", { precision: 20, scale: 2 }),
    newDutyAmount: decimal("new_duty_amount", { precision: 20, scale: 2 }).notNull(),
    oldDutyStatus: text("old_duty_status"),
    newDutyStatus: text("new_duty_status").notNull(),
    notes: text("notes"),
    updatedByUserId: text("updated_by_user_id").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index("factory_duty_audit_log_company_idx").on(t.companyId),
  })
);

export type FactoryDutyAuditLog = typeof factoryDutyAuditLog.$inferSelect;
