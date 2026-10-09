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
import { companies } from "./common";
import { retailBrands, retailProductVariants, retailProducts } from "./retail";
import { users } from "./users";

/**
 * Retail Wave 2 selling configuration: discount/override approval policy and the
 * tax foundation. One row per retail company; everything is disabled/neutral by
 * default so existing companies keep their current pricing behaviour.
 */
export const RETAIL_ORDER_DISCOUNT_TYPES = ["none", "percent", "fixed"] as const;
export type RetailOrderDiscountType = (typeof RETAIL_ORDER_DISCOUNT_TYPES)[number];

/** How a line discount was entered. `override` and `promotion` are separate concepts
 * that also end up in the discount snapshot. */
export const RETAIL_LINE_DISCOUNT_TYPES = ["none", "percent", "fixed", "override", "promotion"] as const;
export type RetailLineDiscountType = (typeof RETAIL_LINE_DISCOUNT_TYPES)[number];

export const RETAIL_DEFAULT_DISCOUNT_LIMIT_PERCENT = 10;

export const retailPosSettings = pgTable(
  "retail_pos_settings",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id")
      .notNull()
      .unique()
      .references(() => companies.id, { onDelete: "cascade" }),
    /** Highest discount percent a non-manager may apply without manager approval. */
    discountLimitPercent: decimal("discount_limit_percent", { precision: 6, scale: 2 }).notNull().default("10"),
    /** When false, no discount/override ever needs approval (managers still get audited). */
    requireManagerApproval: boolean("require_manager_approval").notNull().default(true),
    /** Manual price overrides always need approval unless this is off. */
    priceOverrideRequiresApproval: boolean("price_override_requires_approval").notNull().default(true),
    // ── Tax foundation (disabled by default) ──────────────────────────────────
    taxEnabled: boolean("tax_enabled").notNull().default(false),
    taxLabel: varchar("tax_label", { length: 40 }).notNull().default("Tax"),
    /** Fraction, e.g. 0.18000 = 18%. */
    taxRate: decimal("tax_rate", { precision: 8, scale: 5 }).notNull().default("0"),
    /** true = listed prices include tax; false = tax is added on top. */
    taxInclusive: boolean("tax_inclusive").notNull().default(false),
    updatedBy: varchar("updated_by", { length: 255 }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index("retail_pos_settings_company_idx").on(t.companyId),
  })
);

export const RETAIL_PROMOTION_SCOPES = ["all", "brand", "product", "variant"] as const;
export type RetailPromotionScope = (typeof RETAIL_PROMOTION_SCOPES)[number];

export const RETAIL_PROMOTION_DISCOUNT_TYPES = ["percent", "fixed"] as const;
export type RetailPromotionDiscountType = (typeof RETAIL_PROMOTION_DISCOUNT_TYPES)[number];

/**
 * Deliberately small date-based promotion framework: a promotion applies to a
 * catalogue scope while `startsAt`/`endsAt` allow it. No coupons, conditions or
 * stacking rules yet — the sale line records the promotion id it used.
 */
export const retailPromotions = pgTable(
  "retail_promotions",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 160 }).notNull(),
    description: text("description"),
    scope: varchar("scope", { length: 20 }).notNull().default("all"),
    brandId: integer("brand_id").references(() => retailBrands.id, { onDelete: "cascade" }),
    productId: integer("product_id").references(() => retailProducts.id, { onDelete: "cascade" }),
    variantId: integer("variant_id").references(() => retailProductVariants.id, { onDelete: "cascade" }),
    discountType: varchar("discount_type", { length: 20 }).notNull(),
    /** Percent points for `percent`, per-unit amount for `fixed`. */
    value: decimal("value", { precision: 20, scale: 6 }).notNull(),
    startsAt: timestamp("starts_at"),
    endsAt: timestamp("ends_at"),
    active: boolean("active").notNull().default(true),
    /** Higher priority wins when several promotions match the same variant. */
    priority: integer("priority").notNull().default(0),
    createdBy: varchar("created_by", { length: 255 }).references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index("retail_promotions_company_idx").on(t.companyId),
    companyActiveIdx: index("retail_promotions_company_active_idx").on(t.companyId, t.active),
    companyWindowIdx: index("retail_promotions_company_window_idx").on(t.companyId, t.startsAt, t.endsAt),
  })
);

/**
 * Audit record for every manager-approved discount / price override. The sale keeps
 * a snapshot of the approver, and consuming the approval for a sale is recorded here.
 */
export const retailDiscountApprovals = pgTable(
  "retail_discount_approvals",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    tokenId: varchar("token_id", { length: 64 }).notNull(),
    managerUserId: varchar("manager_user_id", { length: 255 })
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    managerName: text("manager_name").notNull(),
    cashierUserId: varchar("cashier_user_id", { length: 255 })
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    reason: text("reason"),
    requestedDiscountPercent: decimal("requested_discount_percent", { precision: 6, scale: 2 }).notNull().default("0"),
    allowsPriceOverride: boolean("allows_price_override").notNull().default(false),
    expiresAt: timestamp("expires_at").notNull(),
    consumedSaleId: integer("consumed_sale_id"),
    consumedAt: timestamp("consumed_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index("retail_discount_approvals_company_idx").on(t.companyId),
    companyTokenUnique: uniqueIndex("retail_discount_approvals_company_token_unique").on(t.companyId, t.tokenId),
    managerIdx: index("retail_discount_approvals_manager_idx").on(t.managerUserId),
  })
);

export type RetailPosSettings = typeof retailPosSettings.$inferSelect;
export type RetailPromotion = typeof retailPromotions.$inferSelect;
export type RetailDiscountApproval = typeof retailDiscountApprovals.$inferSelect;
