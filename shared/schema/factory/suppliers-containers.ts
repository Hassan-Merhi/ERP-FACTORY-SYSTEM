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
import { vouchers } from "../erp";

// ─── Factory Supplier Categories ──────────────────────────────────────────────
export const factorySupplierCategories = pgTable(
  "factory_supplier_categories",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    name: varchar("name", { length: 200 }).notNull(),
    displayOrder: integer("display_order").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    uniqueCompanyName: uniqueIndex("factory_supplier_categories_company_name_unique").on(t.companyId, t.name),
  })
);

export const insertFactorySupplierCategorySchema = createInsertSchema(factorySupplierCategories)
  .omit({
    id: true,
    createdAt: true,
    updatedAt: true,
  })
  .extend({
    companyId: z.number().min(1, "Company is required"),
    name: z.string().min(1, "Category name is required"),
    displayOrder: z.number().optional(),
  });

export type InsertFactorySupplierCategory = z.infer<typeof insertFactorySupplierCategorySchema>;
export type FactorySupplierCategory = typeof factorySupplierCategories.$inferSelect;

// ─── Factory Suppliers ────────────────────────────────────────────────────────
export const factorySuppliers = pgTable(
  "factory_suppliers",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    name: varchar("name", { length: 200 }).notNull(),
    contactPerson: text("contact_person"),
    phone: varchar("phone", { length: 50 }),
    email: varchar("email", { length: 200 }),
    address: text("address"),
    notes: text("notes"),
    openingBalance: decimal("opening_balance", { precision: 20, scale: 4 }).notNull().default("0"),
    linkedSupplierId: integer("linked_supplier_id"),
    parentId: integer("parent_id"),
    supplierCategoryId: integer("supplier_category_id"),
    isActive: boolean("is_active").notNull().default(true),
    isBroker: boolean("is_broker").notNull().default(false),
    // Authoritative, persisted locked raw-material cost/kg (USD) for this supplier.
    // Must only change when a new container is offloaded for this supplier (moving
    // average using pre-offload remaining kg) or an explicit landed-cost correction —
    // never from mix batches, adjustments, or any other quantity-only movement.
    // Null means "not yet established" (no offload/OB/ADD has ever set it).
    currentRawMaterialCostPerKgUsd: decimal("current_raw_material_cost_per_kg_usd", { precision: 20, scale: 8 }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    uniqueCompanyName: uniqueIndex("factory_suppliers_company_name_unique").on(t.companyId, t.name),
  })
);

export const insertFactorySupplierSchema = createInsertSchema(factorySuppliers)
  .omit({
    id: true,
    createdAt: true,
    updatedAt: true,
  })
  .extend({
    companyId: z.number().min(1, "Company is required"),
    name: z.string().min(1, "Supplier name is required"),
    contactPerson: z.string().optional().nullable(),
    phone: z.string().optional().nullable(),
    email: z.string().optional().nullable(),
    address: z.string().optional().nullable(),
    notes: z.string().optional().nullable(),
    openingBalance: z.string().optional(),
    linkedSupplierId: z.number().optional().nullable(),
    parentId: z.number().optional().nullable(),
    supplierCategoryId: z.number().optional().nullable(),
    isActive: z.boolean().optional(),
    isBroker: z.boolean().optional(),
  });

export type InsertFactorySupplier = z.infer<typeof insertFactorySupplierSchema>;
export type FactorySupplier = typeof factorySuppliers.$inferSelect;

// ─── Factory Categories ───────────────────────────────────────────────────────
export const factoryCategories = pgTable(
  "factory_categories",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    name: varchar("name", { length: 100 }).notNull(),
    isActive: boolean("is_active").notNull().default(true),
    deletedAt: timestamp("deleted_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    uniqueCompanyName: uniqueIndex("factory_categories_company_name_unique").on(t.companyId, t.name),
  })
);

export const insertFactoryCategorySchema = createInsertSchema(factoryCategories)
  .omit({
    id: true,
    createdAt: true,
    updatedAt: true,
    deletedAt: true,
  })
  .extend({
    companyId: z.number().min(1, "Company is required"),
    name: z.string().min(1, "Category name is required"),
    isActive: z.boolean().optional(),
  });

