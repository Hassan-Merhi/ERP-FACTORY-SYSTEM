/**
 * Reverse offload: the container's pre-offload freight voucher (accounting
 * audit wave 17 D, owner decision 1 of 2026-10-09).
 *
 * The offload retires (wave 16 A) the creation-time `FACTORY-FREIGHT-{id}`
 * voucher before it posts its own freight journal. Reversing the offload
 * reverses exactly what was posted: the offload's journals are retired as
 * they are, and the voucher the offload retired is restored as it was — the
 * same voucher, number and lines, legacy-shaped or normalized. No line is
 * re-written or converted to another rate. Only when there is no such voucher
 * (an offload before wave 16 A hard-deleted it) does the reversal post a new
 * one, normalized at the factory rate rule (`factoryDocumentRate`).
 */
import { and, desc, eq, isNotNull, like, sql } from "drizzle-orm";

import { vouchers } from "@shared/schema";

import type { DbTransaction } from "../../db";
import { toMoney } from "../../lib/money";
import { writeAuditEvent } from "../audit";
import { RETIRED_VOUCHER_NUMBER_MARK, type VoucherRetirementActor } from "../accounting/voucherRetirement";

export const preOffloadFreightVoucherNumber = (containerId: number) => `FACTORY-FREIGHT-${containerId}`;

/**
 * Restores the pre-offload freight voucher the offload retired, when it is the
 * one the container's snapshot describes: the latest retired
 * `FACTORY-FREIGHT-{id}~DEL…` voucher in that currency for that amount, with a
 * debit line on the freight account, and no live voucher holding the number.
 * Its deleted_at is cleared and its number given back; its lines are not
 * touched. Audited in the transaction. Returns its id, or null.
 */
export async function restoreRetiredPreOffloadFreightTx(
  tx: DbTransaction,
  params: {
    companyId: number;
    containerId: number;
    currency: string;
    amount: string;
    freightAccountId: number;
    actor: VoucherRetirementActor;
  }
): Promise<number | null> {
  const number = preOffloadFreightVoucherNumber(params.containerId);
  const [live] = await tx
    .select({ id: vouchers.id })
    .from(vouchers)
    .where(and(eq(vouchers.companyId, params.companyId), eq(vouchers.voucherNumber, number)))
    .limit(1);
  if (live) return null;

  const [retired] = await tx
    .select()
    .from(vouchers)
    .where(
      and(
        eq(vouchers.companyId, params.companyId),
        eq(vouchers.sourceModule, "FACTORY"),
        like(vouchers.voucherNumber, `${number}${RETIRED_VOUCHER_NUMBER_MARK}%`),
        isNotNull(vouchers.deletedAt)
      )
    )
    .orderBy(desc(vouchers.id))
    .limit(1)
    .for("update");
  if (!retired) return null;
  if (
    String(retired.currency || "USD").toUpperCase() !== params.currency.toUpperCase() ||
    !toMoney(retired.totalAmount).eq(toMoney(params.amount))
  ) {
    return null;
  }
  const freightLine = await tx.execute(
    sql`SELECT 1 FROM voucher_entries
         WHERE voucher_id = ${retired.id} AND ledger_account_id = ${params.freightAccountId}
           AND debit_amount::numeric > 0
         LIMIT 1`
  );
  if (freightLine.rows.length === 0) return null;

  await tx
    .update(vouchers)
    .set({ deletedAt: null, voucherNumber: number })
    .where(and(eq(vouchers.id, retired.id), eq(vouchers.companyId, params.companyId)));
  await writeAuditEvent(
    {
      userId: params.actor.userId,
      username: params.actor.username,
      companyId: params.companyId,
      action: "restore",
      tableName: "vouchers",
      recordId: retired.id,
      recordIdentifier: number,
      changes: {
        deletedAt: { old: retired.deletedAt, new: null },
        voucherNumber: { old: retired.voucherNumber, new: number },
        reason: { new: "factory-raw-stock-offload-reverse: pre-offload freight voucher restored as posted" },
        containerId: { new: params.containerId },
      },
    },
    tx
  );
  return retired.id;
}
