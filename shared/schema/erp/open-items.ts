import { sql } from "drizzle-orm";
import { check, date, index, integer, numeric, pgTable, serial, text, timestamp, varchar } from "drizzle-orm/pg-core";

import { companies } from "../common";
import { vouchers } from "./vouchers";

/**
 * Open-item allocations (accounting audit phase 25, AR-4).
 *
 * One row settles part of an item that raised what a party owes (or what we
 * owe it) — the "invoice" side: a customer's debit, a supplier's, factory
 * supplier's or employee's credit — with part of an item on the other side —
 * a receipt, payment, credit note, debit note or advance. Items are the
 * party's posted vouchers, netted per voucher on the balance engine's line
 * ownership (services/accounting/allocations/openItems.ts); a NULL voucher id
 * is the party's master opening on that side.
 *
 * Rows are never updated except to release them: a manual re-allocation or a
 * source that changed (deleted, reversed, edited down) sets released_at and
 * the reason, and new rows are inserted. Amounts are book amounts (the
 * ledger's debit_amount / credit_amount, owner decision AR-3) in the
 * company's base currency.
 */
export const partyOpenItemAllocations = pgTable(
  "party_open_item_allocations",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    partyKind: varchar("party_kind", { length: 20 }).notNull(),
    partyId: integer("party_id").notNull(),
    // CASCADE: the allocation is derived from the two vouchers; a voucher is
    // only hard-deleted by the permanent-delete / cleanup tools.
    invoiceVoucherId: integer("invoice_voucher_id").references(() => vouchers.id, { onDelete: "cascade" }),
    paymentVoucherId: integer("payment_voucher_id").references(() => vouchers.id, { onDelete: "cascade" }),
    amount: numeric("amount", { precision: 20, scale: 2 }).notNull(),
    currency: varchar("currency", { length: 3 }).notNull().default("USD"),
    method: varchar("method", { length: 20 }).notNull(),
    reason: text("reason"),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    releasedBy: text("released_by"),
    releaseReason: text("release_reason"),
  },
  (t) => ({
    partyIdx: index("party_open_item_allocations_party_idx").on(t.companyId, t.partyKind, t.partyId),
    invoiceIdx: index("party_open_item_allocations_invoice_idx").on(t.invoiceVoucherId),
    paymentIdx: index("party_open_item_allocations_payment_idx").on(t.paymentVoucherId),
    amountPositive: check("party_open_item_allocations_amount_positive", sql`${t.amount} > 0`),
    kindValid: check(
      "party_open_item_allocations_kind_valid",
      sql`${t.partyKind} IN ('customer', 'supplier', 'employee', 'factorySupplier')`
    ),
    methodValid: check("party_open_item_allocations_method_valid", sql`${t.method} IN ('auto_fifo', 'manual', 'note')`),
    sidesDiffer: check(
      "party_open_item_allocations_sides_differ",
      sql`${t.invoiceVoucherId} IS DISTINCT FROM ${t.paymentVoucherId}`
    ),
  })
);

export type PartyOpenItemAllocation = typeof partyOpenItemAllocations.$inferSelect;

/**
 * Integration review (phases 23–29): a company's automatic allocation run (and
 * the realized FX it posts) is enabled by its Owner's reviewed first run; one
 * row per enabled company (services/accounting/allocations/allocationEnablement.ts).
 */
export const openItemAllocationEnablements = pgTable("open_item_allocation_enablements", {
  companyId: integer("company_id")
    .primaryKey()
    .references(() => companies.id, { onDelete: "cascade" }),
  enabledAt: timestamp("enabled_at", { withTimezone: true }).notNull().defaultNow(),
  enabledOn: date("enabled_on").notNull(),
  enabledBy: text("enabled_by").notNull(),
  planHash: text("plan_hash").notNull(),
});
