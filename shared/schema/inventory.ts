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
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { locations } from "./common";

export const stockGroups = pgTable(
  "stock_groups",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    code: varchar("code", { length: 50 }).notNull(),
    name: text("name").notNull(),
    parentId: integer("parent_id"),
    active: boolean("active").notNull().default(true),
    deletedAt: timestamp("deleted_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    uniqueCompanyCode: uniqueIndex("stock_groups_company_code_unique").on(t.companyId, t.code),
  })
);

export const insertStockGroupSchema = createInsertSchema(stockGroups)
  .omit({
    id: true,
    createdAt: true,
  })
  .extend({
    companyId: z.number().min(1, "Company is required"),
    code: z.string().min(1, "Code is required"),
    name: z.string().min(1, "Name is required"),
  });

export type InsertStockGroup = z.infer<typeof insertStockGroupSchema>;
export type StockGroup = typeof stockGroups.$inferSelect;

export const stockGrades = pgTable("stock_grades", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull(),
  name: text("name").notNull(),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertStockGradeSchema = createInsertSchema(stockGrades)
  .omit({
    id: true,
    createdAt: true,
  })
  .extend({
    companyId: z.number().min(1, "Company is required"),
    name: z.string().min(1, "Name is required"),
  });

export type InsertStockGrade = z.infer<typeof insertStockGradeSchema>;
export type StockGrade = typeof stockGrades.$inferSelect;

export const stockCategories = pgTable("stock_categories", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull(),
  name: text("name").notNull(),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertStockCategorySchema = createInsertSchema(stockCategories)
  .omit({
    id: true,
    createdAt: true,
  })
  .extend({
    companyId: z.number().min(1, "Company is required"),
    name: z.string().min(1, "Name is required"),
  });

export type InsertStockCategory = z.infer<typeof insertStockCategorySchema>;
export type StockCategory = typeof stockCategories.$inferSelect;

export const stockItems = pgTable(
  "stock_items",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    code: varchar("code", { length: 50 }).notNull(),
    name: text("name").notNull(),
    stockGroupId: integer("stock_group_id"),
    gradeId: integer("grade_id"),
    categoryId: integer("category_id"),
    uom: text("uom").notNull(),
    openingQty: decimal("opening_qty", { precision: 15, scale: 3 }).default("0"),
    openingRate: decimal("opening_rate", { precision: 15, scale: 2 }).default("0"),
    openingValue: decimal("opening_value", { precision: 15, scale: 2 }).default("0"),
    reorderLevel: decimal("reorder_level", { precision: 15, scale: 3 }).default("0"),
    sellingPrice: decimal("selling_price", { precision: 15, scale: 2 }).default("0"),
    active: boolean("active").notNull().default(true),
    deletedAt: timestamp("deleted_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    uniqueCompanyCode: uniqueIndex("stock_items_company_code_unique").on(t.companyId, t.code),
    companyDeletedCodeIdx: index("stock_items_company_deleted_code_idx").on(t.companyId, t.deletedAt, t.code),
    companyGroupIdx: index("stock_items_company_group_idx").on(t.companyId, t.stockGroupId),
  })
);

export const insertStockItemSchema = createInsertSchema(stockItems)
  .omit({
    id: true,
    createdAt: true,
  })
  .extend({
    companyId: z.number().min(1, "Company is required"),
    code: z.string().min(1, "Code is required"),
    name: z.string().min(1, "Name is required"),
    uom: z.string().min(1, "Unit of measure is required"),
  });

export type InsertStockItem = z.infer<typeof insertStockItemSchema>;
export type StockItem = typeof stockItems.$inferSelect;

export const stockItemCodeAliases = pgTable(
  "stock_item_code_aliases",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    stockItemId: integer("stock_item_id")
      .notNull()
      .references(() => stockItems.id, { onDelete: "cascade" }),
    aliasCode: varchar("alias_code", { length: 50 }).notNull(),
    description: text("description"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    uniqueCompanyAlias: uniqueIndex("stock_item_code_aliases_company_alias_unique").on(t.companyId, t.aliasCode),
  })
);

export const insertStockItemCodeAliasSchema = createInsertSchema(stockItemCodeAliases)
  .omit({
    id: true,
    createdAt: true,
  })
  .extend({
    companyId: z.number().min(1, "Company is required"),
    stockItemId: z.number().min(1, "Stock item is required"),
    aliasCode: z.string().min(1, "Alias code is required"),
    description: z.string().optional(),
  });

export type InsertStockItemCodeAlias = z.infer<typeof insertStockItemCodeAliasSchema>;
export type StockItemCodeAlias = typeof stockItemCodeAliases.$inferSelect;

