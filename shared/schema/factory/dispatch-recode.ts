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
  index,
  uniqueIndex,
  jsonb,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { customers } from "../erp";
import { customerProformas } from "./customer-orders";
import { isNonNegativeNumeric } from "../../numericString";

// ─── Customer Dispatch Batch Sequences ───────────────────────────────────────
export const customerDispatchBatchSequences = pgTable("customer_dispatch_batch_sequences", {
  companyId: integer("company_id").primaryKey(),
  nextNumber: integer("next_number").notNull().default(1),
});

// ─── Customer Dispatch Batches ────────────────────────────────────────────────
export const customerDispatchBatches = pgTable(
  "customer_dispatch_batches",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    customerId: integer("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "restrict" }),
    proformaId: integer("proforma_id").references(() => customerProformas.id, { onDelete: "restrict" }),
    batchNumber: varchar("batch_number", { length: 50 }).notNull(),
    batchDate: date("batch_date").notNull(),
    status: text("status").notNull().default("DRAFT"),
    currency: varchar("currency", { length: 3 }).notNull().default("USD"),
    priceMode: text("price_mode").notNull().default("PER_BALE"),
    destination: text("destination"),
    notes: text("notes"),
    finalOrderId: integer("final_order_id"),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
    cancelledAt: timestamp("cancelled_at"),
  },
  (t) => ({
    companyIdx: index("cdb_company_idx").on(t.companyId),
    customerIdx: index("cdb_customer_idx").on(t.customerId),
    statusIdx: index("cdb_status_idx").on(t.status),
  })
);

export const insertCustomerDispatchBatchSchema = createInsertSchema(customerDispatchBatches)
  .omit({
    id: true,
    createdAt: true,
    updatedAt: true,
    cancelledAt: true,
  })
  .extend({
    companyId: z.number().min(1),
    customerId: z.number().min(1),
    proformaId: z.number().optional().nullable(),
    batchDate: z.string().min(1),
    status: z.enum(["DRAFT", "LOADING", "READY_TO_INVOICE", "INVOICED", "CANCELLED"]).optional(),
    currency: z.string().optional(),
    priceMode: z.enum(["PER_BALE", "PER_KG"]).optional(),
    destination: z.string().optional().nullable(),
    notes: z.string().optional().nullable(),
    createdBy: z.string().optional().nullable(),
  });
export type InsertCustomerDispatchBatch = z.infer<typeof insertCustomerDispatchBatchSchema>;
export type CustomerDispatchBatch = typeof customerDispatchBatches.$inferSelect;

// ─── Customer Dispatch Truck Rides ────────────────────────────────────────────
export const customerDispatchTruckRides = pgTable(
  "customer_dispatch_truck_rides",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    batchId: integer("batch_id")
      .notNull()
      .references(() => customerDispatchBatches.id, { onDelete: "restrict" }),
    rideNumber: integer("ride_number").notNull(),
    truckPlate: varchar("truck_plate", { length: 50 }),
    driverName: text("driver_name"),
    destination: text("destination"),
    notes: text("notes"),
    status: text("status").notNull().default("DRAFT"),
    loadedAt: timestamp("loaded_at"),
    dispatchedAt: timestamp("dispatched_at"),
    reopenedAt: timestamp("reopened_at"),
    reopenReason: text("reopen_reason"),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    batchIdx: index("cdtr_batch_idx").on(t.batchId),
    companyIdx: index("cdtr_company_idx").on(t.companyId),
  })
);

export const insertCustomerDispatchTruckRideSchema = createInsertSchema(customerDispatchTruckRides)
  .omit({
    id: true,
    createdAt: true,
    updatedAt: true,
    loadedAt: true,
    dispatchedAt: true,
    reopenedAt: true,
  })
  .extend({
    companyId: z.number().min(1),
    batchId: z.number().min(1),
    rideNumber: z.number().int().min(1),
    truckPlate: z.string().optional().nullable(),
    driverName: z.string().optional().nullable(),
    destination: z.string().optional().nullable(),
    notes: z.string().optional().nullable(),
    createdBy: z.string().optional().nullable(),
  });
export type InsertCustomerDispatchTruckRide = z.infer<typeof insertCustomerDispatchTruckRideSchema>;
export type CustomerDispatchTruckRide = typeof customerDispatchTruckRides.$inferSelect;

