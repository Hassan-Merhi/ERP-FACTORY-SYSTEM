/**
 * The ledger side of factory order charges and order re-pricing (accounting
 * audit phase 22 C: D2, PE8, G4, F13/PE10, DI7).
 *
 * Before: the charge routes and the pricing routes wrote the charge voucher
 * with `Date.now()` numbers outside the engine, rewrote `customer_balances`
 * and the daybook without a lock, and synced the invoice journal in a second
 * transaction after their own commit (a refused sync left the order changed).
 *
 * Now, inside the route's one transaction:
 *  - `lockCustomerOrderTx` locks the order row FOR UPDATE before it is read,
 *    so two edits of one order serialize instead of losing an update;
 *  - `postOrderChargeVoucherTx` posts the charge voucher through the engine
 *    with the charge's posting identity (one voucher per charge; a replay
 *    returns it) and stamps the charge's voucher link;
 *  - `setChargeVoucherAmountTx` changes a posted charge voucher's amount as an
 *    audited open-period edit (409 in a closed period: reverse and re-post);
 *  - `syncOrderTotalsTx` moves the invoice's `customer_balances` row (locked)
 *    and its daybook row to the order's new grand total, then re-posts the
 *    invoice journal (syncFactoryInvoiceTx) — all in the same transaction.
 *
 * Charge voucher numbers keep the CHARGE- family (read by unfinalize, charge
 * delete and the voucher transfer editor, which parses the charge id from
 * `CHARGE-{ref}-{chargeId}-{n}`) with a deterministic last segment (was
 * Date.now()).
 */
import { and, eq, sql } from "drizzle-orm";
import {
  customerBalances,
  customerOrderCharges,
  customerOrders,
  factoryDaybookEntries,
  voucherEntries,
  vouchers,
} from "@shared/schema";

import type { DbTransaction } from "../../../db";
import { moneyString, toMoney, type MoneyInput } from "../../../lib/money";
import { syncFactoryInvoiceTx } from "../../../services/accounting/perpetualInventory/factoryInvoice";
import {
  editPostedFactoryVoucherTx,
  type FactoryVoucherEditActor,
} from "../../../services/factory/factoryVoucherCorrection";
import { normFactoryEntry } from "../../../services/factory/factoryVoucherEntryAmounts";
import { postFactoryVoucherTx } from "../../../services/factory/factoryVoucherPosting";

export const ORDER_CHARGE_SOURCE = "factory-order-charge";

/** The order row, locked FOR UPDATE in `tx` (DI7), or undefined. */
export async function lockCustomerOrderTx(tx: DbTransaction, companyId: number, orderId: number) {
  await tx.execute(sql`SELECT id FROM customer_orders WHERE id = ${orderId} AND company_id = ${companyId} FOR UPDATE`);
  const [order] = await tx
    .select()
    .from(customerOrders)
    .where(and(eq(customerOrders.id, orderId), eq(customerOrders.companyId, companyId)));
  return order;
}

/** The finalized-invoice number of a charge voucher (deterministic per charge). */
export const finalizedChargeVoucherNumber = (invoiceRef: string, chargeId: number) =>
  `CHARGE-${invoiceRef}-${chargeId}-1`;
/** The pre-finalization charge voucher number (renamed at finalize). */
export const preChargeVoucherNumber = (orderId: number, chargeId: number) => `CHARGE-PRE-${orderId}-${chargeId}`;

/**
 * Post one order charge's voucher (Dr the customer's ledger with the customer
 * as party / Cr the charge account) through the engine and link it to the
 * charge. Returns the voucher id.
 */
