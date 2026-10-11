/**
 * Factory cost basis tables (accounting audit wave 11, inventory fidelity).
 *
 * Also created at boot by ensureFactoryCostBasisSchema
 * (server/services/factory/factoryCostBasisSchema.ts), with the same columns
 * and constraint names, because production skips schema pushes.
 */
import {
  pgTable,
  text,
  serial,
  integer,
  decimal,
  date,
  timestamp,
  index,
  uniqueIndex,
  jsonb,
} from "drizzle-orm/pg-core";
import { factoryBales } from "./raw-stock-mix";
import { factoryPosSales } from "./pos-transport";

/**
 * The bales a factory POS sale took, so a void or an edit puts back exactly
 * those bales and the sale's cost of sales is the cost of those bales.
 */
export const factoryPosSaleBales = pgTable(
  "factory_pos_sale_bales",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    saleId: integer("sale_id")
      .notNull()
      .references(() => factoryPosSales.id, { onDelete: "restrict" }),
    baleId: integer("bale_id")
      .notNull()
      .references(() => factoryBales.id, { onDelete: "restrict" }),
    /** The bale's total_cost when the sale took it (information; COGS reads the bale). */
    costAtSale: decimal("cost_at_sale", { precision: 20, scale: 7 }).notNull().default("0"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    saleBaleUnique: uniqueIndex("factory_pos_sale_bales_sale_bale_unique").on(t.saleId, t.baleId),
    saleIdx: index("factory_pos_sale_bales_sale_idx").on(t.saleId),
  })
);

/**
 * Factory stock value changes tagged by source, so the daily factory stock
 * journal posts each to its own account: WASTE (write-offs, removals) to
 * Factory Waste and Write-off, REVALUATION (cost cascades and container cost
 * recalculations) to Factory Stock Revaluation, MATERIAL_PRICE (the supplier
 * rate a mix used against the container's landed cost) to Factory Material
 * Price Variance. `amount` is the signed change of the factory stock value
 * (USD): a write-off is negative. Recorded only once a company's cut-over
 * applies; `journal_date` is the GL-FACTORY-STOCK journal that took it.
 */
export const factoryStockValueEvents = pgTable(
  "factory_stock_value_events",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    eventDate: date("event_date").notNull(),
    kind: text("kind").notNull(),
    amount: decimal("amount", { precision: 20, scale: 7 }).notNull(),
    sourceType: text("source_type").notNull(),
    sourceId: text("source_id"),
    journalDate: date("journal_date"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    companyJournalIdx: index("factory_stock_value_events_company_journal_idx").on(t.companyId, t.journalDate),
  })
);

/** One applied, Owner-confirmed re-cost of unsold bales and open mixes. */
export const factoryBaleRecostRuns = pgTable(
  "factory_bale_recost_runs",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    planHash: text("plan_hash").notNull(),
    plan: jsonb("plan").notNull(),
    voucherId: integer("voucher_id"),
    appliedBy: text("applied_by"),
    appliedAt: timestamp("applied_at").notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index("factory_bale_recost_runs_company_idx").on(t.companyId),
  })
);
