import {
  pgTable,
  text,
  varchar,
  serial,
  integer,
  decimal,
  timestamp,
  uniqueIndex,
  index,
  jsonb,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const stockItemMergeLogs = pgTable(
  "stock_item_merge_logs",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    keptItemId: integer("kept_item_id").notNull(),
    keptItemCode: varchar("kept_item_code", { length: 50 }).notNull(),
    keptItemName: text("kept_item_name").notNull(),
    mergedItemId: integer("merged_item_id").notNull(),
    mergedItemCode: varchar("merged_item_code", { length: 50 }).notNull(),
    mergedItemName: text("merged_item_name").notNull(),
    snapshotBefore: jsonb("snapshot_before")
      .notNull()
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`),
    snapshotAfter: jsonb("snapshot_after")
      .notNull()
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`),
    mergedByUserId: varchar("merged_by_user_id").notNull(),
    mergedAt: timestamp("merged_at").notNull().defaultNow(),
    notes: text("notes"),
  },
  (t) => ({
    companyIdx: index("stock_item_merge_logs_company_idx").on(t.companyId),
  })
);

export const insertStockItemMergeLogSchema = createInsertSchema(stockItemMergeLogs).omit({ id: true, mergedAt: true });
export type InsertStockItemMergeLog = z.infer<typeof insertStockItemMergeLogSchema>;
export type StockItemMergeLog = typeof stockItemMergeLogs.$inferSelect;

export const aiCompanySnapshots = pgTable(
  "ai_company_snapshots",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    snapshotType: varchar("snapshot_type", { length: 60 }).notNull(),
    data: jsonb("data").notNull().default({}),
    calculatedAt: timestamp("calculated_at").notNull().defaultNow(),
    expiresAt: timestamp("expires_at").notNull(),
  },
  (t) => ({
    companyTypeUniq: uniqueIndex("ai_snapshots_company_type_unique").on(t.companyId, t.snapshotType),
    expiresIdx: index("ai_snapshots_expires_idx").on(t.expiresAt),
  })
);

export type AiCompanySnapshot = typeof aiCompanySnapshots.$inferSelect;

export const aiAgentTasks = pgTable(
  "ai_agent_tasks",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    userId: varchar("user_id", { length: 100 }).notNull(),
    taskType: varchar("task_type", { length: 80 }).notNull().default("general"),
    userInstruction: text("user_instruction").notNull(),
    status: varchar("status", { length: 30 }).notNull().default("planned"),
    planJson: jsonb("plan_json"),
    resultJson: jsonb("result_json"),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index("ai_agent_tasks_company_idx").on(t.companyId),
    statusIdx: index("ai_agent_tasks_status_idx").on(t.status),
  })
);

export type AiAgentTask = typeof aiAgentTasks.$inferSelect;

export const aiAgentApprovals = pgTable(
  "ai_agent_approvals",
  {
    id: serial("id").primaryKey(),
    taskId: integer("task_id").notNull(),
    companyId: integer("company_id").notNull(),
    userId: varchar("user_id", { length: 100 }).notNull(),
    actionType: varchar("action_type", { length: 80 }).notNull(),
    actionLabel: text("action_label").notNull(),
    payloadJson: jsonb("payload_json"),
    previewJson: jsonb("preview_json"),
    status: varchar("status", { length: 30 }).notNull().default("pending"),
    approvedBy: varchar("approved_by", { length: 100 }),
    approvedAt: timestamp("approved_at"),
    postedAt: timestamp("posted_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    taskIdx: index("ai_agent_approvals_task_idx").on(t.taskId),
    companyIdx: index("ai_agent_approvals_company_idx").on(t.companyId),
  })
);

export type AiAgentApproval = typeof aiAgentApprovals.$inferSelect;

export const approvalRequests = pgTable(
  "approval_requests",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    requestedByUserId: varchar("requested_by_user_id", { length: 100 }).notNull(),
    requestedByUsername: text("requested_by_username").notNull(),
    actionType: text("action_type").notNull(),
    targetTable: text("target_table"),
    targetRecordId: integer("target_record_id"),
    targetIdentifier: text("target_identifier"),
    payload: jsonb("payload"),
    oldValue: jsonb("old_value"),
    newValue: jsonb("new_value"),
    amountValue: decimal("amount_value", { precision: 20, scale: 2 }),
    status: text("status").notNull().default("pending"),
    requestedAt: timestamp("requested_at").notNull().defaultNow(),
    reviewedByUserId: varchar("reviewed_by_user_id", { length: 100 }),
    reviewedByUsername: text("reviewed_by_username"),
    reviewedAt: timestamp("reviewed_at"),
    reviewerNote: text("reviewer_note"),
    executedAt: timestamp("executed_at"),
  },
  (t) => ({
    companyIdx: index("approval_requests_company_idx").on(t.companyId),
    statusIdx: index("approval_requests_status_idx").on(t.status),
  })
);

export type ApprovalRequest = typeof approvalRequests.$inferSelect;
export const insertApprovalRequestSchema = createInsertSchema(approvalRequests).omit({ id: true, requestedAt: true });
export type InsertApprovalRequest = z.infer<typeof insertApprovalRequestSchema>;