export async function postOrderChargeVoucherTx(
  tx: DbTransaction,
  input: {
    companyId: number;
    chargeId: number;
    voucherNumber: string;
    voucherDate: string;
    description: string;
    customerId: number;
    customerLedgerAccountId: number;
    chargeLedgerAccountId: number;
    amount: MoneyInput;
  }
): Promise<number> {
  const amount = toMoney(input.amount).toDecimalPlaces(2);
  const { voucher } = await postFactoryVoucherTx(tx, {
    companyId: input.companyId,
    voucherNumber: input.voucherNumber,
    voucherDate: input.voucherDate,
    description: input.description,
    source: { sourceType: ORDER_CHARGE_SOURCE, sourceId: input.chargeId, phase: "voucher" },
    lines: [
      {
        ledgerAccountId: input.customerLedgerAccountId,
        customerId: input.customerId,
        debit: amount,
        narration: input.description,
      },
      { ledgerAccountId: input.chargeLedgerAccountId, credit: amount, narration: input.description },
    ],
  });
  await tx
    .update(customerOrderCharges)
    .set({ voucherId: voucher.id })
    .where(eq(customerOrderCharges.id, input.chargeId));
  return voucher.id;
}

/**
 * A posted charge voucher's new amount, as an audited open-period edit of its
 * two lines (every amount column, not only debit/credit); refused (409) in a
 * closed period.
 */
export async function setChargeVoucherAmountTx(
  tx: DbTransaction,
  input: { companyId: number; voucherId: number; amount: MoneyInput; actor?: FactoryVoucherEditActor }
): Promise<void> {
  const amount = moneyString(input.amount);
  await editPostedFactoryVoucherTx(
    tx,
    {
      companyId: input.companyId,
      voucherIds: [input.voucherId],
      reason: "factory-order-charge-amount",
      actor: input.actor,
    },
    async () => {
      await tx
        .update(vouchers)
        .set({ totalAmount: amount })
        .where(and(eq(vouchers.id, input.voucherId), eq(vouchers.companyId, input.companyId)));
      const lines = await tx.select().from(voucherEntries).where(eq(voucherEntries.voucherId, input.voucherId));
      for (const line of lines) {
        const isDebit = toMoney(line.debitAmount).greaterThan(0);
        const isCredit = toMoney(line.creditAmount).greaterThan(0);
        if (!isDebit && !isCredit) continue;
        await tx
          .update(voucherEntries)
          .set(normFactoryEntry("USD", isDebit ? amount : "0", isDebit ? "0" : amount, "1"))
          .where(eq(voucherEntries.id, line.id));
      }
    }
  );
}

/**
 * The finalized invoice's customer-balance row and daybook row follow the
 * order's grand total (VERIFIED: the ORDER_VERIFIED daybook row), and the
 * invoice journal is re-posted — inside the caller's transaction (F13).
 */
export async function syncOrderTotalsTx(
  tx: DbTransaction,
  companyId: number,
  orderId: number,
  options: { daybook?: boolean } = {}
): Promise<void> {
  const [order] = await tx
    .select({ status: customerOrders.status, grandTotal: customerOrders.grandTotal })
    .from(customerOrders)
    .where(and(eq(customerOrders.id, orderId), eq(customerOrders.companyId, companyId)));
  if (!order) return;
  const newGrandTotal = moneyString(order.grandTotal);

  if (order.status === "FINALIZED") {
    await tx.execute(sql`
      SELECT id FROM customer_balances
       WHERE company_id = ${companyId} AND reference_type = 'INVOICE' AND reference_id = ${orderId}
       FOR UPDATE
    `);
    await tx
      .update(customerBalances)
      .set({ debitAmount: newGrandTotal, balance: newGrandTotal })
      .where(
        and(
          eq(customerBalances.companyId, companyId),
          eq(customerBalances.referenceType, "INVOICE"),
          eq(customerBalances.referenceId, orderId)
        )
      );
  }
  // The charge routes keep the daybook row on the new total; re-pricing never did.
  const daybookType =
    options.daybook === false
      ? null
      : order.status === "FINALIZED"
        ? "INVOICE"
        : order.status === "VERIFIED"
          ? "ORDER_VERIFIED"
          : null;
  if (daybookType) {
    await tx
      .update(factoryDaybookEntries)
      .set({ amountCurrency: newGrandTotal, amountUsd: newGrandTotal })
      .where(
        and(
          eq(factoryDaybookEntries.companyId, companyId),
          eq(factoryDaybookEntries.txType, daybookType),
          eq(factoryDaybookEntries.referenceId, orderId)
        )
      );
  }

  // Perpetual inventory (wave 8.4): the invoice journal follows the order.
  await syncFactoryInvoiceTx(tx, companyId, orderId);
}