export type InsertFactoryCategory = z.infer<typeof insertFactoryCategorySchema>;
export type FactoryCategory = typeof factoryCategories.$inferSelect;

// ─── Factory Bale Products ────────────────────────────────────────────────────
export const factoryBaleProducts = pgTable(
  "factory_bale_products",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    code: varchar("code", { length: 50 }).notNull(),
    articleCode: varchar("article_code", { length: 50 }),
    name: text("name").notNull(),
    description: text("description"),
    weightPerBaleKg: decimal("weight_per_bale_kg", { precision: 10, scale: 2 }),
    categoryId: integer("category_id"),
    sellingPrice: decimal("selling_price", { precision: 20, scale: 2 }).default("0"),
    productionPrice: decimal("production_price", { precision: 20, scale: 2 }).default("0"),
    labelDesignColor: varchar("label_design_color", { length: 20 }),
    active: boolean("active").notNull().default(true),
    deletedAt: timestamp("deleted_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    uniqueCompanyCode: uniqueIndex("factory_bale_products_company_code_unique").on(t.companyId, t.code),
    uniqueCompanyArticleCode: uniqueIndex("factory_bale_products_company_article_code_unique").on(
      t.companyId,
      t.articleCode
    ),
  })
);

export const insertFactoryBaleProductSchema = createInsertSchema(factoryBaleProducts)
  .omit({
    id: true,
    createdAt: true,
    updatedAt: true,
    deletedAt: true,
  })
  .extend({
    companyId: z.number().min(1, "Company is required"),
    code: z.string().optional(),
    articleCode: z.string().optional().nullable(),
    name: z.string().min(1, "Product name is required"),
    description: z.string().optional().nullable(),
    weightPerBaleKg: z.string().optional().nullable(),
    sellingPrice: z.string().optional().nullable(),
    productionPrice: z.string().optional().nullable(),
    categoryId: z.number().optional().nullable(),
    labelDesignColor: z.string().optional().nullable(),
    active: z.boolean().optional(),
  });

export type InsertFactoryBaleProduct = z.infer<typeof insertFactoryBaleProductSchema>;
export type FactoryBaleProduct = typeof factoryBaleProducts.$inferSelect;

