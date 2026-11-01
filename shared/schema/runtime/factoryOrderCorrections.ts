/**
 * Customer order extra expected lines (container-specific items imported onto
 * an order) and the audit of approved Factory destination normalizations.
 *
 * Created by runtime DDL (server/startup/ensureContainerExtraExpectedLines.ts and the
 * approved destination normalization startup jobs). Declared here so drizzle-kit and the
 * type system see the real schema; the definitions match the runtime DDL
 * (tests/runtime-declared-tables-ddl.test.ts).
 */
import {
  bigserial,
  check,
  foreignKey,
  index,
  integer,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { customerOrders } from "../factory/customer-orders";

export const customerOrderExtraExpectedLines = pgTable(
  "customer_order_extra_expected_lines",
  {
    id: bigserial({ mode: "number" }).primaryKey().notNull(),
    companyId: integer("company_id").notNull(),
    orderId: integer("order_id").notNull(),
    articleCode: varchar("article_code", { length: 100 }).notNull(),
    productName: text("product_name").notNull(),
    expectedQty: integer("expected_qty").notNull(),
    pricePerBale: numeric("price_per_bale", { precision: 18, scale: 4 }).notNull(),
    createdAt: timestamp("created_at", { mode: "string" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "string" }).defaultNow().notNull(),
  },
  (table) => [
    index("customer_order_extra_expected_lines_order_idx").using("btree", table.companyId, table.orderId),
    foreignKey({
      columns: [table.orderId],
      foreignColumns: [customerOrders.id],
      name: "customer_order_extra_expected_lines_order_id_fkey",
    }).onDelete("cascade"),
    unique("customer_order_extra_expected_lines_unique").on(table.companyId, table.orderId, table.articleCode),
    check(
      "customer_order_extra_expected_lines_expected_qty_check",
      sql`(expected_qty > 0) AND (expected_qty <= 100000)`
    ),
    check("customer_order_extra_expected_lines_price_per_bale_check", sql`price_per_bale >= (0)::numeric`),
  ]
);

export const factoryDestinationNormalizationAudit = pgTable(
  "factory_destination_normalization_audit",
  {
    companyId: integer("company_id").notNull(),
    customerId: integer("customer_id").notNull(),
    orderId: integer("order_id").notNull(),
    runKey: text("run_key").notNull(),
    oldDestination: text("old_destination").notNull(),
    newDestination: text("new_destination").notNull(),
    changedAt: timestamp("changed_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.companyId, table.orderId, table.runKey],
      name: "factory_destination_normalization_audit_pkey",
    }),
  ]
);