export const inventory = pgTable(
  "inventory",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    locationId: integer("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "restrict" }),
    stockItemId: integer("stock_item_id")
      .notNull()
      .references(() => stockItems.id, { onDelete: "restrict" }),
    quantity: decimal("quantity", { precision: 15, scale: 3 }).notNull().default("0"),
    // Display precision and cost memory (wave 11); stock value is totalValue.
    averageRate: decimal("average_rate", { precision: 20, scale: 7 }).notNull().default("0"),
    totalValue: decimal("total_value", { precision: 20, scale: 2 }).notNull().default("0"),
    lastUpdated: timestamp("last_updated").notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index("inventory_company_idx").on(t.companyId),
    uniqueLocationItem: uniqueIndex("inventory_location_item_unique").on(t.locationId, t.stockItemId),
    locationIdx: index("inventory_location_idx").on(t.locationId),
    stockItemIdx: index("inventory_stock_item_idx").on(t.stockItemId),
    companyLocationIdx: index("inventory_company_location_idx").on(t.companyId, t.locationId),
  })
);

export const insertInventorySchema = createInsertSchema(inventory)
  .omit({
    id: true,
  })
  .extend({
    companyId: z.number().min(1, "Company is required"),
    locationId: z.number().min(1, "Location is required"),
    stockItemId: z.number().min(1, "Stock item is required"),
    quantity: z.string(),
    averageRate: z.string(),
    totalValue: z.string(),
  });

export type InsertInventory = z.infer<typeof insertInventorySchema>;
export type Inventory = typeof inventory.$inferSelect;

export const stockItemLocationPrices = pgTable(
  "stock_item_location_prices",
  {
    id: serial("id").primaryKey(),
    stockItemId: integer("stock_item_id")
      .notNull()
      .references(() => stockItems.id, { onDelete: "cascade" }),
    locationId: integer("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "cascade" }),
    sellingPrice: decimal("selling_price", { precision: 15, scale: 2 }).notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    uniqueItemLocation: uniqueIndex("stock_item_location_prices_item_location_unique").on(t.stockItemId, t.locationId),
  })
);

export const insertStockItemLocationPriceSchema = createInsertSchema(stockItemLocationPrices)
  .omit({
    id: true,
    createdAt: true,
    updatedAt: true,
  })
  .extend({
    stockItemId: z.number().min(1, "Stock item is required"),
    locationId: z.number().min(1, "Location is required"),
    sellingPrice: z.string().min(1, "Selling price is required"),
  });

export type InsertStockItemLocationPrice = z.infer<typeof insertStockItemLocationPriceSchema>;
export type StockItemLocationPrice = typeof stockItemLocationPrices.$inferSelect;

export const stockGroupLocationArchives = pgTable(
  "stock_group_location_archives",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    locationId: integer("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "restrict" }),
    stockGroupId: integer("stock_group_id"),
    locationName: text("location_name").notNull(),
    stockGroupName: text("stock_group_name").notNull(),
    totalQuantity: decimal("total_quantity", { precision: 15, scale: 3 }).notNull().default("0"),
    totalValue: decimal("total_value", { precision: 20, scale: 2 }).notNull().default("0"),
    itemCount: integer("item_count").notNull().default(0),
    archivedBy: varchar("archived_by").notNull(),
    archivedAt: timestamp("archived_at").notNull().defaultNow(),
    restoredAt: timestamp("restored_at"),
    deletedAt: timestamp("deleted_at"),
    notes: text("notes"),
  },
  (t) => ({
    companyIdx: index("stock_group_location_archives_company_idx").on(t.companyId),
  })
);

export const insertStockGroupLocationArchiveSchema = createInsertSchema(stockGroupLocationArchives).omit({
  id: true,
  archivedAt: true,
});

export type InsertStockGroupLocationArchive = z.infer<typeof insertStockGroupLocationArchiveSchema>;
export type StockGroupLocationArchive = typeof stockGroupLocationArchives.$inferSelect;

export const stockGroupLocationArchiveItems = pgTable("stock_group_location_archive_items", {
  id: serial("id").primaryKey(),
  archiveId: integer("archive_id").notNull(),
  stockItemId: integer("stock_item_id")
    .notNull()
    .references(() => stockItems.id, { onDelete: "restrict" }),
  stockItemCode: varchar("stock_item_code", { length: 50 }).notNull(),
  stockItemName: text("stock_item_name").notNull(),
  quantity: decimal("quantity", { precision: 15, scale: 3 }).notNull(),
  averageRate: decimal("average_rate", { precision: 20, scale: 2 }).notNull(),
  totalValue: decimal("total_value", { precision: 20, scale: 2 }).notNull(),
});

export const insertStockGroupLocationArchiveItemSchema = createInsertSchema(stockGroupLocationArchiveItems).omit({
  id: true,
});

export type InsertStockGroupLocationArchiveItem = z.infer<typeof insertStockGroupLocationArchiveItemSchema>;
export type StockGroupLocationArchiveItem = typeof stockGroupLocationArchiveItems.$inferSelect;
