import { boolean, index, integer, pgTable, serial, timestamp, bigint, varchar } from "drizzle-orm/pg-core";
import { companies } from "./common";
import { retailProductVariants } from "./retail";
import { users } from "./users";

export const RETAIL_BARCODE_SOURCES = ["manual", "generated", "import"] as const;
export type RetailBarcodeSource = (typeof RETAIL_BARCODE_SOURCES)[number];

export const RETAIL_LABEL_LAYOUTS = ["thermal-50x30", "thermal-58x40", "a4-24"] as const;
export type RetailLabelLayout = (typeof RETAIL_LABEL_LAYOUTS)[number];

/** Per-company counter used to issue in-store EAN-13 barcodes (prefix 2, restricted circulation). */
export const retailBarcodeSequences = pgTable("retail_barcode_sequences", {
  companyId: integer("company_id")
    .primaryKey()
    .references(() => companies.id, { onDelete: "cascade" }),
  nextValue: bigint("next_value", { mode: "number" }).notNull().default(1),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

/** Append-only audit of every label print / reprint. Printing never changes a variant's barcode. */
export const retailLabelPrintEvents = pgTable(
  "retail_label_print_events",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    variantId: integer("variant_id")
      .notNull()
      .references(() => retailProductVariants.id, { onDelete: "restrict" }),
    barcode: varchar("barcode", { length: 191 }).notNull(),
    copies: integer("copies").notNull().default(1),
    layout: varchar("layout", { length: 40 }).notNull(),
    isReprint: boolean("is_reprint").notNull().default(false),
    createdBy: varchar("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index("retail_label_print_events_company_idx").on(t.companyId),
    variantIdx: index("retail_label_print_events_variant_idx").on(t.variantId),
  })
);

export type RetailLabelPrintEvent = typeof retailLabelPrintEvents.$inferSelect;
