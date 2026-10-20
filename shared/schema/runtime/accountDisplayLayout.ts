/**
 * Presentation-only account grouping shared by Accounts and Net Position.
 *
 * Created by runtime DDL (ensureRuntimeSchema and
 * migrations/20261019_account_display_layout.sql). Declared here so drizzle-kit
 * and the type system see the real schema; the definition matches the runtime
 * DDL column for column (tests/runtime-declared-tables-ddl.test.ts).
 */
import { pgTable, check, index, integer, primaryKey, text, timestamp, varchar } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const accountDisplayLayout = pgTable(
  "account_display_layout",
  {
    companyId: integer("company_id").notNull(),
    nodeKey: varchar("node_key", { length: 100 }).notNull(),
    nodeType: varchar("node_type", { length: 12 }).notNull(),
    name: text(),
    parentKey: varchar("parent_key", { length: 100 }),
    sortOrder: integer("sort_order").default(0).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.companyId, table.nodeKey], name: "account_display_layout_pkey" }),
    index("account_display_layout_company_parent_sort_idx").using(
      "btree",
      table.companyId,
      table.parentKey,
      table.sortOrder
    ),
    check("account_display_layout_node_type_check", sql`node_type IN ('group', 'ledger')`),
    check(
      "account_display_layout_shape",
      sql`(node_type = 'group' AND parent_key IS NULL AND length(trim(coalesce(name, ''))) > 0) OR (node_type = 'ledger' AND name IS NULL)`
    ),
  ]
);