// ─── Factory Containers ───────────────────────────────────────────────────────
export const factoryContainers = pgTable(
  "factory_containers",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    containerNumber: varchar("container_number", { length: 100 }).notNull(),
    supplierId: integer("supplier_id").references(() => factorySuppliers.id, { onDelete: "restrict" }),
    origin: text("origin"),
    totalKg: decimal("total_kg", { precision: 15, scale: 3 }),
    ratePerKg: decimal("rate_per_kg", { precision: 20, scale: 6 }),
    declaredKg: decimal("declared_kg", { precision: 15, scale: 3 }),
    actualReceivedKg: decimal("actual_received_kg", { precision: 15, scale: 3 }),
    finalPayableAmount: decimal("final_payable_amount", { precision: 20, scale: 4 }),
    differenceKg: decimal("difference_kg", { precision: 15, scale: 3 }),
    currencyCode: varchar("currency_code", { length: 10 }).notNull().default("USD"),
    fxRateToUsd: decimal("fx_rate_to_usd", { precision: 20, scale: 8 }).notNull().default("1"),
    fxRateToUsdImport: decimal("fx_rate_to_usd_import", { precision: 20, scale: 8 }),
    fxRateToUsdOffload: decimal("fx_rate_to_usd_offload", { precision: 20, scale: 8 }),
    fxRateSource: text("fx_rate_source").notNull().default("auto"),
    // Explicit "was this rate ever actually resolved" flag — independent of the
    // numeric value, since the column above defaults to '1' and a genuine 1:1
    // confirmed rate must remain valid. USD rows are trivially resolved; non-USD
    // rows are only resolved once a real auto-fetch or manual entry sets this true.
    // Historical rows predating this column default to false (NOT a claim they were
    // wrong — see migration note) so diagnostics can flag them for manual review
    // without silently trusting or silently rejecting old data.
    fxRateConfirmed: boolean("fx_rate_confirmed").notNull().default(false),
    fxRateDateImport: date("fx_rate_date_import"),
    fxRateDateOffload: date("fx_rate_date_offload"),
    ratePerKgUsd: decimal("rate_per_kg_usd", { precision: 20, scale: 6 }),
    finalPayableAmountUsd: decimal("final_payable_amount_usd", { precision: 20, scale: 4 }),
    arrivalDate: date("arrival_date"),
    destination: text("destination"),
    notes: text("notes"),
    status: text("status").notNull().default("PENDING"),
    freight: decimal("freight", { precision: 20, scale: 2 }).default("0"),
    freightCurrencyCode: varchar("freight_currency_code", { length: 10 }).default("USD"),
    freightAccountId: integer("freight_account_id"),
    freightSupplierId: integer("freight_supplier_id"),
    freightPaidBy: text("freight_paid_by").default("supplier"),
    freightOwnAccountId: integer("freight_own_account_id"),
    // Freight-specific FX rate — may differ from the container's FX rate when
    // freight is denominated in a third currency (neither USD nor the container CCY).
    freightFxRateToUsd: decimal("freight_fx_rate_to_usd", { precision: 20, scale: 8 }),
    freightFxRateConfirmed: boolean("freight_fx_rate_confirmed").notNull().default(false),
    freightFxRateDate: date("freight_fx_rate_date"),
    otherCharges: decimal("other_charges", { precision: 20, scale: 2 }).default("0"),
    otherChargesCurrencyCode: varchar("other_charges_currency_code", { length: 10 }),
    otherChargesAccountId: integer("other_charges_account_id"),
    otherChargesSupplierId: integer("other_charges_supplier_id"),
    commissionAmount: decimal("commission_amount", { precision: 20, scale: 2 }).default("0"),
    commissionCurrencyCode: varchar("commission_currency_code", { length: 10 }).default("USD"),
    commissionAccountId: integer("commission_account_id"),
    commissionSupplierId: integer("commission_supplier_id"),
    commissionNotes: text("commission_notes"),
    // Commission-specific FX rate — the commission may be denominated in a currency
    // different from both USD and the container's own currency (e.g. AUD container with
    // EUR commission). Using the container's fxRateToUsd for such a commission produces
    // a wrong commissionTotalUsd. These three columns persist the resolved commission-
    // specific rate so computeCorrectContainerCost always uses the right rate.
    commissionFxRateToUsd: decimal("commission_fx_rate_to_usd", { precision: 20, scale: 8 }),
    commissionFxRateConfirmed: boolean("commission_fx_rate_confirmed").notNull().default(false),
    commissionFxRateDate: date("commission_fx_rate_date"),
    dutyAmount: decimal("duty_amount", { precision: 20, scale: 2 }),
    dutyAccountId: integer("duty_account_id"),
    dutyStatus: text("duty_status").notNull().default("NONE"),
    dutyNotes: text("duty_notes"),
    preOffloadFreight: decimal("pre_offload_freight", { precision: 20, scale: 2 }),
    preOffloadFreightCurrencyCode: varchar("pre_offload_freight_currency_code", { length: 10 }),
    preOffloadFreightAccountId: integer("pre_offload_freight_account_id"),
    preOffloadFreightSupplierId: integer("pre_offload_freight_supplier_id"),
    preOffloadOtherCharges: decimal("pre_offload_other_charges", { precision: 20, scale: 2 }),
    preOffloadOtherChargesAccountId: integer("pre_offload_other_charges_account_id"),
    preOffloadOtherChargesSupplierId: integer("pre_offload_other_charges_supplier_id"),
    preOffloadStatus: text("pre_offload_status"),
    preOffloadCommissionAmount: decimal("pre_offload_commission_amount", { precision: 20, scale: 2 }),
    preOffloadCommissionCurrencyCode: varchar("pre_offload_commission_currency_code", { length: 10 }),
    preOffloadCommissionAccountId: integer("pre_offload_commission_account_id"),
    preOffloadCommissionSupplierId: integer("pre_offload_commission_supplier_id"),
    preOffloadCommissionNotes: text("pre_offload_commission_notes"),
    deletedAt: timestamp("deleted_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
    trackingEnabled: boolean("tracking_enabled").notNull().default(false),
    trackingAutoUpdate: boolean("tracking_auto_update").notNull().default(false),
    trackingCarrierHint: text("tracking_carrier_hint"),
    trackingProvider: text("tracking_provider"),
    trackingLastStatus: text("tracking_last_status"),
    trackingLastLocation: text("tracking_last_location"),
    trackingLastCheckedAt: timestamp("tracking_last_checked_at", { withTimezone: true }),
    trackingLastEventDate: timestamp("tracking_last_event_date", { withTimezone: true }),
    trackingLastDescription: text("tracking_last_description"),
    trackingError: text("tracking_error"),
    trackingChangedAt: timestamp("tracking_changed_at", { withTimezone: true }),
    trackingDetectedCarrier: text("tracking_detected_carrier"),
    trackingNextCheckAt: timestamp("tracking_next_check_at", { withTimezone: true }),
    trackingLastSkipReason: text("tracking_last_skip_reason"),
    jsonCargoLastCheckedAt: timestamp("json_cargo_last_checked_at", { withTimezone: true }),
    jsonCargoTrackingStatus: text("json_cargo_tracking_status"),
    jsonCargoError: text("json_cargo_error"),
    // OTW shared state — stored server-side so all users see the same values
    otwNote: text("otw_note"),
    otwDocsReceived: boolean("otw_docs_received").notNull().default(false),
  },
  (t) => ({
    companyIdx: index("factory_containers_company_idx").on(t.companyId),
  })
);

