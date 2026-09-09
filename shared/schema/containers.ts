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
import { companies, locations } from "./common";
import { ledgerAccounts } from "./accounting";
import { stockItems } from "./inventory";
import { suppliers, vouchers } from "./erp";

export const containers = pgTable(
  "containers",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    containerNumber: varchar("container_number", { length: 100 }).notNull().unique(),
    supplierId: integer("supplier_id")
      .notNull()
      .references(() => suppliers.id, { onDelete: "restrict" }),
    status: text("status").notNull().default("OTW"),
    importDate: date("import_date").notNull(),
    itemsTotal: decimal("items_total", { precision: 20, scale: 2 }).default("0"),
    chargesTotal: decimal("charges_total", { precision: 20, scale: 2 }).default("0"),
    grandTotal: decimal("grand_total", { precision: 20, scale: 2 }).default("0"),
    itemName: text("item_name"),
    ratePerKg: decimal("rate_per_kg", { precision: 10, scale: 2 }),
    totalKg: decimal("total_kg", { precision: 15, scale: 2 }),
    shopName: text("shop_name"),
    eta: date("eta"),
    etaSource: text("eta_source").default("manual"),
    transporter: varchar("transporter", { length: 100 }),
    transportFee: decimal("transport_fee", { precision: 15, scale: 2 }),
    numberPlate: varchar("number_plate", { length: 50 }),
    trackingLocation: text("tracking_location"),
    borderDate: date("border_date"),
    offloadDate: date("offload_date"),
    agent: varchar("agent", { length: 100 }),
    dutyFee: decimal("duty_fee", { precision: 15, scale: 2 }),
    docReceived: boolean("doc_received").default(false),
    trackingDescription: text("tracking_description"),
    blDocs: text("bl_docs"),
    docsSentDate: date("docs_sent_date"),
    freightStatus: text("freight_status"),
    trackingLink: text("tracking_link"),
    trackingProvider: text("tracking_provider"),
    trackingEnabled: boolean("tracking_enabled").notNull().default(true),
    trackingAutoUpdate: boolean("tracking_auto_update").notNull().default(true),
    trackingCarrierHint: text("tracking_carrier_hint"),
    trackingLastCheckedAt: timestamp("tracking_last_checked_at", { withTimezone: true }),
    trackingLastStatus: text("tracking_last_status"),
    trackingLastLocation: text("tracking_last_location"),
    trackingLastEventDate: timestamp("tracking_last_event_date", { withTimezone: true }),
    trackingLastDescription: text("tracking_last_description"),
    trackingError: text("tracking_error"),
    trackingChangedAt: timestamp("tracking_changed_at", { withTimezone: true }),
    trackingDetectedCarrier: text("tracking_detected_carrier"),
    trackingFallbackUsed: boolean("tracking_fallback_used").default(false),
    trackingFallbackReason: text("tracking_fallback_reason"),
    trackingNextCheckAt: timestamp("tracking_next_check_at", { withTimezone: true }),
    trackingLastSkipReason: text("tracking_last_skip_reason"),
    // ── JSONCargo — dedicated ETA-only provider (Maersk/Hapag-Lloyd/MSC/CMA CGM) ──
    // Kept separate from the generic tracking* fields above because JSONCargo runs
    // on its own weekly cadence (JSONCARGO_REFRESH_HOURS) independent of the
    // multi-provider status/location scheduler, and only ever touches `eta`.
    jsonCargoLastCheckedAt: timestamp("json_cargo_last_checked_at", { withTimezone: true }),
    jsonCargoTrackingStatus: text("json_cargo_tracking_status"),
    jsonCargoError: text("json_cargo_error"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index("containers_company_idx").on(t.companyId),
  })
);

export const insertContainerSchema = createInsertSchema(containers)
  .omit({
    id: true,
    createdAt: true,
  })
  .extend({
    companyId: z.number().min(1, "Company is required"),
    containerNumber: z.string().min(1, "Container number is required"),
    supplierId: z.number().min(1, "Supplier is required"),
    importDate: z.string().min(1, "Import date is required"),
  });

export type InsertContainer = z.infer<typeof insertContainerSchema>;
export type Container = typeof containers.$inferSelect;

export const containerTrackingEvents = pgTable(
  "container_tracking_events",
  {
    id: serial("id").primaryKey(),
    containerId: integer("container_id").notNull(),
    provider: text("provider").notNull().default("parcelsapp"),
    eventTime: timestamp("event_time", { withTimezone: true }),
    eventStatus: text("event_status"),
    eventLocation: text("event_location"),
    eventDescription: text("event_description"),
    rawEventJson: jsonb("raw_event_json"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    dedupUnique: uniqueIndex("cte_dedup_unique").on(t.containerId, t.eventTime, t.eventStatus),
  })
);