// ─── Customer Dispatch Bale Scans ─────────────────────────────────────────────
export const customerDispatchBaleScans = pgTable(
  "customer_dispatch_bale_scans",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    batchId: integer("batch_id").notNull(),
    truckRideId: integer("truck_ride_id").notNull(),
    baleId: integer("bale_id").notNull(),
    baleReference: varchar("bale_reference", { length: 100 }).notNull(),
    articleCode: varchar("article_code", { length: 50 }),
    productName: text("product_name"),
    weightKg: decimal("weight_kg", { precision: 15, scale: 3 }).notNull().default("0"),
    priceUsed: decimal("price_used", { precision: 20, scale: 2 }).notNull().default("0"),
    amount: decimal("amount", { precision: 20, scale: 2 }).notNull().default("0"),
    scannedBy: text("scanned_by"),
    scannedAt: timestamp("scanned_at").notNull().defaultNow(),
    removedAt: timestamp("removed_at"),
    removalReason: text("removal_reason"),
  },
  (t) => ({
    batchIdx: index("cdbs_batch_idx").on(t.batchId),
    rideIdx: index("cdbs_ride_idx").on(t.truckRideId),
    baleIdx: index("cdbs_bale_idx").on(t.baleId),
  })
);

export type CustomerDispatchBaleScan = typeof customerDispatchBaleScans.$inferSelect;

// ─── Bale Recode Sessions ─────────────────────────────────────────────────────
export const baleRecodeSessions = pgTable(
  "bale_recode_sessions",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    performedBy: varchar("performed_by", { length: 255 }),
    uploadedFilename: text("uploaded_filename"),
    printFormat: text("print_format").notNull().default("A4"),
    designColor: text("design_color"),
    totalRows: integer("total_rows").notNull().default(0),
    validRows: integer("valid_rows").notNull().default(0),
    invalidRows: integer("invalid_rows").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index("bale_recode_sessions_company_idx").on(t.companyId),
  })
);

export const insertBaleRecodeSessionSchema = createInsertSchema(baleRecodeSessions)
  .omit({
    id: true,
    createdAt: true,
  })
  .extend({
    companyId: z.number().min(1),
  });

export type InsertBaleRecodeSession = z.infer<typeof insertBaleRecodeSessionSchema>;
export type BaleRecodeSession = typeof baleRecodeSessions.$inferSelect;

// ─── Bale Recode Items ────────────────────────────────────────────────────────
export const baleRecodeItems = pgTable("bale_recode_items", {
  id: serial("id").primaryKey(),
  sessionId: integer("session_id")
    .notNull()
    .references(() => baleRecodeSessions.id, { onDelete: "cascade" }),
  oldReferenceCode: text("old_reference_code").notNull(),
  newReferenceCode: text("new_reference_code"),
  productName: text("product_name"),
  articleCode: text("article_code"),
  weightKg: text("weight_kg"),
  status: text("status").notNull().default("SUCCESS"),
  errorMessage: text("error_message"),
});

export const insertBaleRecodeItemSchema = createInsertSchema(baleRecodeItems)
  .omit({
    id: true,
  })
  .extend({
    sessionId: z.number().min(1),
    oldReferenceCode: z.string().min(1),
  });

export type InsertBaleRecodeItem = z.infer<typeof insertBaleRecodeItemSchema>;
export type BaleRecodeItem = typeof baleRecodeItems.$inferSelect;