export const insertFactoryContainerSchema = createInsertSchema(factoryContainers)
  .omit({
    id: true,
    createdAt: true,
    updatedAt: true,
    deletedAt: true,
  })
  .extend({
    companyId: z.number().min(1, "Company is required"),
    containerNumber: z.string().min(1, "Container number is required"),
    supplierId: z.number().optional().nullable(),
    origin: z.string().optional().nullable(),
    totalKg: z.string().optional().nullable(),
    ratePerKg: z.string().optional().nullable(),
    currencyCode: z.string().optional(),
    fxRateToUsd: z.string().optional(),
    fxRateConfirmed: z.boolean().optional(),
    fxRateToUsdImport: z.string().optional().nullable(),
    fxRateToUsdOffload: z.string().optional().nullable(),
    fxRateSource: z.string().optional(),
    fxRateDateImport: z.string().optional().nullable(),
    fxRateDateOffload: z.string().optional().nullable(),
    ratePerKgUsd: z.string().optional().nullable(),
    finalPayableAmountUsd: z.string().optional().nullable(),
    arrivalDate: z.string().optional().nullable(),
    notes: z.string().optional().nullable(),
    status: z.string().optional(),
    freight: z.string().optional().nullable(),
    freightCurrencyCode: z.string().optional().nullable(),
    freightAccountId: z.number().optional().nullable(),
    otherCharges: z.string().optional().nullable(),
    otherChargesAccountId: z.number().optional().nullable(),
    commissionAmount: z.string().optional().nullable(),
    commissionCurrencyCode: z.string().optional().nullable(),
    commissionAccountId: z.number().optional().nullable(),
    commissionSupplierId: z.number().optional().nullable(),
    commissionNotes: z.string().optional().nullable(),
    dutyAmount: z.string().optional().nullable(),
    dutyAccountId: z.number().optional().nullable(),
    dutyStatus: z.enum(["NONE", "PENDING", "CONFIRMED"]).optional(),
    dutyNotes: z.string().optional().nullable(),
  });

export type InsertFactoryContainer = z.infer<typeof insertFactoryContainerSchema>;
export type FactoryContainer = typeof factoryContainers.$inferSelect;

// ─── Factory Container Tracking Events ───────────────────────────────────────
export const factoryContainerTrackingEvents = pgTable(
  "factory_container_tracking_events",
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
    dedupUnique: uniqueIndex("fcte_dedup_unique").on(t.containerId, t.eventTime, t.eventStatus),
  })
);

export type FactoryContainerTrackingEvent = typeof factoryContainerTrackingEvents.$inferSelect;

