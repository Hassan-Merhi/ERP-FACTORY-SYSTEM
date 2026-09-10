import { boolean, index, integer, pgTable, serial, timestamp, uniqueIndex, varchar } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { companies, locations } from "./common";
import { companyScopedSuppliers } from "./supplierCompanyScope";

/**
 * Company-scoped defaults used by ERP container tracking.
 *
 * A supplier may point to a different shop/location or clearing agent in each
 * company. The container keeps the resolved text value as a historical snapshot;
 * changing this mapping therefore affects new containers only unless the explicit
 * backfill action is run.
 */
export const supplierTrackingDefaults = pgTable(
  "supplier_tracking_defaults",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    supplierId: integer("supplier_id")
      .notNull()
      .references(() => companyScopedSuppliers.id, { onDelete: "cascade" }),
    locationId: integer("location_id").references(() => locations.id, { onDelete: "set null" }),
    agentName: varchar("agent_name", { length: 100 }),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    companySupplierUnique: uniqueIndex("supplier_tracking_defaults_company_supplier_unique").on(
      t.companyId,
      t.supplierId
    ),
    companyIdx: index("supplier_tracking_defaults_company_idx").on(t.companyId),
  })
);

export const upsertSupplierTrackingDefaultSchema = z.object({
  locationId: z.number().int().positive().nullable().optional(),
  agentName: z.string().trim().max(100).nullable().optional(),
});

export const insertSupplierTrackingDefaultSchema = createInsertSchema(supplierTrackingDefaults).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type SupplierTrackingDefault = typeof supplierTrackingDefaults.$inferSelect;
export type InsertSupplierTrackingDefault = z.infer<typeof insertSupplierTrackingDefaultSchema>;
export type UpsertSupplierTrackingDefault = z.infer<typeof upsertSupplierTrackingDefaultSchema>;