// ─── Insurance Members ────────────────────────────────────────────────────────
export const insuranceMembers = pgTable("insurance_members", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull(),
  name: text("name").notNull(),
  nationality: text("nationality"),
  positionWorking: text("position_working"),
  insuranceNumber: text("insurance_number"),
  startDate: date("start_date").notNull(),
  amount: decimal("amount", { precision: 15, scale: 2 }).notNull(),
  dob: date("dob"),
  notes: text("notes"),
  active: boolean("active").notNull().default(true),
  ledgerAccountId: integer("ledger_account_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertInsuranceMemberSchema = createInsertSchema(insuranceMembers)
  .omit({ id: true, createdAt: true, ledgerAccountId: true })
  .extend({
    companyId: z.number().min(1, "Company is required"),
    name: z.string().min(1, "Name is required"),
    startDate: z.string().min(1, "Start date is required"),
    amount: z.string().refine(isNonNegativeNumeric, "Amount must be a non-negative number"),
    nationality: z.string().optional().nullable(),
    positionWorking: z.string().optional().nullable(),
    insuranceNumber: z.string().optional().nullable(),
    dob: z.string().optional().nullable(),
    notes: z.string().optional().nullable(),
    active: z.boolean().optional(),
  });

export type InsertInsuranceMember = z.infer<typeof insertInsuranceMemberSchema>;
export type InsuranceMember = typeof insuranceMembers.$inferSelect;

export const insuranceMemberMonthlyAmounts = pgTable(
  "insurance_member_monthly_amounts",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    memberId: integer("member_id")
      .notNull()
      .references(() => insuranceMembers.id, { onDelete: "cascade" }),
    monthStart: date("month_start").notNull(),
    amount: decimal("amount", { precision: 15, scale: 2 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    companyMonthIdx: index("insurance_member_monthly_amounts_company_month_idx").on(t.companyId, t.monthStart),
    memberMonthUnique: uniqueIndex("insurance_member_monthly_amounts_member_month_unique").on(
      t.companyId,
      t.memberId,
      t.monthStart
    ),
  })
);

export type InsuranceMemberMonthlyAmount = typeof insuranceMemberMonthlyAmounts.$inferSelect;

// ─── Factory Container Receipts ───────────────────────────────────────────────
// Records each individual partial-receipt event for a container.
// factory_raw_stock keeps one cumulative row per container (receivedKg is the
// running total). This table is the per-receipt audit log with the immutable
// fixed-rate snapshot established at first offload time.
export const factoryContainerReceipts = pgTable(
  "factory_container_receipts",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    containerId: integer("container_id").notNull(),
    receiptDate: date("receipt_date").notNull(),
    /** Kg received in THIS receipt event (incremental, not cumulative). */
    receivedKg: decimal("received_kg", { precision: 15, scale: 3 }).notNull(),
    /** Running total of kg received across ALL receipts up to and including this one. */
    cumulativeReceivedKg: decimal("cumulative_received_kg", { precision: 15, scale: 3 }).notNull(),
    /** Fixed landed cost/kg in container native currency — established at first offload, never changes. */
    fixedCostPerKg: decimal("fixed_cost_per_kg", { precision: 20, scale: 6 }),
    /** Fixed landed cost/kg in USD. */
    fixedCostPerKgUsd: decimal("fixed_cost_per_kg_usd", { precision: 20, scale: 6 }),
    /** Value of this receipt in container native currency (receivedKg × fixedCostPerKg). */
    receiptValue: decimal("receipt_value", { precision: 20, scale: 6 }),
    /** Value of this receipt in USD. */
    receiptValueUsd: decimal("receipt_value_usd", { precision: 20, scale: 6 }),
    currencyCode: varchar("currency_code", { length: 3 }),
    fxRateToUsd: decimal("fx_rate_to_usd", { precision: 20, scale: 8 }),
    createdBy: varchar("created_by", { length: 255 }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    deletedAt: timestamp("deleted_at"),
    /** Caller-supplied idempotency key — resubmitting with the same key returns without re-applying. */
    idempotencyKey: varchar("idempotency_key", { length: 100 }),
  },
  (t) => ({
    containerIdx: index("factory_container_receipts_container_idx").on(t.companyId, t.containerId),
    dateIdx: index("factory_container_receipts_date_idx").on(t.companyId, t.receiptDate),
  })
);

export type FactoryContainerReceipt = typeof factoryContainerReceipts.$inferSelect;

// ─── Factory Contacts ─────────────────────────────────────────────────────────
export const factoryContacts = pgTable(
  "factory_contacts",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    name: text("name").notNull(),
    role: text("role"),
    numbers: jsonb("numbers").notNull().default([]),
    notes: text("notes"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    byCompany: index("factory_contacts_company_idx").on(t.companyId),
  })
);

export const insertFactoryContactSchema = createInsertSchema(factoryContacts)
  .omit({
    id: true,
    createdAt: true,
    updatedAt: true,
  })
  .extend({
    name: z.string().min(1, "Name is required"),
    numbers: z.array(z.object({ label: z.string(), number: z.string() })).default([]),
  });
export type InsertFactoryContact = z.infer<typeof insertFactoryContactSchema>;
export type FactoryContact = typeof factoryContacts.$inferSelect;
