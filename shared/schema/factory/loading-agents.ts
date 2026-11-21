import { bigserial, check, index, integer, pgTable, timestamp, uniqueIndex, varchar } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Reusable loading agents of a company, offered on Factory Invoices; the name
 * chosen for an order is stored on customer_orders.agent_name. Created by
 * migration 0012_factory_loading_agents.sql.
 */
export const factoryLoadingAgents = pgTable(
  "factory_loading_agents",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    companyId: integer("company_id").notNull(),
    name: varchar("name", { length: 200 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    nameNotBlank: check("factory_loading_agents_name_not_blank", sql`length(btrim(${t.name})) > 0`),
    companyNameUnique: uniqueIndex("factory_loading_agents_company_name_ci_uniq").on(
      t.companyId,
      sql`lower(${t.name})`
    ),
    companyIdx: index("factory_loading_agents_company_idx").on(t.companyId),
  })
);
