import {
  pgTable,
  text,
  varchar,
  serial,
  integer,
  decimal,
  boolean,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { locations } from "./common";
import { ledgerAccounts } from "./accounting";
import { stockItems } from "./inventory";
import { isNonNegativeNumeric, isPositiveNumeric } from "../numericString";

export const draftPosSales = pgTable("draft_pos_sales", {
  id: serial("id").primaryKey(),
  userId: varchar("user_id", { length: 255 }).notNull(),
  locationId: integer("location_id")
    .notNull()
    .references(() => locations.id, { onDelete: "cascade" }),
  paymentAccountType: text("payment_account_type"),
  paymentAccountId: integer("payment_account_id"),
  isCreditSale: boolean("is_credit_sale").default(false),
  notes: text("notes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertDraftPosSaleSchema = createInsertSchema(draftPosSales)
  .omit({
    id: true,
    createdAt: true,
    updatedAt: true,
  })
  .extend({
    userId: z.string().min(1, "User is required"),
    locationId: z.number().min(1, "Location is required"),
    paymentAccountType: z.enum(["bank", "cash", "credit"]).optional(),
    paymentAccountId: z.number().optional(),
    isCreditSale: z.boolean().optional(),
    notes: z.string().optional(),
  });

export type InsertDraftPosSale = z.infer<typeof insertDraftPosSaleSchema>;
export type DraftPosSale = typeof draftPosSales.$inferSelect;

export const draftPosSaleItems = pgTable("draft_pos_sale_items", {
  id: serial("id").primaryKey(),
  draftId: integer("draft_id").notNull(),
  stockItemId: integer("stock_item_id")
    .notNull()
    .references(() => stockItems.id, { onDelete: "cascade" }),
  quantity: decimal("quantity", { precision: 15, scale: 3 }).notNull(),
  rate: decimal("rate", { precision: 15, scale: 2 }).notNull(),
  amount: decimal("amount", { precision: 15, scale: 2 }).notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertDraftPosSaleItemSchema = createInsertSchema(draftPosSaleItems)
  .omit({
    id: true,
    createdAt: true,
  })
  .extend({
    draftId: z.number().min(1, "Draft is required"),
    stockItemId: z.number().min(1, "Stock item is required"),
    quantity: z.string().refine(isPositiveNumeric, "Quantity must be positive"),
    rate: z.string().refine(isNonNegativeNumeric, "Rate must be non-negative"),
    amount: z.string(),
  });

export type InsertDraftPosSaleItem = z.infer<typeof insertDraftPosSaleItemSchema>;
export type DraftPosSaleItem = typeof draftPosSaleItems.$inferSelect;

export const posShifts = pgTable(
  "pos_shifts",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    locationId: integer("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "restrict" }),
    userId: varchar("user_id").notNull(),
    username: text("username").notNull(),
    cashAccountId: integer("cash_account_id").references(() => ledgerAccounts.id, { onDelete: "restrict" }),
    posStation: integer("pos_station"),
    status: text("status").notNull().default("open"),
    openedAt: timestamp("opened_at").notNull().defaultNow(),
    closedAt: timestamp("closed_at"),
    openingCash: decimal("opening_cash", { precision: 20, scale: 2 }).notNull().default("0"),
    closingCash: decimal("closing_cash", { precision: 20, scale: 2 }),
    expectedCash: decimal("expected_cash", { precision: 20, scale: 2 }),
    variance: decimal("variance", { precision: 20, scale: 2 }),
    salesCount: integer("sales_count").default(0),
    salesTotal: decimal("sales_total", { precision: 20, scale: 2 }).default("0"),
    notes: text("notes"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index("pos_shifts_company_idx").on(t.companyId),
  })
);

export const insertPosShiftSchema = createInsertSchema(posShifts)
  .omit({
    id: true,
    createdAt: true,
  })
  .extend({
    companyId: z.number().min(1, "Company is required"),
    locationId: z.number().min(1, "Location is required"),
    userId: z.string().min(1, "User ID is required"),
    username: z.string().min(1, "Username is required"),
    cashAccountId: z.number().optional(),
    posStation: z.number().optional(),
    openingCash: z.string().default("0"),
    status: z.enum(["open", "closed"]).default("open"),
  });

export type InsertPosShift = z.infer<typeof insertPosShiftSchema>;
export type PosShift = typeof posShifts.$inferSelect;

export const closePosShiftSchema = z.object({
  closingCash: z.string().min(1, "Closing cash is required"),
  notes: z.string().optional(),
});

export type ClosePosShift = z.infer<typeof closePosShiftSchema>;

export const posOfflineQueue = pgTable(
  "pos_offline_queue",
  {
    id: serial("id").primaryKey(),
    clientId: varchar("client_id", { length: 100 }).notNull(),
    companyId: integer("company_id").notNull(),
    locationId: integer("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "cascade" }),
    userId: varchar("user_id").notNull(),
    payload: jsonb("payload").notNull(),
    status: text("status").notNull().default("pending"),
    errorMessage: text("error_message"),
    retries: integer("retries").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    processedAt: timestamp("processed_at"),
  },
  (t) => ({
    companyIdx: index("pos_offline_queue_company_idx").on(t.companyId),
    uniqueClientId: uniqueIndex("pos_offline_queue_client_unique").on(t.clientId),
  })
);

export const insertPosOfflineQueueSchema = createInsertSchema(posOfflineQueue).omit({
  id: true,
  createdAt: true,
  processedAt: true,
});

export type InsertPosOfflineQueue = z.infer<typeof insertPosOfflineQueueSchema>;
export type PosOfflineQueue = typeof posOfflineQueue.$inferSelect;