export type ContainerTrackingEvent = typeof containerTrackingEvents.$inferSelect;

export const containerTrackingChecks = pgTable("container_tracking_checks", {
  id: serial("id").primaryKey(),
  containerId: integer("container_id").notNull(),
  provider: text("provider").notNull().default("parcelsapp"),
  status: text("status").notNull(),
  checkedAt: timestamp("checked_at").notNull(),
  errorMessage: text("error_message"),
  rawResponseJson: jsonb("raw_response_json"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type ContainerTrackingCheck = typeof containerTrackingChecks.$inferSelect;

export const agentDeclarantMappings = pgTable("agent_declarant_mappings", {
  id: serial("id").primaryKey(),
  agentName: varchar("agent_name", { length: 100 }).notNull(),
  companyId: integer("company_id").references(() => companies.id, { onDelete: "cascade" }),
  ledgerAccountId: integer("ledger_account_id").references(() => ledgerAccounts.id, { onDelete: "set null" }),
  aliases: text("aliases").array().notNull().default([]),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertAgentDeclarantMappingSchema = createInsertSchema(agentDeclarantMappings).omit({
  id: true,
  createdAt: true,
});
export type InsertAgentDeclarantMapping = z.infer<typeof insertAgentDeclarantMappingSchema>;
export type AgentDeclarantMapping = typeof agentDeclarantMappings.$inferSelect;

export const purchaseOrders = pgTable(
  "purchase_orders",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    poNumber: varchar("po_number", { length: 100 }).notNull(),
    containerId: integer("container_id")
      .notNull()
      .references(() => containers.id, { onDelete: "restrict" }),
    supplierId: integer("supplier_id")
      .notNull()
      .references(() => suppliers.id, { onDelete: "restrict" }),
    voucherId: integer("voucher_id").references(() => vouchers.id, { onDelete: "restrict" }),
    currency: text("currency").notNull().default("USD"),
    itemsTotal: decimal("items_total", { precision: 20, scale: 2 }).default("0"),
    freight: decimal("freight", { precision: 20, scale: 2 }).default("0"),
    surcharge: decimal("surcharge", { precision: 20, scale: 2 }).default("0"),
    fumigation: decimal("fumigation", { precision: 20, scale: 2 }).default("0"),
    documentCharges: decimal("document_charges", { precision: 20, scale: 2 }).default("0"),
    discount: decimal("discount", { precision: 20, scale: 2 }).default("0"),
    otherCharges: decimal("other_charges", { precision: 20, scale: 2 }).default("0"),
    chargesEdited: boolean("charges_edited").default(false),
    freightPaidBy: text("freight_paid_by").default("supplier"),
    freightOwnAccountId: integer("freight_own_account_id"),
    freightParentAccountId: integer("freight_parent_account_id"),
    status: text("status").notNull().default("Open"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index("purchase_orders_company_idx").on(t.companyId),
  })
);

export const insertPurchaseOrderSchema = createInsertSchema(purchaseOrders)
  .omit({
    id: true,
    createdAt: true,
  })
  .extend({
    companyId: z.number().min(1, "Company is required"),
    poNumber: z.string().min(1, "PO number is required"),
    containerId: z.number().min(1, "Container is required"),
    supplierId: z.number().min(1, "Supplier is required"),
    freight: z.string().optional(),
    surcharge: z.string().optional(),
    fumigation: z.string().optional(),
    documentCharges: z.string().optional(),
    discount: z.string().optional(),
    otherCharges: z.string().optional(),
    chargesEdited: z.boolean().optional(),
    freightPaidBy: z.string().optional(),
    freightOwnAccountId: z.number().optional().nullable(),
    freightParentAccountId: z.number().optional().nullable(),
  });

export type InsertPurchaseOrder = z.infer<typeof insertPurchaseOrderSchema>;
export type PurchaseOrder = typeof purchaseOrders.$inferSelect;

export const poLineItems = pgTable("po_line_items", {
  id: serial("id").primaryKey(),
  poId: integer("po_id")
    .notNull()
    .references(() => purchaseOrders.id, { onDelete: "cascade" }),
  stockItemId: integer("stock_item_id")
    .notNull()
    .references(() => stockItems.id, { onDelete: "restrict" }),
  itemName: text("item_name").notNull(),
  quantity: decimal("quantity", { precision: 15, scale: 3 }).notNull(),
  rate: decimal("rate", { precision: 15, scale: 2 }).notNull(),
  lineTotal: decimal("line_total", { precision: 20, scale: 2 }).notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertPOLineItemSchema = createInsertSchema(poLineItems)
  .omit({
    id: true,
    createdAt: true,
  })
  .extend({
    poId: z.number().min(1, "PO is required"),
    stockItemId: z.number().min(1, "Stock item is required"),
    itemName: z.string().min(1, "Item name is required"),
    quantity: z.string().min(1, "Quantity is required"),
    rate: z.string().min(1, "Rate is required"),
    lineTotal: z.string().min(1, "Line total is required"),
  });

export type InsertPOLineItem = z.infer<typeof insertPOLineItemSchema>;
export type POLineItem = typeof poLineItems.$inferSelect;

export const containerCharges = pgTable("container_charges", {
  id: serial("id").primaryKey(),
  containerId: integer("container_id")
    .notNull()
    .references(() => containers.id, { onDelete: "cascade" }),
  chargeType: text("charge_type").notNull(),
  amount: decimal("amount", { precision: 20, scale: 2 }).notNull(),
  ledgerAccountId: integer("ledger_account_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertContainerChargeSchema = createInsertSchema(containerCharges)
  .omit({
    id: true,
    createdAt: true,
  })
  .extend({
    containerId: z.number().min(1, "Container is required"),
    chargeType: z.string().min(1, "Charge type is required"),
    amount: z.string().min(1, "Amount is required"),
  });

export type InsertContainerCharge = z.infer<typeof insertContainerChargeSchema>;
export type ContainerCharge = typeof containerCharges.$inferSelect;

export const importLogs = pgTable("import_logs", {
  id: serial("id").primaryKey(),
  fileName: text("file_name").notNull(),
  fileHash: text("file_hash").notNull().unique(),
  rowCount: integer("row_count").notNull(),
  containerId: integer("container_id").references(() => containers.id, { onDelete: "restrict" }),
  status: text("status").notNull(),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertImportLogSchema = createInsertSchema(importLogs)
  .omit({
    id: true,
    createdAt: true,
  })
  .extend({
    fileName: z.string().min(1, "File name is required"),
    fileHash: z.string().min(1, "File hash is required"),
    rowCount: z.number().min(0, "Row count must be non-negative"),
    status: z.enum(["Success", "Failed", "Pending"]),
  });

export type InsertImportLog = z.infer<typeof insertImportLogSchema>;
export type ImportLog = typeof importLogs.$inferSelect;

export const containerOffloads = pgTable("container_offloads", {
  id: serial("id").primaryKey(),
  containerId: integer("container_id")
    .notNull()
    .references(() => containers.id, { onDelete: "restrict" }),
  locationId: integer("location_id")
    .notNull()
    .references(() => locations.id, { onDelete: "restrict" }),
  duties: decimal("duties", { precision: 20, scale: 2 }).notNull().default("0"),
  officeCharges: decimal("office_charges", { precision: 20, scale: 2 }).notNull().default("0"),
  transferCharges: decimal("transfer_charges", { precision: 20, scale: 2 }).notNull().default("0"),
  transportFees: decimal("transport_fees", { precision: 20, scale: 2 }).notNull().default("0"),
  totalCharges: decimal("total_charges", { precision: 20, scale: 2 }).notNull().default("0"),
  totalBales: decimal("total_bales", { precision: 15, scale: 3 }).notNull(),
  additionalCostPerBale: decimal("additional_cost_per_bale", { precision: 20, scale: 2 }).notNull(),
  offloadedAt: timestamp("offloaded_at").notNull().defaultNow(),
  optional: boolean("optional").notNull().default(false),
});

export const insertContainerOffloadSchema = createInsertSchema(containerOffloads)
  .omit({
    id: true,
    offloadedAt: true,
    totalCharges: true,
    totalBales: true,
    additionalCostPerBale: true,
  })
  .extend({
    containerId: z.number().min(1, "Container is required"),
    locationId: z.number().min(1, "Location is required"),
    duties: z
      .string()
      .refine((val) => !isNaN(parseFloat(val)) && parseFloat(val) >= 0, "Duties must be a valid non-negative number"),
    officeCharges: z
      .string()
      .refine(
        (val) => !isNaN(parseFloat(val)) && parseFloat(val) >= 0,
        "Office charges must be a valid non-negative number"
      ),
    transferCharges: z
      .string()
      .refine(
        (val) => !isNaN(parseFloat(val)) && parseFloat(val) >= 0,
        "Transfer charges must be a valid non-negative number"
      ),
    transportFees: z
      .string()
      .refine(
        (val) => !isNaN(parseFloat(val)) && parseFloat(val) >= 0,
        "Transport fees must be a valid non-negative number"
      ),
  });

export const offloadRequestSchema = insertContainerOffloadSchema
  .omit({
    containerId: true,
  })
  .extend({
    offloadDate: z
      .string()
      .min(1, "Offload date is required")
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date format (YYYY-MM-DD required)"),
    dutiesAccountId: z.number().nullable().optional(),
    officeChargesAccountId: z.number().nullable().optional(),
    officeChargesCashAccountId: z.number().nullable().optional(),
    transportAccountId: z.number().nullable().optional(),
    additionalCharges: z
      .array(
        z.object({
          description: z.string().min(1, "Description is required"),
          amount: z.number().min(0, "Amount must be non-negative"),
          ledgerAccountId: z.number().min(1, "Ledger account is required"),
        })
      )
      .optional(),
    inventoryCostCorrections: z
      .array(
        z.object({
          stockItemId: z.number().min(1),
          correctRate: z.number().min(0),
        })
      )
      .optional(),
    agentChargeLines: z
      .array(
        z.object({
          description: z.string().optional(),
          amountUsd: z.number().min(0),
          parentAgentAccountId: z.number().min(1),
        })
      )
      .optional(),
  });

export type InsertContainerOffload = z.infer<typeof insertContainerOffloadSchema>;
export type ContainerOffload = typeof containerOffloads.$inferSelect;
export type OffloadRequest = z.infer<typeof offloadRequestSchema>;

export const containerOffloadItems = pgTable("container_offload_items", {
  id: serial("id").primaryKey(),
  offloadId: integer("offload_id")
    .notNull()
    .references(() => containerOffloads.id, { onDelete: "cascade" }),
  stockItemId: integer("stock_item_id")
    .notNull()
    .references(() => stockItems.id, { onDelete: "restrict" }),
  quantity: decimal("quantity", { precision: 15, scale: 3 }).notNull(),
  rate: decimal("rate", { precision: 20, scale: 2 }).notNull(),
  totalValue: decimal("total_value", { precision: 20, scale: 2 }).notNull(),
});

export type ContainerOffloadItem = typeof containerOffloadItems.$inferSelect;

export const updateContainerTrackingSchema = z.object({
  shopName: z.string().nullable().optional(),
  eta: z.string().nullable().optional(),
  etaSource: z.enum(["manual", "api", "event"]).optional(),
  transporter: z.string().nullable().optional(),
  transportFee: z.string().nullable().optional(),
  numberPlate: z.string().nullable().optional(),
  trackingLocation: z.string().nullable().optional(),
  borderDate: z.string().nullable().optional(),
  offloadDate: z.string().nullable().optional(),
  agent: z.string().nullable().optional(),
  dutyFee: z.string().nullable().optional(),
  docReceived: z.boolean().optional(),
  trackingDescription: z.string().nullable().optional(),
  docsSentDate: z.string().nullable().optional(),
  freightStatus: z.enum(["Yes", "No", "Pending"]).nullable().optional(),
  trackingLink: z.string().nullable().optional(),
  status: z.string().nullable().optional(),
  blDocs: z.string().nullable().optional(),
});

export type UpdateContainerTracking = z.infer<typeof updateContainerTrackingSchema>;

export const containerTrackingImportRowSchema = z.object({
  containerNumber: z.coerce.string(),
  shopName: z.coerce.string().optional(),
  eta: z.coerce.string().optional(),
  transporter: z.coerce.string().optional(),
  transportFee: z.coerce.string().optional(),
  numberPlate: z.coerce.string().optional(),
  trackingLocation: z.coerce.string().optional(),
  borderDate: z.coerce.string().optional(),
  offloadDate: z.coerce.string().optional(),
  agent: z.coerce.string().optional(),
  dutyFee: z.coerce.string().optional(),
  docReceived: z.union([z.boolean(), z.coerce.string()]).optional(),
  trackingDescription: z.coerce.string().optional(),
});

export type ContainerTrackingImportRow = z.infer<typeof containerTrackingImportRowSchema>;

export const containerDocumentTypes = pgTable("container_document_types", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id"),
  code: varchar("code", { length: 50 }).notNull().unique(),
  label: text("label").notNull(),
  isRequired: boolean("is_required").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertContainerDocumentTypeSchema = createInsertSchema(containerDocumentTypes)
  .omit({
    id: true,
    createdAt: true,
  })
  .extend({
    code: z.string().min(1, "Code is required"),
    label: z.string().min(1, "Label is required"),
    isRequired: z.boolean().optional(),
    companyId: z.number().nullable().optional(),
  });

export type InsertContainerDocumentType = z.infer<typeof insertContainerDocumentTypeSchema>;
export type ContainerDocumentType = typeof containerDocumentTypes.$inferSelect;

export const containerDocuments = pgTable(
  "container_documents",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    containerId: integer("container_id")
      .notNull()
      .references(() => containers.id, { onDelete: "cascade" }),
    docTypeId: integer("doc_type_id").notNull(),
    fileName: text("file_name").notNull(),
    storageKey: text("storage_key").notNull(),
    mimeType: varchar("mime_type", { length: 100 }),
    uploadedBy: varchar("uploaded_by"),
    uploadedAt: timestamp("uploaded_at").notNull().defaultNow(),
    fileData: text("file_data"),
  },
  (t) => ({
    companyIdx: index("container_documents_company_idx").on(t.companyId),
    containerIdx: index("container_docs_container_idx").on(t.containerId),
  })
);

export const insertContainerDocumentSchema = createInsertSchema(containerDocuments)
  .omit({
    id: true,
    uploadedAt: true,
  })
  .extend({
    companyId: z.number().min(1),
    containerId: z.number().min(1),
    docTypeId: z.number().min(1),
    fileName: z.string().min(1),
    storageKey: z.string().min(1),
    mimeType: z.string().optional().nullable(),
    uploadedBy: z.string().optional().nullable(),
    fileData: z.string().optional().nullable(),
  });

export type InsertContainerDocument = z.infer<typeof insertContainerDocumentSchema>;
export type ContainerDocument = typeof containerDocuments.$inferSelect;

export const containerFreight = pgTable(
  "container_freight",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    containerId: integer("container_id")
      .notNull()
      .references(() => containers.id, { onDelete: "cascade" }),
    vendorName: text("vendor_name"),
    vendorSupplierId: integer("vendor_supplier_id").references(() => suppliers.id, { onDelete: "restrict" }),
    freightAmount: decimal("freight_amount", { precision: 20, scale: 2 }).notNull().default("0"),
    currency: varchar("currency", { length: 10 }).notNull().default("USD"),
    dueDate: date("due_date"),
    status: text("status").notNull().default("UNPAID"),
    notes: text("notes"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index("container_freight_company_idx").on(t.companyId),
    containerIdx: index("container_freight_container_idx").on(t.containerId),
  })
);

export const insertContainerFreightSchema = createInsertSchema(containerFreight)
  .omit({
    id: true,
    createdAt: true,
    updatedAt: true,
  })
  .extend({
    companyId: z.number().min(1),
    containerId: z.number().min(1),
    vendorName: z.string().optional().nullable(),
    vendorSupplierId: z.number().optional().nullable(),
    freightAmount: z.string().min(1, "Freight amount is required"),
    currency: z.string().optional(),
    dueDate: z.string().optional().nullable(),
    status: z.string().optional(),
    notes: z.string().optional().nullable(),
  });

export type InsertContainerFreight = z.infer<typeof insertContainerFreightSchema>;
export type ContainerFreight = typeof containerFreight.$inferSelect;

export const containerFreightPayments = pgTable(
  "container_freight_payments",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    containerFreightId: integer("container_freight_id").notNull(),
    containerId: integer("container_id").references(() => containers.id, { onDelete: "restrict" }),
    paymentDate: date("payment_date").notNull(),
    amount: decimal("amount", { precision: 20, scale: 2 }).notNull(),
    method: varchar("method", { length: 50 }),
    reference: text("reference"),
    // users.id is a varchar, and startup migration 002 converts this column to
    // character varying. Declaring it as integer made `drizzle-kit push` fail
    // against any database where that migration had already run.
    createdBy: varchar("created_by"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index("container_freight_payments_company_idx").on(t.companyId),
    freightIdx: index("freight_payments_freight_idx").on(t.containerFreightId),
  })
);

export const insertContainerFreightPaymentSchema = createInsertSchema(containerFreightPayments)
  .omit({
    id: true,
    createdAt: true,
  })
  .extend({
    companyId: z.number().min(1),
    containerFreightId: z.number().min(1),
    paymentDate: z.string().min(1, "Payment date is required"),
    amount: z.string().min(1, "Amount is required"),
    method: z.string().optional().nullable(),
    reference: z.string().optional().nullable(),
    createdBy: z.string().optional().nullable(),
  });

export type InsertContainerFreightPayment = z.infer<typeof insertContainerFreightPaymentSchema>;
export type ContainerFreightPayment = typeof containerFreightPayments.$inferSelect;
