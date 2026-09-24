import { sql } from "drizzle-orm";
import { pgTable, text, varchar, serial, integer, boolean, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { locations } from "./common";
import { ledgerAccounts } from "./accounting";

export const users = pgTable("users", {
  id: varchar("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
  active: boolean("active").notNull().default(true),
  chatbotEnabled: boolean("chatbot_enabled").notNull().default(true),
  hiddenErpCostFields: text("hidden_erp_cost_fields").array().notNull().default([]),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const userNotes = pgTable("user_notes", {
  id: serial("id").primaryKey(),
  userId: varchar("user_id")
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: "cascade" }),
  content: text("content").notNull().default(""),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type UserNote = typeof userNotes.$inferSelect;

export const insertUserSchema = createInsertSchema(users)
  .omit({
    id: true,
    createdAt: true,
  })
  .extend({
    username: z.string().min(1, "Username is required"),
    password: z.string().min(4, "Password must be at least 4 characters"),
  });

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;

export const userCompanyRoles = pgTable(
  "user_company_roles",
  {
    id: serial("id").primaryKey(),
    userId: varchar("user_id").notNull(),
    companyId: integer("company_id").notNull(),
    role: text("role").notNull(),
    assignedLocationId: integer("assigned_location_id").references(() => locations.id, { onDelete: "restrict" }),
    cashAccountId: integer("cash_account_id").references(() => ledgerAccounts.id, { onDelete: "restrict" }),
    posStation: integer("pos_station"),
    canSellNegativeStock: boolean("can_sell_negative_stock").notNull().default(false),
    posViewOnly: boolean("pos_view_only").notNull().default(false),
    daybookEditDays: integer("daybook_edit_days").notNull().default(0),
    canAccessCustomers: boolean("can_access_customers").notNull().default(false),
    canDeleteRecords: boolean("can_delete_records").notNull().default(false),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index("user_company_roles_company_idx").on(t.companyId),
  })
);

export const insertUserCompanyRoleSchema = createInsertSchema(userCompanyRoles)
  .omit({
    id: true,
    createdAt: true,
  })
  .extend({
    userId: z.string().min(1, "User ID is required"),
    companyId: z.number().min(1, "Company ID is required"),
    role: z.enum(["Developer", "Admin", "Owner", "Manager", "POS", "Normal User", "View Only"]),
  });

export type InsertUserCompanyRole = z.infer<typeof insertUserCompanyRoleSchema>;
export type UserCompanyRole = typeof userCompanyRoles.$inferSelect;

export const userLocations = pgTable(
  "user_locations",
  {
    id: serial("id").primaryKey(),
    userId: varchar("user_id").notNull(),
    companyId: integer("company_id").notNull(),
    locationId: integer("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index("user_locations_company_idx").on(t.companyId),
    userCompanyLocationIdx: index("user_locations_user_company_location_idx").on(
      t.userId,
      t.companyId,
      t.locationId
    ),
  })
);

export const insertUserLocationSchema = createInsertSchema(userLocations).omit({
  id: true,
  createdAt: true,
});

export type InsertUserLocation = z.infer<typeof insertUserLocationSchema>;
export type UserLocation = typeof userLocations.$inferSelect;

export const userLocationCashAccounts = pgTable(
  "user_location_cash_accounts",
  {
    id: serial("id").primaryKey(),
    userId: varchar("user_id").notNull(),
    companyId: integer("company_id").notNull(),
    locationId: integer("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "cascade" }),
    cashAccountId: integer("cash_account_id")
      .notNull()
      .references(() => ledgerAccounts.id, { onDelete: "restrict" }),
    posStation: integer("pos_station"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    uniqueUserCompanyLocation: uniqueIndex("ulca_user_company_location_unique").on(t.userId, t.companyId, t.locationId),
    companyIdx: index("ulca_company_idx").on(t.companyId),
    userIdx: index("ulca_user_idx").on(t.userId),
  })
);

export const insertUserLocationCashAccountSchema = createInsertSchema(userLocationCashAccounts).omit({
  id: true,
  createdAt: true,
});

export type InsertUserLocationCashAccount = z.infer<typeof insertUserLocationCashAccountSchema>;
export type UserLocationCashAccount = typeof userLocationCashAccounts.$inferSelect;

export const userPreferences = pgTable("user_preferences", {
  id: serial("id").primaryKey(),
  userId: varchar("user_id")
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: "cascade" }),
  dateFormat: text("date_format").notNull().default("MM/DD/YYYY"),
  preferredCurrency: varchar("preferred_currency", { length: 10 }),
  showProfitComparisonOnPOS: boolean("show_profit_comparison_on_pos").notNull().default(false),
  showChatWidget: boolean("show_chat_widget").notNull().default(true),
  showNotesPanel: boolean("show_notes_panel").notNull().default(true),
  hiddenTransactionJournalVoucherIds: integer("hidden_transaction_journal_voucher_ids").array().notNull().default([]),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertUserPreferencesSchema = createInsertSchema(userPreferences)
  .omit({
    id: true,
    createdAt: true,
    updatedAt: true,
  })
  .extend({
    userId: z.string().min(1, "User ID is required"),
    dateFormat: z.enum(["MM/DD/YYYY", "DD/MM/YYYY"]).default("MM/DD/YYYY"),
    preferredCurrency: z.string().nullable().optional(),
  });

export type InsertUserPreferences = z.infer<typeof insertUserPreferencesSchema>;
export type UserPreferences = typeof userPreferences.$inferSelect;

export const userPresence = pgTable(
  "user_presence",
  {
    id: serial("id").primaryKey(),
    sessionId: varchar("session_id", { length: 255 }).notNull(),
    userId: varchar("user_id").notNull(),
    username: text("username").notNull(),
    currentRoute: text("current_route").notNull().default("/"),
    companyId: integer("company_id"),
    companyName: text("company_name"),
    role: text("role"),
    lastSeen: timestamp("last_seen").notNull().defaultNow(),
  },
  (t) => ({
    uniqueSession: uniqueIndex("user_presence_session_unique").on(t.sessionId),
    // Active-user list and screen-feed tenant gate both filter by last_seen
    // (and often company_id). Without this the presence table is a sequential
    // scan on every heartbeat cleanup and Watch panel refresh.
    lastSeenIdx: index("user_presence_last_seen_idx").on(t.lastSeen),
    companyLastSeenIdx: index("user_presence_company_last_seen_idx").on(t.companyId, t.lastSeen),
    userLastSeenIdx: index("user_presence_user_last_seen_idx").on(t.userId, t.lastSeen),
  })
);

export const insertUserPresenceSchema = createInsertSchema(userPresence).omit({
  id: true,
});

export type InsertUserPresence = z.infer<typeof insertUserPresenceSchema>;
export type UserPresence = typeof userPresence.$inferSelect;

export const updatePresenceSchema = z.object({
  route: z.string(),
  type: z.enum(["route_change", "heartbeat"]).optional().default("heartbeat"),
});

export type UpdatePresence = z.infer<typeof updatePresenceSchema>;

export const userActivityLog = pgTable("user_activity_log", {
  id: serial("id").primaryKey(),
  userId: varchar("user_id").notNull(),
  username: text("username").notNull(),
  companyId: integer("company_id"),
  companyName: text("company_name"),
  route: text("route").notNull(),
  occurredAt: timestamp("occurred_at").notNull().defaultNow(),
});

export type UserActivityLog = typeof userActivityLog.$inferSelect;

export const loginHistory = pgTable(
  "login_history",
  {
    id: serial("id").primaryKey(),
    userId: varchar("user_id").notNull(),
    username: text("username").notNull(),
    companyId: integer("company_id"),
    companyName: text("company_name"),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    city: text("city"),
    country: text("country"),
    loginAt: timestamp("login_at").notNull().defaultNow(),
  },
  (t) => ({
    userIdx: index("login_history_user_idx").on(t.userId),
    loginAtIdx: index("login_history_login_at_idx").on(t.loginAt),
  })
);

export type LoginHistory = typeof loginHistory.$inferSelect;

export const directMessages = pgTable(
  "direct_messages",
  {
    id: serial("id").primaryKey(),
    senderId: varchar("sender_id").notNull(),
    receiverId: varchar("receiver_id").notNull(),
    message: text("message"),
    fileUrl: text("file_url"),
    fileName: text("file_name"),
    fileType: text("file_type"),
    fileSize: integer("file_size"),
    readAt: timestamp("read_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    senderIdx: index("direct_messages_sender_idx").on(t.senderId),
    receiverIdx: index("direct_messages_receiver_idx").on(t.receiverId),
  })
);

export const insertDirectMessageSchema = createInsertSchema(directMessages)
  .omit({
    id: true,
    createdAt: true,
    readAt: true,
  })
  .extend({
    receiverId: z.string().min(1, "Receiver is required"),
    message: z.string().optional(),
    fileUrl: z.string().optional(),
    fileName: z.string().optional(),
    fileType: z.string().optional(),
    fileSize: z.number().optional(),
  })
  .refine((d) => d.message || d.fileUrl, { message: "Message or file is required" });

export type InsertDirectMessage = z.infer<typeof insertDirectMessageSchema>;
export type DirectMessage = typeof directMessages.$inferSelect;

export const roleFeaturePermissions = pgTable(
  "role_feature_permissions",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    role: text("role").notNull(),
    featureKey: text("feature_key").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    uniqueCompanyRoleFeature: uniqueIndex("role_feature_permissions_unique").on(t.companyId, t.role, t.featureKey),
  })
);

export const insertRoleFeaturePermissionSchema = createInsertSchema(roleFeaturePermissions)
  .omit({
    id: true,
    createdAt: true,
    updatedAt: true,
  })
  .extend({
    companyId: z.number().min(1, "Company is required"),
    role: z.enum(["Developer", "Admin", "Owner", "Manager", "POS", "Normal User", "View Only"]),
    featureKey: z.string().min(1, "Feature key is required"),
    enabled: z.boolean().default(true),
  });

export type InsertRoleFeaturePermission = z.infer<typeof insertRoleFeaturePermissionSchema>;
export type RoleFeaturePermission = typeof roleFeaturePermissions.$inferSelect;