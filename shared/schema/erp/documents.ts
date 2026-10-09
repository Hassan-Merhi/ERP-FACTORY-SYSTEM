import {
  pgTable,
  text,
  varchar,
  serial,
  integer,
  decimal,
  boolean,
  timestamp,
  uniqueIndex,
  index,
  jsonb,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { companies } from "../common";
import { suppliers } from "./parties";
import { customers } from "./vouchers";
import { isPositiveNumeric } from "../../numericString";

export const referenceSequences = pgTable(
  "reference_sequences",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id")
      .notNull()
      .references(() => companies.id),
    nextNumber: integer("next_number").notNull().default(1),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    uniqueCompanyId: uniqueIndex("reference_sequences_company_unique").on(t.companyId),
  })
);

export type ReferenceSequence = typeof referenceSequences.$inferSelect;

export const baleLabelPrints = pgTable(
  "bale_label_prints",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    productionBaleId: integer("production_bale_id"),
    productId: integer("product_id"),
    articleCode: varchar("article_code", { length: 50 }).notNull(),
    referenceNumber: varchar("reference_number", { length: 100 }).notNull(),
    pieces: integer("pieces").notNull().default(1),
    approxWeightKg: decimal("approx_weight_kg", { precision: 15, scale: 3 }).notNull(),
    printedByUserId: varchar("printed_by_user_id"),
    printedAt: timestamp("printed_at").notNull().defaultNow(),
    scannedByUserId: varchar("scanned_by_user_id"),
    scannedAt: timestamp("scanned_at"),
    customerLogoId: integer("customer_logo_id"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    uniqueReference: uniqueIndex("bale_label_prints_reference_unique").on(t.companyId, t.referenceNumber),
  })
);

export const insertBaleLabelPrintSchema = createInsertSchema(baleLabelPrints)
  .omit({
    id: true,
    createdAt: true,
  })
  .extend({
    companyId: z.number().min(1, "Company is required"),
    productionBaleId: z.number().optional(),
    productId: z.number().optional(),
    articleCode: z.string().min(1, "Article code is required"),
    referenceNumber: z.string().min(1, "Reference number is required"),
    pieces: z.number().min(1, "Pieces must be at least 1"),
    approxWeightKg: z.string().refine(isPositiveNumeric, "Weight must be positive"),
    printedByUserId: z.string().optional(),
    printedAt: z.date().optional(),
    scannedByUserId: z.string().optional(),
    scannedAt: z.date().optional(),
    customerLogoId: z.number().optional(),
  });

export type InsertBaleLabelPrint = z.infer<typeof insertBaleLabelPrintSchema>;
export type BaleLabelPrint = typeof baleLabelPrints.$inferSelect;

export const customerLogos = pgTable(
  "customer_logos",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    customerId: integer("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 100 }).notNull(),
    filePath: varchar("file_path", { length: 500 }).notNull(),
    mimeType: varchar("mime_type", { length: 50 }).notNull(),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index("customer_logos_company_idx").on(t.companyId),
  })
);

export const insertCustomerLogoSchema = createInsertSchema(customerLogos).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertCustomerLogo = z.infer<typeof insertCustomerLogoSchema>;
export type CustomerLogo = typeof customerLogos.$inferSelect;

export const erpUserPageAccess = pgTable(
  "erp_user_page_access",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    userId: varchar("user_id").notNull(),
    pageKey: text("page_key").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    uniqueCompanyUserPage: uniqueIndex("erp_user_page_access_unique").on(t.companyId, t.userId, t.pageKey),
  })
);

export const insertErpUserPageAccessSchema = createInsertSchema(erpUserPageAccess).omit({ id: true, createdAt: true });
export type InsertErpUserPageAccess = z.infer<typeof insertErpUserPageAccessSchema>;
export type ErpUserPageAccess = typeof erpUserPageAccess.$inferSelect;

export const supplierProformas = pgTable(
  "supplier_proformas",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    supplierId: integer("supplier_id")
      .notNull()
      .references(() => suppliers.id, { onDelete: "restrict" }),
    reference: varchar("reference", { length: 200 }).notNull(),
    notes: text("notes"),
    isStarred: boolean("is_starred").notNull().default(false),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index("supplier_proformas_company_idx").on(t.companyId),
  })
);

export const insertSupplierProformaSchema = createInsertSchema(supplierProformas)
  .omit({
    id: true,
    createdAt: true,
    updatedAt: true,
  })
  .extend({
    companyId: z.number().min(1),
    supplierId: z.number().min(1),
    reference: z.string().min(1, "Reference is required"),
    notes: z.string().optional(),
  });

export type InsertSupplierProforma = z.infer<typeof insertSupplierProformaSchema>;
export type SupplierProforma = typeof supplierProformas.$inferSelect;

export const supplierProformaLines = pgTable("supplier_proforma_lines", {
  id: serial("id").primaryKey(),
  proformaId: integer("proforma_id").notNull(),
  barcode: varchar("barcode", { length: 200 }).notNull(),
  itemName: text("item_name").notNull(),
  qty: integer("qty").notNull().default(0),
  weightPerBale: decimal("weight_per_bale", { precision: 15, scale: 3 }).default("0"),
  pricePerBale: decimal("price_per_bale", { precision: 15, scale: 2 }).default("0"),
});

