/**
 * Shared helper for building the unified transaction list for a factory customer's
 * ledger account.
 *
 * The factory Customers page balance is the union of:
 *   - finalized customer orders (treated as SALE / invoice debits)
 *   - non-INVOICE customerBalances rows (manual adjustments, quick-payments)
 *   - voucherEntries linked to the ledger account (excluding CHARGE-/INV-/SALE- system vouchers)
 *   - voucherEntries linked directly to the customerId (excluding CHARGE-/INV-/SALE-)
 *
 * The ledger Transactions list and the Account-Statement PDF must use the same
 * source so the running balance reconciles with the figure the user sees on the
 * Customers page.
 */

import { db } from "../db";
import { customers, customerOrders, customerBalances, vouchers, voucherEntries } from "@shared/schema";
import { eq, and, sql } from "drizzle-orm";
import type Decimal from "decimal.js";
import { sumMoney } from "./money";

export interface FactoryCustomerLedgerEntry {
  id: string;
  voucherId: number;
  voucherNumber: string;
  voucherType: string;
  voucherDate: string;
  voucherDescription: string;
  narration: string;
  debitAmount: string;
  creditAmount: string;
}

/**
 * Look up whether a ledger account is linked to a customer.
 * Returns the customer's id + companyId, or null.
 */
export async function getCustomerByLedgerId(
  ledgerAccountId: number
): Promise<{ id: number; companyId: number } | null> {
  const [row] = await db
    .select({ id: customers.id, companyId: customers.companyId })
    .from(customers)
    .where(eq(customers.ledgerAccountId, ledgerAccountId))
    .limit(1);
  return row ?? null;
}

/**
 * Build the unified ledger entry list for a factory customer.
 * Sorted by voucherDate ASC then a stable secondary key.
 */
