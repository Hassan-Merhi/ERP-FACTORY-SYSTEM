import {
  pgTable,
  text,
  varchar,
  serial,
  integer,
  decimal,
  date,
  boolean,
  timestamp,
  uniqueIndex,
  index,
  jsonb,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { locations } from "../common";
import { customers } from "../erp";
import { customerOrders } from "./customer-orders";
import { factoryBales } from "./raw-stock-mix";

// ─── Factory Sheets ───────────────────────────────────────────────────────────
export const factorySheets = pgTable(
  "factory_sheets",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    name: text("name").notNull(),
    orderIndex: integer("order_index").notNull().default(0),
    columns: jsonb("columns").notNull().default([]),
    rows: jsonb("rows").notNull().default([]),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index("factory_sheets_company_idx").on(t.companyId),
  })
);

export const insertFactorySheetSchema = createInsertSchema(factorySheets).omit({
  id: true,
  updatedAt: true,
});
export type FactorySheet = typeof factorySheets.$inferSelect;
export type InsertFactorySheet = z.infer<typeof insertFactorySheetSchema>;

// ─── Factory V3 Loads ─────────────────────────────────────────────────────────
export const factoryV3Loads = pgTable(
  "factory_v3_loads",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    proformaId: integer("proforma_id").notNull(),
    loadName: text("load_name").notNull(),
    expectedLoadDate: date("expected_load_date").notNull(),
    notes: text("notes"),
    status: text("status").notNull().default("expected_to_load"),
    // users.id is a varchar UUID; these were integer and broke every write.
    createdBy: varchar("created_by"),
    createdByName: text("created_by_name"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    startedAt: timestamp("started_at"),
    finalizedAt: timestamp("finalized_at"),
    finalizedBy: varchar("finalized_by"),
    finalizedByName: text("finalized_by_name"),
    cancelledAt: timestamp("cancelled_at"),
  },
  (t) => ({
    companyIdx: index("factory_v3_loads_company_idx").on(t.companyId),
  })
);

export const insertFactoryV3LoadSchema = createInsertSchema(factoryV3Loads).omit({
  id: true,
  createdAt: true,
  startedAt: true,
  finalizedAt: true,
  cancelledAt: true,
});
export type FactoryV3Load = typeof factoryV3Loads.$inferSelect;
export type InsertFactoryV3Load = z.infer<typeof insertFactoryV3LoadSchema>;

// ─── Factory V3 Load Bales ────────────────────────────────────────────────────
export const factoryV3LoadBales = pgTable("factory_v3_load_bales", {
  id: serial("id").primaryKey(),
  loadId: integer("load_id").notNull(),
  baleId: integer("bale_id")
    .notNull()
    .references(() => factoryBales.id, { onDelete: "cascade" }),
  baleReference: varchar("bale_reference", { length: 100 }).notNull(),
  articleCode: varchar("article_code", { length: 50 }),
  productName: text("product_name"),
  weightKg: decimal("weight_kg", { precision: 15, scale: 3 }).notNull().default("0"),
  phase: text("phase").notNull().default("scanned"),
  addedBy: varchar("added_by"),
  addedByName: text("added_by_name"),
  addedAt: timestamp("added_at").notNull().defaultNow(),
  removedBy: varchar("removed_by"),
  removedByName: text("removed_by_name"),
  removedAt: timestamp("removed_at"),
  notes: text("notes"),
});

export const insertFactoryV3LoadBaleSchema = createInsertSchema(factoryV3LoadBales).omit({
  id: true,
  addedAt: true,
  removedAt: true,
});
export type FactoryV3LoadBale = typeof factoryV3LoadBales.$inferSelect;
export type InsertFactoryV3LoadBale = z.infer<typeof insertFactoryV3LoadBaleSchema>;

// ─── Factory Invoice Loading Sessions ────────────────────────────────────────
export const factoryInvoiceLoadingSessions = pgTable(
  "factory_invoice_loading_sessions",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    invoiceId: integer("invoice_id").notNull(),
    customerId: integer("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "restrict" }),
    locationId: integer("location_id").references(() => locations.id, { onDelete: "restrict" }),
    status: text("status").notNull().default("OPEN"),
    truckNo: text("truck_no"),
    driverName: text("driver_name"),
    notes: text("notes"),
    createdBy: varchar("created_by", { length: 100 }),
    createdByName: text("created_by_name"),
    startedAt: timestamp("started_at").notNull().defaultNow(),
    completedAt: timestamp("completed_at"),
    cancelledAt: timestamp("cancelled_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    invoiceIdx: index("factory_invoice_loading_sessions_invoice_idx").on(t.invoiceId),
    companyIdx: index("factory_invoice_loading_sessions_company_idx").on(t.companyId),
    statusIdx: index("factory_invoice_loading_sessions_status_idx").on(t.status),
  })
);