export const insertSupplierProformaLineSchema = createInsertSchema(supplierProformaLines)
  .omit({ id: true })
  .extend({
    proformaId: z.number().min(1),
    barcode: z.string().min(1, "Barcode is required"),
    itemName: z.string().min(1, "Item name is required"),
    qty: z.number().min(0),
    weightPerBale: z.string().optional(),
    pricePerBale: z.string().optional(),
  });

export type InsertSupplierProformaLine = z.infer<typeof insertSupplierProformaLineSchema>;
export type SupplierProformaLine = typeof supplierProformaLines.$inferSelect;

export const supplierContainerLoadedItems = pgTable("supplier_container_loaded_items", {
  id: serial("id").primaryKey(),
  containerId: integer("container_id").notNull(),
  barcode: varchar("barcode", { length: 200 }).notNull(),
  itemName: text("item_name"),
  qty: integer("qty").notNull().default(0),
  weightPerBale: decimal("weight_per_bale", { precision: 15, scale: 3 }),
  pricePerBale: decimal("price_per_bale", { precision: 15, scale: 2 }),
});

export const insertSupplierContainerLoadedItemSchema = createInsertSchema(supplierContainerLoadedItems)
  .omit({ id: true })
  .extend({
    containerId: z.number().min(1),
    barcode: z.string().min(1, "Barcode is required"),
    itemName: z.string().optional(),
    qty: z.number().min(0),
    weightPerBale: z.string().optional(),
    pricePerBale: z.string().optional(),
  });

export type InsertSupplierContainerLoadedItem = z.infer<typeof insertSupplierContainerLoadedItemSchema>;
export type SupplierContainerLoadedItem = typeof supplierContainerLoadedItems.$inferSelect;

export const fileFolders = pgTable(
  "file_folders",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    name: text("name").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index("file_folders_company_idx").on(t.companyId),
  })
);
export const insertFileFolderSchema = createInsertSchema(fileFolders).omit({ id: true, createdAt: true });
export type InsertFileFolder = z.infer<typeof insertFileFolderSchema>;
export type FileFolder = typeof fileFolders.$inferSelect;

export const storedFiles = pgTable(
  "stored_files",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    folderId: integer("folder_id"),
    fileName: text("file_name").notNull(),
    displayName: text("display_name"),
    fileType: text("file_type").notNull(),
    fileSize: integer("file_size").notNull(),
    fileData: text("file_data").notNull(),
    description: text("description"),
    uploadedBy: varchar("uploaded_by"),
    uploadedAt: timestamp("uploaded_at").notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index("stored_files_company_idx").on(t.companyId),
  })
);

export const insertStoredFileSchema = createInsertSchema(storedFiles)
  .omit({ id: true, uploadedAt: true })
  .extend({
    companyId: z.number().min(1),
    fileName: z.string().min(1),
    fileType: z.string().min(1),
    fileSize: z.number().min(0),
    fileData: z.string().min(1),
    description: z.string().optional(),
    uploadedBy: z.string().optional().nullable(),
    folderId: z.number().optional().nullable(),
    displayName: z.string().optional().nullable(),
  });

export type InsertStoredFile = z.infer<typeof insertStoredFileSchema>;
export type StoredFile = typeof storedFiles.$inferSelect;

export const spreadsheets = pgTable(
  "spreadsheets",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id")
      .notNull()
      .references(() => companies.id),
    name: text("name").notNull().default("Untitled Spreadsheet"),
    data: jsonb("data").notNull().default([]),
    createdBy: text("created_by"),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index("spreadsheets_company_idx").on(t.companyId),
  })
);

export const insertSpreadsheetSchema = createInsertSchema(spreadsheets)
  .omit({ id: true, updatedAt: true })
  .extend({
    companyId: z.number().min(1),
    name: z.string().min(1).default("Untitled Spreadsheet"),
    data: z.any().default([]),
    createdBy: z.string().optional(),
  });

export type InsertSpreadsheet = z.infer<typeof insertSpreadsheetSchema>;
export type Spreadsheet = typeof spreadsheets.$inferSelect;

export const liveSpreadsheets = pgTable(
  "live_spreadsheets",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id")
      .notNull()
      .references(() => companies.id),
    name: text("name").notNull(),
    url: text("url").notNull(),
    description: text("description"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index("live_spreadsheets_company_idx").on(t.companyId),
  })
);

export const insertLiveSpreadsheetSchema = createInsertSchema(liveSpreadsheets)
  .omit({ id: true, createdAt: true, updatedAt: true })
  .extend({
    companyId: z.number().min(1),
    name: z.string().min(1, "Name is required"),
    url: z.string().url("Must be a valid URL"),
    description: z.string().optional(),
    isActive: z.boolean().default(true),
  });

export type InsertLiveSpreadsheet = z.infer<typeof insertLiveSpreadsheetSchema>;
export type LiveSpreadsheet = typeof liveSpreadsheets.$inferSelect;