export async function buildFactoryCustomerLedgerEntries(
  customerId: number,
  ledgerAccountId: number | null,
  companyId: number,
  startDate?: string,
  endDate?: string
): Promise<FactoryCustomerLedgerEntry[]> {
  // ── 1. Finalized customer orders → SALE-style debit entries
  const orderRows = await db
    .select({
      id: customerOrders.id,
      invoiceNumber: customerOrders.invoiceNumber,
      orderDate: customerOrders.orderDate,
      grandTotal: customerOrders.grandTotal,
      destination: customerOrders.destination,
    })
    .from(customerOrders)
    .where(
      and(
        eq(customerOrders.companyId, companyId),
        eq(customerOrders.customerId, customerId),
        eq(customerOrders.status, "FINALIZED")
      )
    );

  const out: FactoryCustomerLedgerEntry[] = [];

  for (const o of orderRows) {
    const dt = o.orderDate?.toString?.() ?? String(o.orderDate ?? "");
    if (startDate && dt < startDate) continue;
    if (endDate && dt > endDate) continue;
    out.push({
      id: `co-${o.id}`,
      voucherId: -1000000 - o.id, // synthetic, negative to avoid colliding with real voucherIds
      voucherNumber: o.invoiceNumber || `INV-${o.id}`,
      voucherType: "Sales",
      voucherDate: dt,
      voucherDescription: o.destination ? `Invoice — ${o.destination}` : "Invoice",
      narration: o.destination ? `Invoice — ${o.destination}` : "Invoice",
      debitAmount: o.grandTotal ?? "0",
      creditAmount: "0",
    });
  }

  // ── 2. customerBalances NON-INVOICE rows → ADJ entries
  const balRows = await db
    .select()
    .from(customerBalances)
    .where(
      and(
        eq(customerBalances.companyId, companyId),
        eq(customerBalances.customerId, customerId),
        sql`${customerBalances.referenceType} <> 'INVOICE' OR ${customerBalances.referenceType} IS NULL`
      )
    );

  for (const b of balRows) {
    const dt = b.transactionDate?.toString?.() ?? String(b.transactionDate ?? "");
    if (startDate && dt < startDate) continue;
    if (endDate && dt > endDate) continue;
    out.push({
      id: `cb-${b.id}`,
      voucherId: -2000000 - b.id, // synthetic
      voucherNumber: b.referenceType ? `${b.referenceType}-${b.referenceId ?? b.id}` : `CB-${b.id}`,
      voucherType: b.transactionType || "Payment",
      voucherDate: dt,
      voucherDescription: b.description || "",
      narration: b.description || "",
      debitAmount: b.debitAmount ?? "0",
      creditAmount: b.creditAmount ?? "0",
    });
  }

  // ── 3. voucherEntries linked to this ledger or customer
  //
  // This MUST mirror the canonical Customers-page formula in
  // /api/accounts/all and /api/accounts/ledger/:id/balance EXACTLY:
  //   - exclude only `CHARGE-%` voucher numbers (other prefixes are real txns)
  //   - exclude `optional = true` and soft-deleted vouchers
  //   - L1 = ledgerAccountId = X
  //   - L2 = customerId = Y AND ledgerAccountId IS NULL
  //   - Final = L1 ∪ L2
  //
  // The asymmetric predicate (customerId branch requires ledgerAccountId IS
  // NULL) is critical: a stray legacy row with customerId = Y and
  // ledgerAccountId = Z (some OTHER ledger) must NOT be counted here. The
  // canonical formula excludes it by construction; we must too.
  const ledgerExpr = ledgerAccountId
    ? sql`(
        ${voucherEntries.ledgerAccountId} = ${ledgerAccountId}
        OR (${voucherEntries.customerId} = ${customerId}
            AND ${voucherEntries.ledgerAccountId} IS NULL)
      )`
    : sql`${voucherEntries.customerId} = ${customerId}`;

  const dateFilters = [];
  if (startDate) dateFilters.push(sql`${vouchers.voucherDate} >= ${startDate}`);
  if (endDate) dateFilters.push(sql`${vouchers.voucherDate} <= ${endDate}`);

  const voucherRows = await db
    .select({
      id: voucherEntries.id,
      voucherId: voucherEntries.voucherId,
      voucherNumber: vouchers.voucherNumber,
      voucherType: vouchers.voucherType,
      voucherDate: vouchers.voucherDate,
      description: vouchers.description,
      narration: voucherEntries.narration,
      debitAmount: voucherEntries.debitAmount,
      creditAmount: voucherEntries.creditAmount,
    })
    .from(voucherEntries)
    .innerJoin(
      vouchers,
      and(
        eq(voucherEntries.voucherId, vouchers.id),
        eq(vouchers.companyId, companyId),
        eq(vouchers.optional, false),
        sql`${vouchers.deletedAt} IS NULL`,
        sql`${vouchers.voucherNumber} NOT LIKE 'CHARGE-%'`,
        ...dateFilters
      )
    )
    .where(ledgerExpr);

  for (const v of voucherRows) {
    out.push({
      id: `ve-${v.id}`,
      voucherId: v.voucherId as number,
      voucherNumber: v.voucherNumber || "",
      voucherType: v.voucherType || "Voucher",
      voucherDate: v.voucherDate?.toString?.() ?? String(v.voucherDate ?? ""),
      voucherDescription: v.description || "",
      narration: v.narration || v.description || "",
      debitAmount: v.debitAmount ?? "0",
      creditAmount: v.creditAmount ?? "0",
    });
  }

  // ── Sort by date asc, then voucherNumber for stability
  out.sort((a, b) => {
    if (a.voucherDate < b.voucherDate) return -1;
    if (a.voucherDate > b.voucherDate) return 1;
    return a.voucherNumber.localeCompare(b.voucherNumber);
  });

  return out;
}

/**
 * Sum of pre-period debits/credits for a factory-customer ledger.
 * Mirrors buildFactoryCustomerLedgerEntries but only for entries strictly
 * before `startDate`.
 */
export async function getFactoryCustomerLedgerPrePeriodTotals(
  customerId: number,
  ledgerAccountId: number | null,
  companyId: number,
  startDate: string
): Promise<{ debit: Decimal; credit: Decimal }> {
  const entries = await buildFactoryCustomerLedgerEntries(customerId, ledgerAccountId, companyId, undefined, undefined);
  const prior = entries.filter((e) => e.voucherDate < startDate);
  return {
    debit: sumMoney(prior.map((e) => e.debitAmount)),
    credit: sumMoney(prior.map((e) => e.creditAmount)),
  };
}
