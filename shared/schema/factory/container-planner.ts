import {
  boolean,
  decimal,
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { companies } from "../common";
import { customers } from "../erp/vouchers";

// Planning-only tables for Stock Allocation V5. They intentionally do not
// reference physical bale IDs or customer orders: Phase 2 is an editable draft
// layer and must not mutate loading/inventory until an explicit later conversion.
export const factoryContainerPlans = pgTable(
  "factory_container_plans",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    status: text("status").notNull().default("DRAFT"),
    capacityBales: integer("capacity_bales").notNull(),
    includeGarbageWipers: boolean("include_garbage_wipers").notNull().default(false),
    sourceStockTotal: integer("source_stock_total").notNull().default(0),
    sourceCommittedTotal: integer("source_committed_total").notNull().default(0),
    sourceLoadingTotal: integer("source_loading_total").notNull().default(0),
    sourcePlannableTotal: integer("source_plannable_total").notNull().default(0),
    clientRequestId: varchar("client_request_id", { length: 100 }),
    revision: integer("revision").notNull().default(1),
    createdBy: varchar("created_by", { length: 100 }),
    createdByName: text("created_by_name"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    requestUnique: uniqueIndex("factory_container_plans_request_unique").on(t.companyId, t.clientRequestId),
    companyUpdatedIdx: index("factory_container_plans_company_updated_idx").on(t.companyId, t.updatedAt),
  })
);

export const factoryContainerPlanContainers = pgTable(
  "factory_container_plan_containers",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    planId: integer("plan_id")
      .notNull()
      .references(() => factoryContainerPlans.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    name: text("name").notNull(),
    capacityBales: integer("capacity_bales").notNull(),
    isLocked: boolean("is_locked").notNull().default(false),
    lockedAt: timestamp("locked_at"),
    lockedBy: varchar("locked_by", { length: 100 }),
    lockedByName: text("locked_by_name"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    positionUnique: uniqueIndex("factory_container_plan_containers_position_unique").on(t.planId, t.position),
    companyPlanIdx: index("factory_container_plan_containers_company_idx").on(t.companyId, t.planId),
  })
);

export const factoryContainerPlanLines = pgTable(
  "factory_container_plan_lines",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    planId: integer("plan_id")
      .notNull()
      .references(() => factoryContainerPlans.id, { onDelete: "cascade" }),
    planContainerId: integer("plan_container_id")
      .notNull()
      .references(() => factoryContainerPlanContainers.id, { onDelete: "cascade" }),
    articleCode: varchar("article_code", { length: 100 }).notNull(),
    productName: text("product_name").notNull(),
    plannedQty: integer("planned_qty").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    articleUnique: uniqueIndex("factory_container_plan_lines_article_unique").on(t.planContainerId, t.articleCode),
    companyPlanIdx: index("factory_container_plan_lines_company_plan_idx").on(t.companyId, t.planId),
  })
);

// Phase 4 binds planned quantities to physical bales. The row itself is the
// reservation: factory_bales.status stays IN_STOCK so Phase 2/3 stock totals do
// not shift when a bale is scanned into a container.
export const factoryContainerPlanBales = pgTable(
  "factory_container_plan_bales",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    planId: integer("plan_id")
      .notNull()
      .references(() => factoryContainerPlans.id, { onDelete: "cascade" }),
    planContainerId: integer("plan_container_id")
      .notNull()
      .references(() => factoryContainerPlanContainers.id, { onDelete: "cascade" }),
    baleId: integer("bale_id").notNull(),
    articleCode: varchar("article_code", { length: 100 }).notNull(),
    baleCode: varchar("bale_code", { length: 100 }).notNull(),
    referenceNumber: varchar("reference_number", { length: 100 }).notNull(),
    productName: text("product_name").notNull(),
    weightKg: decimal("weight_kg", { precision: 15, scale: 3 }).notNull().default("0"),
    assignedVia: text("assigned_via").notNull().default("MANUAL"),
    assignedBy: varchar("assigned_by", { length: 100 }),
    assignedByName: text("assigned_by_name"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    baleUnique: uniqueIndex("factory_container_plan_bales_bale_unique").on(t.companyId, t.baleId),
    containerIdx: index("factory_container_plan_bales_container_idx").on(t.planContainerId, t.articleCode),
    companyPlanIdx: index("factory_container_plan_bales_plan_idx").on(t.companyId, t.planId),
  })
);

// Phase 5 reserves planned quantities for a customer. One order can span
// several containers and one container can serve several customers, so the
// grain is (container, customer, product).
export const factoryContainerPlanAllocations = pgTable(
  "factory_container_plan_allocations",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    planId: integer("plan_id")
      .notNull()
      .references(() => factoryContainerPlans.id, { onDelete: "cascade" }),
    planContainerId: integer("plan_container_id")
      .notNull()
      .references(() => factoryContainerPlanContainers.id, { onDelete: "cascade" }),
    customerId: integer("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    orderId: integer("order_id"),
    articleCode: varchar("article_code", { length: 100 }).notNull(),
    productName: text("product_name").notNull(),
    allocatedQty: integer("allocated_qty").notNull(),
    notes: text("notes"),
    createdBy: varchar("created_by", { length: 100 }),
    createdByName: text("created_by_name"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    allocationUnique: uniqueIndex("factory_container_plan_allocations_unique").on(
      t.planContainerId,
      t.customerId,
      t.articleCode
    ),
    companyPlanIdx: index("factory_container_plan_allocations_plan_idx").on(t.companyId, t.planId),
    companyCustomerIdx: index("factory_container_plan_allocations_customer_idx").on(t.companyId, t.customerId),
  })
);

export type FactoryContainerPlan = typeof factoryContainerPlans.$inferSelect;
export type FactoryContainerPlanContainer = typeof factoryContainerPlanContainers.$inferSelect;
export type FactoryContainerPlanLine = typeof factoryContainerPlanLines.$inferSelect;
export type FactoryContainerPlanBale = typeof factoryContainerPlanBales.$inferSelect;
export type FactoryContainerPlanAllocation = typeof factoryContainerPlanAllocations.$inferSelect;
