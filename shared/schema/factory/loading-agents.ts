import { sql } from "drizzle-orm";
import { bigserial, check, index, integer, pgTable, timestamp, uniqueIndex, varchar } from "drizzle-orm/pg-core";

/**
 * Factory Invoices (#3360), migration 0012_factory_loading_agents: the
 * company's reusable shipping agent names, chosen on a loading
 * (customer_orders.agent_name). One name per company, ignoring case.
 */
export const factoryLoadingAgents = pgTable(
  "factory_loading_agents",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    companyId: integer("company_id").notNull(),
    name: varchar("name", { length: 200 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("factory_loading_agents_name_not_blank", sql`length(btrim(${table.name})) > 0`),
    uniqueIndex("factory_loading_agents_company_name_ci_uniq").on(table.companyId, sql`lower(${table.name})`),
    index("factory_loading_agents_company_idx").on(table.companyId),
  ]
);

export type FactoryLoadingAgent = typeof factoryLoadingAgents.$inferSelect;
