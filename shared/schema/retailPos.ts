import { sql } from "drizzle-orm";
import {
  boolean,
  date,
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
import { companies, locations } from "./common";
import { bankAccounts, ledgerAccounts } from "./accounting";
import { posShifts } from "./pos";
import { retailProductVariants } from "./retail";
import { retailDiscountApprovals, retailPromotions } from "./retailSelling";
import { users } from "./users";
import { customers } from "./erp/vouchers";

export const RETAIL_STOCK_MOVEMENT_TYPES = [
  "sale",
  "return",
  "adjustment",
  "import",
  "transfer_out",
  "transfer_in",
  "cancellation",
  "reversal",
  "receive",
  "stock_count",
] as const;

export type RetailStockMovementType = (typeof RETAIL_STOCK_MOVEMENT_TYPES)[number];

/** Walk-in cash is the default retail customer; no customer row is required. */
export const RETAIL_WALK_IN_CUSTOMER_NAME = "Walk-in";

export const retailPosSales = pgTable(
  "retail_pos_sales",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    locationId: integer("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "restrict" }),
    idempotencyKey: varchar("idempotency_key", { length: 191 }).notNull(),
    status: varchar("status", { length: 32 }).notNull().default("completed"),
    shiftId: integer("shift_id").references(() => posShifts.id, { onDelete: "set null" }),
    accountingVoucherId: integer("accounting_voucher_id"),
    // Walk-in cash sales keep customerId null and the snapshot name "Walk-in".
    customerId: integer("customer_id").references(() => customers.id, { onDelete: "set null" }),
    customerName: varchar("customer_name", { length: 191 }).notNull().default(RETAIL_WALK_IN_CUSTOMER_NAME),
    /**
     * Money snapshot for this sale, written once at checkout and never recomputed:
     * listSubtotal (pre-discount, pre-tax) → discountTotal → subtotal (net after discount)
     * → taxAmount → totalAmount (what the customer paid).
     */
    listSubtotal: decimal("list_subtotal", { precision: 20, scale: 6 }).notNull().default("0"),
    discountTotal: decimal("discount_total", { precision: 20, scale: 6 }).notNull().default("0"),
    subtotal: decimal("subtotal", { precision: 20, scale: 6 }).notNull().default("0"),
    orderDiscountType: varchar("order_discount_type", { length: 20 }).notNull().default("none"),
    orderDiscountValue: decimal("order_discount_value", { precision: 20, scale: 6 }).notNull().default("0"),
    orderDiscountAmount: decimal("order_discount_amount", { precision: 20, scale: 6 }).notNull().default("0"),
    orderDiscountReason: text("order_discount_reason"),
    taxEnabled: boolean("tax_enabled").notNull().default(false),
    taxLabel: varchar("tax_label", { length: 40 }).notNull().default("Tax"),
    taxRate: decimal("tax_rate", { precision: 8, scale: 5 }).notNull().default("0"),
    taxInclusive: boolean("tax_inclusive").notNull().default(false),
    taxAmount: decimal("tax_amount", { precision: 20, scale: 6 }).notNull().default("0"),
    totalAmount: decimal("total_amount", { precision: 20, scale: 6 }).notNull().default("0"),
    // Manager approval snapshot for discounts / price overrides above the role limit.
    approvalId: integer("approval_id").references(() => retailDiscountApprovals.id, { onDelete: "set null" }),
    approvedByUserId: varchar("approved_by_user_id", { length: 255 }),
    approvedByName: text("approved_by_name"),
    createdBy: varchar("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    notes: text("notes"),
    canceledAt: timestamp("canceled_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index("retail_pos_sales_company_idx").on(t.companyId),
    locationIdx: index("retail_pos_sales_location_idx").on(t.locationId),
    shiftIdx: index("retail_pos_sales_shift_idx").on(t.shiftId),
    customerIdx: index("retail_pos_sales_customer_idx").on(t.customerId),
    companyCreatedIdx: index("retail_pos_sales_company_created_idx").on(t.companyId, t.createdAt),
    companyIdempotencyUnique: uniqueIndex("retail_pos_sales_company_idempotency_unique").on(
      t.companyId,
      t.idempotencyKey
    ),
  })
);

export const retailPosSaleItems = pgTable(
  "retail_pos_sale_items",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    saleId: integer("sale_id")
      .notNull()
      .references(() => retailPosSales.id, { onDelete: "cascade" }),
    variantId: integer("variant_id")
      .notNull()
      .references(() => retailProductVariants.id, { onDelete: "restrict" }),
    quantity: decimal("quantity", { precision: 20, scale: 6 }).notNull(),
    returnedQuantity: decimal("returned_quantity", { precision: 20, scale: 6 }).notNull().default("0"),
    /**
     * originalUnitPrice is the variant selling price snapshot at sale time and is never
     * overwritten. unitPrice is the final pre-tax price actually charged after every
     * discount; grossUnitPrice is what the customer paid per unit including tax and is
     * the refund basis for returns and exchanges.
     */
    originalUnitPrice: decimal("original_unit_price", { precision: 20, scale: 6 }).notNull().default("0"),
    unitPrice: decimal("unit_price", { precision: 20, scale: 6 }).notNull(),
    grossUnitPrice: decimal("gross_unit_price", { precision: 20, scale: 6 }).notNull().default("0"),
    lineDiscountAmount: decimal("line_discount_amount", { precision: 20, scale: 6 }).notNull().default("0"),
    lineDiscountType: varchar("line_discount_type", { length: 20 }).notNull().default("none"),
    lineDiscountValue: decimal("line_discount_value", { precision: 20, scale: 6 }).notNull().default("0"),
    discountReason: text("discount_reason"),
    priceOverride: boolean("price_override").notNull().default(false),
    promotionId: integer("promotion_id").references(() => retailPromotions.id, { onDelete: "set null" }),
    taxAmount: decimal("tax_amount", { precision: 20, scale: 6 }).notNull().default("0"),
    lineTotal: decimal("line_total", { precision: 20, scale: 6 }).notNull().default("0"),
    approvedByUserId: varchar("approved_by_user_id", { length: 255 }),
    unitCost: decimal("unit_cost", { precision: 20, scale: 6 }).notNull().default("0"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index("retail_pos_sale_items_company_idx").on(t.companyId),
    saleIdx: index("retail_pos_sale_items_sale_idx").on(t.saleId),
    variantIdx: index("retail_pos_sale_items_variant_idx").on(t.variantId),
  })
);

export const retailPosReturns = pgTable(
  "retail_pos_returns",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    saleId: integer("sale_id")
      .notNull()
      .references(() => retailPosSales.id, { onDelete: "restrict" }),
    idempotencyKey: varchar("idempotency_key", { length: 191 }).notNull(),
    createdBy: varchar("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    // Actual historical amount refunded (tax included) and the tax portion of it.
    refundAmount: decimal("refund_amount", { precision: 20, scale: 6 }).notNull().default("0"),
    refundTaxAmount: decimal("refund_tax_amount", { precision: 20, scale: 6 }).notNull().default("0"),
    notes: text("notes"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index("retail_pos_returns_company_idx").on(t.companyId),
    saleIdx: index("retail_pos_returns_sale_idx").on(t.saleId),
    companyIdempotencyUnique: uniqueIndex("retail_pos_returns_company_idempotency_unique").on(
      t.companyId,
      t.idempotencyKey
    ),
  })
);

export const retailPosReturnItems = pgTable(
  "retail_pos_return_items",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    returnId: integer("return_id")
      .notNull()
      .references(() => retailPosReturns.id, { onDelete: "cascade" }),
    saleItemId: integer("sale_item_id")
      .notNull()
      .references(() => retailPosSaleItems.id, { onDelete: "restrict" }),
    variantId: integer("variant_id")
      .notNull()
      .references(() => retailProductVariants.id, { onDelete: "restrict" }),
    locationId: integer("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "restrict" }),
    quantity: decimal("quantity", { precision: 20, scale: 6 }).notNull(),
    // unitPrice is the historic pre-tax price paid; grossUnitPrice is the tax-inclusive
    // price paid per unit and is what a refund is calculated from.
    unitPrice: decimal("unit_price", { precision: 20, scale: 6 }).notNull(),
    unitCost: decimal("unit_cost", { precision: 20, scale: 6 }).notNull().default("0"),
    grossUnitPrice: decimal("gross_unit_price", { precision: 20, scale: 6 }).notNull().default("0"),
    taxAmount: decimal("tax_amount", { precision: 20, scale: 6 }).notNull().default("0"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index("retail_pos_return_items_company_idx").on(t.companyId),
    returnIdx: index("retail_pos_return_items_return_idx").on(t.returnId),
    saleItemIdx: index("retail_pos_return_items_sale_item_idx").on(t.saleItemId),
  })
);

export const RETAIL_PAYMENT_METHODS = ["cash", "card", "bank", "mobile", "other"] as const;
export type RetailPaymentMethod = (typeof RETAIL_PAYMENT_METHODS)[number];

export const retailPosPayments = pgTable(
  "retail_pos_payments",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    saleId: integer("sale_id")
      .notNull()
      .references(() => retailPosSales.id, { onDelete: "cascade" }),
    locationId: integer("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "restrict" }),
    shiftId: integer("shift_id").references(() => posShifts.id, { onDelete: "set null" }),
    paymentType: varchar("payment_type", { length: 20 }).notNull().default("payment"),
    method: varchar("method", { length: 20 }).notNull(),
    amount: decimal("amount", { precision: 20, scale: 6 }).notNull(),
    tenderedAmount: decimal("tendered_amount", { precision: 20, scale: 6 }),
    changeAmount: decimal("change_amount", { precision: 20, scale: 6 }).notNull().default("0"),
    reference: varchar("reference", { length: 191 }),
    ledgerAccountId: integer("ledger_account_id").references(() => ledgerAccounts.id, { onDelete: "restrict" }),
    bankAccountId: integer("bank_account_id").references(() => bankAccounts.id, { onDelete: "restrict" }),
    relatedPaymentId: integer("related_payment_id"),
    idempotencyKey: varchar("idempotency_key", { length: 191 }).notNull(),
    createdBy: varchar("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index("retail_pos_payments_company_idx").on(t.companyId),
    saleIdx: index("retail_pos_payments_sale_idx").on(t.saleId),
    shiftIdx: index("retail_pos_payments_shift_idx").on(t.shiftId),
    companyIdempotencyUnique: uniqueIndex("retail_pos_payments_company_idempotency_unique").on(
      t.companyId,
      t.idempotencyKey
    ),
  })
);

export const retailCashMovements = pgTable(
  "retail_cash_movements",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    locationId: integer("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "restrict" }),
    shiftId: integer("shift_id")
      .notNull()
      .references(() => posShifts.id, { onDelete: "cascade" }),
    movementType: varchar("movement_type", { length: 20 }).notNull(),
    amount: decimal("amount", { precision: 20, scale: 6 }).notNull(),
    reason: text("reason").notNull(),
    /** Wave 17 D: the reason code that chooses the counter-account (null before the wave). */
    reasonCode: varchar("reason_code", { length: 40 }),
    /** Wave 17 D: the movement's journal (RETAIL-CASH-{id}); null before the wave. */
    voucherId: integer("voucher_id"),
    idempotencyKey: varchar("idempotency_key", { length: 191 }).notNull(),
    createdBy: varchar("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    shiftIdx: index("retail_cash_movements_shift_idx").on(t.shiftId),
    companyIdempotencyUnique: uniqueIndex("retail_cash_movements_company_idempotency_unique").on(
      t.companyId,
      t.idempotencyKey
    ),
  })
);

export const retailAccountingSettings = pgTable(
  "retail_accounting_settings",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    locationId: integer("location_id").references(() => locations.id, { onDelete: "cascade" }),
    cashLedgerAccountId: integer("cash_ledger_account_id").references(() => ledgerAccounts.id, {
      onDelete: "restrict",
    }),
    cardLedgerAccountId: integer("card_ledger_account_id").references(() => ledgerAccounts.id, {
      onDelete: "restrict",
    }),
    bankLedgerAccountId: integer("bank_ledger_account_id").references(() => ledgerAccounts.id, {
      onDelete: "restrict",
    }),
    bankAccountId: integer("bank_account_id").references(() => bankAccounts.id, { onDelete: "restrict" }),
    mobileLedgerAccountId: integer("mobile_ledger_account_id").references(() => ledgerAccounts.id, {
      onDelete: "restrict",
    }),
    otherLedgerAccountId: integer("other_ledger_account_id").references(() => ledgerAccounts.id, {
      onDelete: "restrict",
    }),
    salesRevenueLedgerAccountId: integer("sales_revenue_ledger_account_id").references(() => ledgerAccounts.id, {
      onDelete: "restrict",
    }),
    inventoryAssetLedgerAccountId: integer("inventory_asset_ledger_account_id").references(() => ledgerAccounts.id, {
      onDelete: "restrict",
    }),
    cogsLedgerAccountId: integer("cogs_ledger_account_id").references(() => ledgerAccounts.id, {
      onDelete: "restrict",
    }),
    discountsLedgerAccountId: integer("discounts_ledger_account_id").references(() => ledgerAccounts.id, {
      onDelete: "restrict",
    }),
    taxPayableLedgerAccountId: integer("tax_payable_ledger_account_id").references(() => ledgerAccounts.id, {
      onDelete: "restrict",
    }),
    storeCreditLedgerAccountId: integer("store_credit_ledger_account_id").references(() => ledgerAccounts.id, {
      onDelete: "restrict",
    }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index("retail_accounting_settings_company_idx").on(t.companyId),
    companyLocationUnique: uniqueIndex("retail_accounting_settings_company_location_unique")
      .on(t.companyId, t.locationId)
      .where(sql`${t.locationId} IS NOT NULL`),
    companyDefaultUnique: uniqueIndex("retail_accounting_settings_company_default_unique")
      .on(t.companyId)
      .where(sql`${t.locationId} IS NULL`),
  })
);