export const insertFactoryInvoiceLoadingSessionSchema = createInsertSchema(factoryInvoiceLoadingSessions).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  startedAt: true,
});
export type InsertFactoryInvoiceLoadingSession = z.infer<typeof insertFactoryInvoiceLoadingSessionSchema>;
export type FactoryInvoiceLoadingSession = typeof factoryInvoiceLoadingSessions.$inferSelect;

// ─── Factory Invoice Loading Bales ────────────────────────────────────────────
// IMPORTANT: No unique(companyId, invoiceId, baleId) constraint here.
// Cancelled sessions keep their bale rows for audit history.
export const factoryInvoiceLoadingBales = pgTable(
  "factory_invoice_loading_bales",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    sessionId: integer("session_id").notNull(),
    invoiceId: integer("invoice_id").notNull(),
    baleId: integer("bale_id").notNull(),
    baleReference: varchar("bale_reference", { length: 100 }).notNull(),
    articleCode: varchar("article_code", { length: 50 }),
    productName: text("product_name"),
    weightKg: decimal("weight_kg", { precision: 15, scale: 3 }).notNull().default("0"),
    scannedAt: timestamp("scanned_at").notNull().defaultNow(),
    scannedBy: varchar("scanned_by", { length: 100 }),
    scannedByName: text("scanned_by_name"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index("factory_invoice_loading_bales_company_idx").on(t.companyId),
    sessionIdx: index("factory_invoice_loading_bales_session_idx").on(t.sessionId),
    invoiceIdx: index("factory_invoice_loading_bales_invoice_idx").on(t.invoiceId),
    baleIdx: index("factory_invoice_loading_bales_bale_idx").on(t.baleId),
  })
);

export const insertFactoryInvoiceLoadingBaleSchema = createInsertSchema(factoryInvoiceLoadingBales).omit({
  id: true,
  scannedAt: true,
  createdAt: true,
});
export type FactoryInvoiceLoadingBale = typeof factoryInvoiceLoadingBales.$inferSelect;
export type InsertFactoryInvoiceLoadingBale = z.infer<typeof insertFactoryInvoiceLoadingBaleSchema>;

// ─── Factory Account WhatsApp Rules ──────────────────────────────────────────
export const factoryAccountWhatsappRules = pgTable(
  "factory_account_whatsapp_rules",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    ledgerAccountId: integer("ledger_account_id").notNull(),
    enabled: boolean("enabled").notNull().default(false),
    whatsappChatId: text("whatsapp_chat_id"),
    sendOnPayment: boolean("send_on_payment").notNull().default(true),
    sendOnReceipt: boolean("send_on_receipt").notNull().default(true),
    sendOnJournal: boolean("send_on_journal").notNull().default(true),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    uniqueAccountRule: uniqueIndex("factory_account_wa_rules_unique").on(t.companyId, t.ledgerAccountId),
    accountIdx: index("factory_account_wa_rules_account_idx").on(t.ledgerAccountId),
  })
);

export const insertFactoryAccountWhatsappRuleSchema = createInsertSchema(factoryAccountWhatsappRules).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type FactoryAccountWhatsappRule = typeof factoryAccountWhatsappRules.$inferSelect;
export type InsertFactoryAccountWhatsappRule = z.infer<typeof insertFactoryAccountWhatsappRuleSchema>;

// ─── Factory Production Sessions ─────────────────────────────────────────────
export const factoryProductionSessions = pgTable(
  "factory_production_sessions",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    sessionDate: varchar("session_date", { length: 10 }).notNull(),
    productionEndedAt: timestamp("production_ended_at"),
    productionEndedBy: text("production_ended_by"),
    workerMatrixWhatsappSentAt: timestamp("worker_matrix_whatsapp_sent_at"),
    workerMatrixWhatsappMessageId: text("worker_matrix_whatsapp_message_id"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    uniqueSession: uniqueIndex("factory_production_sessions_unique").on(t.companyId, t.sessionDate),
    companyIdx: index("factory_production_sessions_company_idx").on(t.companyId),
  })
);

export const insertFactoryProductionSessionSchema = createInsertSchema(factoryProductionSessions).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type FactoryProductionSession = typeof factoryProductionSessions.$inferSelect;
export type InsertFactoryProductionSession = z.infer<typeof insertFactoryProductionSessionSchema>;

