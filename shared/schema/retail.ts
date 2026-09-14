import {
  boolean,
  decimal,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { companies, locations } from "./common";

export const RETAIL_NO_BRAND_NAME = "Other / No Brand";

export const retailBrands = pgTable(
  "retail_brands",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    normalizedName: text("normalized_name").notNull(),
    isNoBrand: boolean("is_no_brand").notNull().default(false),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index("retail_brands_company_idx").on(t.companyId),
    companyNameUnique: uniqueIndex("retail_brands_company_name_unique").on(t.companyId, t.normalizedName),
  })
);

export const retailProducts = pgTable(
  "retail_products",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    code: varchar("code", { length: 100 }).notNull(),
    name: text("name").notNull(),
    brandId: integer("brand_id").references(() => retailBrands.id, { onDelete: "set null" }),
    category: text("category"),
    description: text("description"),
    imageUrls: jsonb("image_urls").$type<string[]>().notNull().default([]),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index("retail_products_company_idx").on(t.companyId),
    companyCodeUnique: uniqueIndex("retail_products_company_code_unique").on(t.companyId, t.code),
    brandIdx: index("retail_products_brand_idx").on(t.brandId),
  })
);

export const retailProductVariants = pgTable(
  "retail_product_variants",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    productId: integer("product_id")
      .notNull()
      .references(() => retailProducts.id, { onDelete: "cascade" }),
    size: varchar("size", { length: 100 }).notNull(),
    barcode: varchar("barcode", { length: 191 }).notNull(),
    sku: varchar("sku", { length: 191 }),
    cost: decimal("cost", { precision: 20, scale: 6 }).notNull().default("0"),
    sellingPrice: decimal("selling_price", { precision: 20, scale: 6 }).notNull().default("0"),
    lowStockThreshold: decimal("low_stock_threshold", { precision: 20, scale: 6 }).notNull().default("0"),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index("retail_product_variants_company_idx").on(t.companyId),
    productIdx: index("retail_product_variants_product_idx").on(t.productId),
    companyBarcodeUnique: uniqueIndex("retail_product_variants_company_barcode_unique").on(t.companyId, t.barcode),
    companySkuUnique: uniqueIndex("retail_product_variants_company_sku_unique").on(t.companyId, t.sku),
    productSizeUnique: uniqueIndex("retail_product_variants_product_size_unique").on(t.productId, t.size),
  })
);

export const retailVariantInventory = pgTable(
  "retail_variant_inventory",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    variantId: integer("variant_id")
      .notNull()
      .references(() => retailProductVariants.id, { onDelete: "cascade" }),
    locationId: integer("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "restrict" }),
    quantity: decimal("quantity", { precision: 20, scale: 6 }).notNull().default("0"),
    averageCost: decimal("average_cost", { precision: 20, scale: 6 }).notNull().default("0"),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index("retail_variant_inventory_company_idx").on(t.companyId),
    variantIdx: index("retail_variant_inventory_variant_idx").on(t.variantId),
    locationIdx: index("retail_variant_inventory_location_idx").on(t.locationId),
    variantLocationUnique: uniqueIndex("retail_variant_inventory_variant_location_unique").on(
      t.variantId,
      t.locationId
    ),
  })
);

export const insertRetailBrandSchema = createInsertSchema(retailBrands)
  .omit({ id: true, createdAt: true, updatedAt: true, normalizedName: true })
  .extend({
    companyId: z.number().int().positive(),
    name: z.string().trim().min(1).max(120),
  });

export const insertRetailProductSchema = createInsertSchema(retailProducts)
  .omit({ id: true, createdAt: true, updatedAt: true })
  .extend({
    companyId: z.number().int().positive(),
    code: z.string().trim().min(1).max(100),
    name: z.string().trim().min(1).max(240),
    brandId: z.number().int().positive().nullable().optional(),
    category: z.string().trim().max(160).nullable().optional(),
    description: z.string().trim().max(5000).nullable().optional(),
    imageUrls: z.array(z.string().trim().url()).max(8).optional().default([]),
  });

export const retailVariantInputSchema = z.object({
  id: z.number().int().positive().optional(),
  size: z.string().trim().min(1).max(100),
  barcode: z.string().trim().min(1).max(191),
  sku: z.string().trim().max(191).nullable().optional(),
  cost: z.coerce.number().finite().nonnegative(),
  sellingPrice: z.coerce.number().finite().nonnegative(),
  lowStockThreshold: z.coerce.number().finite().nonnegative().optional().default(0),
  active: z.boolean().optional().default(true),
  stocks: z
    .array(
      z.object({
        locationId: z.number().int().positive(),
        quantity: z.coerce.number().finite(),
      })
    )
    .optional()
    .default([]),
});

export const retailProductWriteSchema = z.object({
  code: z.string().trim().min(1).max(100),
  name: z.string().trim().min(1).max(240),
  brandId: z.number().int().positive().nullable().optional(),
  brandName: z.string().trim().min(1).max(120).optional(),
  category: z.string().trim().max(160).nullable().optional(),
  description: z.string().trim().max(5000).nullable().optional(),
  imageUrls: z.array(z.string().trim().url()).max(8).optional().default([]),
  active: z.boolean().optional().default(true),
  variants: z.array(retailVariantInputSchema).min(1),
});

export const retailImportRowSchema = z.object({
  code: z.string().trim().min(1),
  name: z.string().trim().min(1),
  brand: z.string().trim().optional().default(RETAIL_NO_BRAND_NAME),
  size: z.string().trim().min(1),
  barcode: z.string().trim().min(1),
  cost: z.coerce.number().finite().nonnegative(),
  price: z.coerce.number().finite().nonnegative(),
  qty: z.coerce.number().finite(),
  location: z.string().trim().min(1),
  category: z.string().trim().optional(),
  description: z.string().trim().optional(),
  imageUrl: z.string().trim().url().optional().or(z.literal("")),
});

export type RetailBrand = typeof retailBrands.$inferSelect;
export type RetailProduct = typeof retailProducts.$inferSelect;
export type RetailProductVariant = typeof retailProductVariants.$inferSelect;
export type RetailVariantInventory = typeof retailVariantInventory.$inferSelect;
export type RetailProductWrite = z.infer<typeof retailProductWriteSchema>;
export type RetailImportRow = z.infer<typeof retailImportRowSchema>;
