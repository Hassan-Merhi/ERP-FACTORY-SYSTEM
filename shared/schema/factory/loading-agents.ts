import { bigserial, check, index, integer, pgTable, timestamp, uniqueIndex, varchar } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Reusable loading agents for Factory Invoices, one list per company.
 *
 * Created by migrations/0012_factory_loading_agents.sql. The names are matched
 * case-insensitively, so the unique index is on lower(name).
 */
export const factoryLoadingAgents = pgTable(
  "factory_loading_agents",
  {
    id: bigserial({ mode: "number" }).primaryKey().notNull(),
    companyId: integer("company_id").notNull(),
    name: varchar("name", { length: 200 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("factory_loading_agents_company_name_ci_uniq").on(table.companyId, sql`lower(${table.name})`),
    index("factory_loading_agents_company_idx").on(table.companyId),
    check("factory_loading_agents_name_not_blank", sql`length(btrim(${table.name})) > 0`),
  ]
);
