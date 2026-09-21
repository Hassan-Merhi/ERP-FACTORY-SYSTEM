import {
  boolean,
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

export type FactoryContainerPlan = typeof factoryContainerPlans.$inferSelect;
export type FactoryContainerPlanContainer = typeof factoryContainerPlanContainers.$inferSelect;
export type FactoryContainerPlanLine = typeof factoryContainerPlanLines.$inferSelect;