/**
 * Retail cash movement reason code -> counter-account (wave 17 D). A movement
 * posts its shift's cash account against the reason's account; a reason with
 * no row (or a row naming no account) is refused until it is mapped.
 */
export const retailCashReasonAccounts = pgTable(
  "retail_cash_reason_accounts",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    reasonCode: varchar("reason_code", { length: 40 }).notNull(),
    ledgerAccountId: integer("ledger_account_id").references(() => ledgerAccounts.id, { onDelete: "restrict" }),
    bankAccountId: integer("bank_account_id").references(() => bankAccounts.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    companyReasonUnique: uniqueIndex("retail_cash_reason_accounts_company_reason_unique").on(t.companyId, t.reasonCode),
  })
);

/** The applied Retail inventory opening of a company (wave 17 D): one row per company. */
export const retailInventoryOpenings = pgTable(
  "retail_inventory_openings",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    openingDate: date("opening_date").notNull(),
    voucherId: integer("voucher_id"),
    subLedgerValue: decimal("sub_ledger_value", { precision: 20, scale: 2 }).notNull(),
    ledgerBalanceBefore: decimal("ledger_balance_before", { precision: 20, scale: 2 }).notNull(),
    amount: decimal("amount", { precision: 20, scale: 2 }).notNull(),
    planHash: varchar("plan_hash", { length: 64 }).notNull(),
    appliedBy: varchar("applied_by").notNull(),
    appliedAt: timestamp("applied_at").notNull().defaultNow(),
  },
  (t) => ({
    companyUnique: uniqueIndex("retail_inventory_openings_company_unique").on(t.companyId),
  })
);

