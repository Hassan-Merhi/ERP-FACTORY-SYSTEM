// Extracted from ./centralJournalLifecycleRoute.ts to keep that module under the source-size cap.
import { and, eq, sql } from "drizzle-orm";
import { customerBalances, customerOrderCharges, customerOrders } from "@shared/schema";
import type { DbTransaction } from "../../db";
import { writeAuditEvent } from "../../services/audit";
import { createDatabasePostingDependencies } from "../../services/accounting/databasePostingDependencies";
import { recalculateOrderTotals } from "../factory/_helpers";
import { toMoney } from "../../lib/money";

export const postingDependencies = createDatabasePostingDependencies();

/**
 * Wave 18 (B): the order charge a journal line pays and the order's invoice
 * balance follow the edit inside the edit's transaction (a failure rolls the
 * edit back; nothing is swallowed), in exact decimals, audited.
 */
export async function syncJournalToOrderChargeTx(
  tx: DbTransaction,
  companyId: number,
  savedEntries: Array<{
    customerId: number | null;
    ledgerAccountId: number | null;
    debitAmount: string | null;
    creditAmount: string | null;
  }>,
  voucherId: number,
  actor: { userId?: string | null; username?: string | null }
): Promise<void> {
  const customerEntry = savedEntries.find((entry) => entry.customerId !== null);
  if (!customerEntry) return;

  const ledgerCreditEntries = savedEntries.filter(
    (entry) => entry.ledgerAccountId !== null && entry.customerId === null && toMoney(entry.creditAmount).gt(0)
  );

  for (const ledgerEntry of ledgerCreditEntries) {
    const newAmount = toMoney(ledgerEntry.creditAmount).toDecimalPlaces(2);
    if (!newAmount.gt(0)) continue;

    let matchingCharges: Array<{
      id: number;
      orderId: number;
      amount: string;
      chargeType: string;
      voucherId: number | null;
    }> = await tx
      .select({
        id: customerOrderCharges.id,
        orderId: customerOrderCharges.orderId,
        amount: customerOrderCharges.amount,
        chargeType: customerOrderCharges.chargeType,
        voucherId: customerOrderCharges.voucherId,
      })
      .from(customerOrderCharges)
      .innerJoin(
        customerOrders,
        and(eq(customerOrderCharges.orderId, customerOrders.id), eq(customerOrders.companyId, companyId))
      )
      .where(
        and(
          eq(customerOrderCharges.voucherId, voucherId),
          eq(customerOrderCharges.ledgerAccountId, ledgerEntry.ledgerAccountId!)
        )
      );

    if (matchingCharges.length === 0) {
      const byLedger = await tx
        .select({
          id: customerOrderCharges.id,
          orderId: customerOrderCharges.orderId,
          amount: customerOrderCharges.amount,
          chargeType: customerOrderCharges.chargeType,
          voucherId: customerOrderCharges.voucherId,
        })
        .from(customerOrderCharges)
        .innerJoin(
          customerOrders,
          and(
            eq(customerOrderCharges.orderId, customerOrders.id),
            eq(customerOrders.customerId, customerEntry.customerId!),
            eq(customerOrders.companyId, companyId)
          )
        )
        .where(
          and(
            eq(customerOrderCharges.ledgerAccountId, ledgerEntry.ledgerAccountId!),
            sql`${customerOrderCharges.voucherId} IS NULL`
          )
        );

      if (byLedger.length === 1) matchingCharges = byLedger;
    }

    if (matchingCharges.length === 0) continue;
    const charge = matchingCharges[0];
    const amountChanged = !toMoney(charge.amount).equals(newAmount);
    if (!amountChanged && charge.voucherId === voucherId) continue;

    await tx
      .update(customerOrderCharges)
      .set({ amount: newAmount.toFixed(2), voucherId })
      .where(eq(customerOrderCharges.id, charge.id));

    const auditActor = {
      userId: actor.userId ?? "unknown",
      username: actor.username || "unknown",
      companyId,
    };
    await writeAuditEvent(
      {
        ...auditActor,
        action: "update",
        tableName: "customer_order_charges",
        recordId: charge.id,
        recordIdentifier: charge.chargeType,
        changes: {
          amount: { old: charge.amount, new: newAmount.toFixed(2) },
          voucherId: { old: charge.voucherId, new: voucherId },
          syncedFromJournal: { new: voucherId },
        },
      },
      tx
    );

    if (!amountChanged) continue;
    await recalculateOrderTotals(tx, charge.orderId);

    const [updatedOrder] = await tx
      .select({ grandTotal: customerOrders.grandTotal })
      .from(customerOrders)
      .where(eq(customerOrders.id, charge.orderId));

    if (updatedOrder) {
      const balanceRows = await tx
        .update(customerBalances)
        .set({ debitAmount: updatedOrder.grandTotal, balance: updatedOrder.grandTotal })
        .where(
          and(
            eq(customerBalances.companyId, companyId),
            eq(customerBalances.referenceId, charge.orderId),
            eq(customerBalances.referenceType, "INVOICE")
          )
        )
        .returning({ id: customerBalances.id });
      for (const row of balanceRows) {
        await writeAuditEvent(
          {
            ...auditActor,
            action: "update",
            tableName: "customer_balances",
            recordId: row.id,
            recordIdentifier: `order:${charge.orderId}`,
            changes: {
              debitAmount: { new: updatedOrder.grandTotal },
              balance: { new: updatedOrder.grandTotal },
              syncedFromJournal: { new: voucherId },
            },
          },
          tx
        );
      }
    }
  }
}