// ─── Factory Shipping Container Rows ─────────────────────────────────────────
export const factoryShippingContainerRows = pgTable(
  "factory_shipping_container_rows",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    customerOrderId: integer("customer_order_id")
      .notNull()
      .references(() => customerOrders.id, { onDelete: "restrict" }),
    orderDate: date("order_date").notNull(),
    eta: date("eta"),
    containerArrivedDate: date("container_arrived_date"),
    note: text("note"),
    ciNumber: text("ci_number"),
    isDone: boolean("is_done").notNull().default(false),
    doneAt: timestamp("done_at"),
    doneBy: text("done_by"),
    whatsappSentAt: timestamp("whatsapp_sent_at"),
    shippingInvoiceFileName: text("shipping_invoice_file_name"),
    shippingInvoiceOriginalName: text("shipping_invoice_original_name"),
    shippingInvoiceFileUrl: text("shipping_invoice_file_url"),
    shippingInvoiceFileData: text("shipping_invoice_file_data"),
    shippingInvoiceFileType: text("shipping_invoice_file_type"),
    trackingLink: text("tracking_link"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index("fscr_company_idx").on(t.companyId),
    orderUnique: uniqueIndex("fscr_company_order_unique").on(t.companyId, t.customerOrderId),
  })
);

export const insertFactoryShippingContainerRowSchema = createInsertSchema(factoryShippingContainerRows)
  .omit({
    id: true,
    createdAt: true,
    updatedAt: true,
  })
  .extend({
    companyId: z.number().min(1),
    customerOrderId: z.number().min(1),
    orderDate: z.string().min(1),
    containerArrivedDate: z.string().optional().nullable(),
    note: z.string().optional().nullable(),
  });
export type InsertFactoryShippingContainerRow = z.infer<typeof insertFactoryShippingContainerRowSchema>;
export type FactoryShippingContainerRow = typeof factoryShippingContainerRows.$inferSelect;

// ─── Factory Shipping Container Documents ────────────────────────────────────
export const factoryShippingContainerDocuments = pgTable(
  "factory_shipping_container_documents",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    scrId: integer("scr_id")
      .notNull()
      .references(() => factoryShippingContainerRows.id, { onDelete: "cascade" }),
    displayName: text("display_name").notNull(),
    fileName: text("file_name").notNull(),
    originalName: text("original_name").notNull(),
    fileUrl: text("file_url").notNull(),
    fileType: text("file_type"),
    fileSize: integer("file_size"),
    fileData: text("file_data"),
    uploadedBy: text("uploaded_by"),
    uploadedAt: timestamp("uploaded_at").notNull().defaultNow(),
  },
  (t) => ({
    scrIdx: index("fscd_scr_idx").on(t.scrId),
    companyIdx: index("fscd_company_idx").on(t.companyId),
  })
);

export const insertFactoryShippingContainerDocumentSchema = createInsertSchema(factoryShippingContainerDocuments)
  .omit({
    id: true,
    uploadedAt: true,
  })
  .extend({
    companyId: z.number().min(1),
    scrId: z.number().min(1),
    displayName: z.string().min(1),
    fileName: z.string().min(1),
    originalName: z.string().min(1),
    fileUrl: z.string().min(1),
    fileType: z.string().optional().nullable(),
    fileSize: z.number().optional().nullable(),
    fileData: z.string().optional().nullable(),
    uploadedBy: z.string().optional().nullable(),
  });
export type InsertFactoryShippingContainerDocument = z.infer<typeof insertFactoryShippingContainerDocumentSchema>;
export type FactoryShippingContainerDocument = typeof factoryShippingContainerDocuments.$inferSelect;

// ─── Factory Shipping Availability ───────────────────────────────────────────
export const factoryShippingAvailability = pgTable(
  "factory_shipping_availability",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    date: date("date").notNull(),
    shippingCompany: text("shipping_company").notNull(),
    availableContainers: integer("available_containers").notNull().default(0),
    note: text("note"),
    isArchived: boolean("is_archived").notNull().default(false),
    archivedAt: timestamp("archived_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index("fsa_company_idx").on(t.companyId),
  })
);

export const insertFactoryShippingAvailabilitySchema = createInsertSchema(factoryShippingAvailability)
  .omit({
    id: true,
    isArchived: true,
    archivedAt: true,
    createdAt: true,
  })
  .extend({
    companyId: z.number().min(1),
    date: z.string().min(1),
    shippingCompany: z.string().min(1),
    availableContainers: z.number().int().min(0),
    note: z.string().nullable().optional(),
  });
export type InsertFactoryShippingAvailability = z.infer<typeof insertFactoryShippingAvailabilitySchema>;
export type FactoryShippingAvailability = typeof factoryShippingAvailability.$inferSelect;