export const retailStockOperations = pgTable(
  "retail_stock_operations",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    operationType: varchar("operation_type", { length: 40 }).notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 191 }).notNull(),
    referenceId: varchar("reference_id", { length: 191 }),
    createdBy: varchar("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index("retail_stock_operations_company_idx").on(t.companyId),
    companyIdempotencyUnique: uniqueIndex("retail_stock_operations_company_idempotency_unique").on(
      t.companyId,
      t.idempotencyKey
    ),
  })
);

export const retailStockMovements = pgTable(
  "retail_stock_movements",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    variantId: integer("variant_id")
      .notNull()
      .references(() => retailProductVariants.id, { onDelete: "restrict" }),
    locationId: integer("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "restrict" }),
    movementType: varchar("movement_type", { length: 40 }).notNull(),
    quantityDelta: decimal("quantity_delta", { precision: 20, scale: 6 }).notNull(),
    quantityBefore: decimal("quantity_before", { precision: 20, scale: 6 }).notNull(),
    quantityAfter: decimal("quantity_after", { precision: 20, scale: 6 }).notNull(),
    eventKey: varchar("event_key", { length: 255 }).notNull(),
    referenceType: varchar("reference_type", { length: 40 }),
    referenceId: varchar("reference_id", { length: 191 }),
    createdBy: varchar("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index("retail_stock_movements_company_idx").on(t.companyId),
    variantIdx: index("retail_stock_movements_variant_idx").on(t.variantId),
    locationIdx: index("retail_stock_movements_location_idx").on(t.locationId),
    createdAtIdx: index("retail_stock_movements_created_at_idx").on(t.createdAt),
    companyEventUnique: uniqueIndex("retail_stock_movements_company_event_unique").on(t.companyId, t.eventKey),
  })
);

export type RetailPosSale = typeof retailPosSales.$inferSelect;
export type RetailPosSaleItem = typeof retailPosSaleItems.$inferSelect;
export type RetailPosReturn = typeof retailPosReturns.$inferSelect;
export type RetailPosPayment = typeof retailPosPayments.$inferSelect;
export type RetailCashMovement = typeof retailCashMovements.$inferSelect;
export type RetailAccountingSetting = typeof retailAccountingSettings.$inferSelect;
export type RetailStockMovement = typeof retailStockMovements.$inferSelect;
export type RetailCashReasonAccount = typeof retailCashReasonAccounts.$inferSelect;
export type RetailInventoryOpening = typeof retailInventoryOpenings.$inferSelect;