// ─── Factory Container Tracking Checks ───────────────────────────────────────
export const factoryContainerTrackingChecks = pgTable("factory_container_tracking_checks", {
  id: serial("id").primaryKey(),
  containerId: integer("container_id").notNull(),
  provider: text("provider").notNull().default("parcelsapp"),
  status: text("status").notNull(),
  checkedAt: timestamp("checked_at").notNull(),
  errorMessage: text("error_message"),
  rawResponseJson: jsonb("raw_response_json"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type FactoryContainerTrackingCheck = typeof factoryContainerTrackingChecks.$inferSelect;

// ─── Factory Offload Additional Charges ──────────────────────────────────────
export const factoryOffloadAdditionalCharges = pgTable(
  "factory_offload_additional_charges",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    containerId: integer("container_id")
      .notNull()
      .references(() => factoryContainers.id, { onDelete: "cascade" }),
    description: text("description").notNull(),
    amount: decimal("amount", { precision: 20, scale: 2 }).notNull(),
    currencyCode: text("currency_code").default("USD"),
    fxRateToUsd: decimal("fx_rate_to_usd", { precision: 20, scale: 6 }).default("1"),
    fxRateConfirmed: boolean("fx_rate_confirmed").notNull().default(false),
    fxRateDate: date("fx_rate_date"),
    ledgerAccountId: integer("ledger_account_id"),
    supplierId: integer("supplier_id").references(() => factorySuppliers.id, { onDelete: "restrict" }),
    // Accounting links — set on creation, used for edit/undo
    voucherId: integer("voucher_id").references(() => vouchers.id, { onDelete: "set null" }),
    daybookEntryId: integer("daybook_entry_id"),
    reversalDaybookEntryId: integer("reversal_daybook_entry_id"),
    // Supplier-rate snapshots — saved on each create/edit so edit/undo can reason exactly
    supplierLockedRateBefore: decimal("supplier_locked_rate_before", { precision: 20, scale: 8 }),
    supplierLockedRateAfter: decimal("supplier_locked_rate_after", { precision: 20, scale: 8 }),
    supplierRemainingKgAtApply: decimal("supplier_remaining_kg_at_apply", { precision: 20, scale: 3 }),
    fullContainerValueDeltaUsd: decimal("full_container_value_delta_usd", { precision: 20, scale: 6 }),
    supplierInventoryValueDeltaUsd: decimal("supplier_inventory_value_delta_usd", { precision: 20, scale: 6 }),
    remainingFractionAtApply: decimal("remaining_fraction_at_apply", { precision: 20, scale: 8 }),
    // Audit / lifecycle
    createdByUserId: text("created_by_user_id"),
    updatedByUserId: text("updated_by_user_id"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
    deletedAt: timestamp("deleted_at"),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    companyIdx: index("factory_offload_additional_charges_company_idx").on(t.companyId),
    containerIdx: index("factory_offload_addl_charges_container_idx").on(t.containerId),
    companyContainerDelIdx: index("factory_offload_addl_charges_co_ctr_del_idx").on(
      t.companyId,
      t.containerId,
      t.deletedAt
    ),
  })
);

export type FactoryOffloadAdditionalCharge = typeof factoryOffloadAdditionalCharges.$inferSelect;

// ─── Factory Container Other Charges ─────────────────────────────────────────
export const factoryContainerOtherCharges = pgTable(
  "factory_container_other_charges",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    containerId: integer("container_id")
      .notNull()
      .references(() => factoryContainers.id, { onDelete: "cascade" }),
    description: text("description").notNull(),
    amount: decimal("amount", { precision: 20, scale: 2 }).notNull(),
    currencyCode: text("currency_code").default("USD"),
    // Per-line FX rate — each charge may be in a different currency.
    fxRateToUsd: decimal("fx_rate_to_usd", { precision: 20, scale: 8 }).default("1"),
    fxRateConfirmed: boolean("fx_rate_confirmed").notNull().default(false),
    fxRateDate: date("fx_rate_date"),
    ledgerAccountId: integer("ledger_account_id"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index("factory_container_other_charges_company_idx").on(t.companyId),
    containerIdx: index("factory_container_other_charges_container_idx").on(t.containerId),
  })
);

export type FactoryContainerOtherCharge = typeof factoryContainerOtherCharges.$inferSelect;
