import {
  boolean,
  decimal,
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { companies } from "./common";
import { stockGroups } from "./inventory";

/**
 * Company-owned ERP supplier master.
 *
 * This intentionally maps the existing `suppliers` table while the legacy
 * `suppliers` export in erp.ts is retained for compatibility with older read
 * paths. Security-sensitive routes and posting validation must use this table
 * definition so company ownership is always part of the query predicate.
 */
export const companyScopedSuppliers = pgTable(
  "suppliers",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    code: varchar("code", { length: 50 }).notNull(),
    legalName: text("legal_name").notNull(),
    email: text("email").notNull(),
    phone: text("phone"),
    address: text("address"),
    taxId: text("tax_id"),
    paymentTerms: text("payment_terms"),
    openingBalance: decimal("opening_balance", { precision: 15, scale: 2 }).default("0"),
    active: boolean("active").notNull().default(true),
    deletedAt: timestamp("deleted_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    stockGroupId: integer("stock_group_id").references(() => stockGroups.id, { onDelete: "set null" }),
  },
  (t) => ({
    companyIdx: index("suppliers_company_idx").on(t.companyId),
    companyCodeUnique: uniqueIndex("suppliers_company_code_unique").on(t.companyId, t.code),
  })
);

export const insertCompanyScopedSupplierSchema = createInsertSchema(companyScopedSuppliers)
  .omit({
    id: true,
    createdAt: true,
    deletedAt: true,
  })
  .extend({
    companyId: z.number().int().positive("Company is required"),
    code: z.string().optional(),
    legalName: z.string().trim().min(1, "Legal name is required"),
    email: z.string().email("Invalid email format").optional().or(z.literal("")),
    phone: z.string().optional(),
    address: z.string().optional(),
    taxId: z.string().optional(),
    paymentTerms: z.string().optional(),
    openingBalance: z.string().optional(),
    stockGroupId: z.number().int().positive().nullable().optional(),
  });

export type CompanyScopedSupplier = typeof companyScopedSuppliers.$inferSelect;
export type InsertCompanyScopedSupplier = z.infer<typeof insertCompanyScopedSupplierSchema>;
