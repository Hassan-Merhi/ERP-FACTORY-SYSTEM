// Extracted from ./delete.ts
import { type VoucherRetirementActor } from "../../services/accounting/voucherRetirement";
import { type DbTransaction } from "../../db";
import { writeAuditEvent } from "../../services/audit";
import { storage } from "../../storage";
import { buildVoucherChangesForDelete } from "../_helpers";
import { vouchers, voucherEntries, interCompanyTransfers } from "@shared/schema";
import { eq } from "drizzle-orm";

type InterCompanyTransferRow = typeof interCompanyTransfers.$inferSelect;

/**
 * Wave 9 (ledger safety): deleting one side of an inter-company transfer takes
 * the other company's side out of the books by soft delete — deleted_at set,
 * lines kept, exactly like the voucher being deleted — never by hard delete.
 * The counterpart's audit row is written in the same transaction, under the
 * counterpart's company. The transfer link row is still removed, as before; the
 * audit row keeps a copy of it.
 */
export async function softDeleteInterCompanyCounterpartTx(
  tx: DbTransaction,
  params: {
    transfer: InterCompanyTransferRow;
    voucherId: number;
    voucherNumber: string;
    actor: { userId?: string | null; username?: string | null };
  }
): Promise<void> {
  const { transfer, voucherId } = params;
  const otherVoucherId = transfer.fromVoucherId === voucherId ? transfer.toVoucherId : transfer.fromVoucherId;
  if (!otherVoucherId || otherVoucherId === voucherId) return;

  const [counterpart] = await tx.select().from(vouchers).where(eq(vouchers.id, otherVoucherId));
  if (!counterpart || counterpart.deletedAt) return;

  const deletedAt = new Date();
  await tx.update(vouchers).set({ deletedAt }).where(eq(vouchers.id, otherVoucherId));

  const entries = await tx
    .select({
      ledgerAccountId: voucherEntries.ledgerAccountId,
      bankAccountId: voucherEntries.bankAccountId,
      supplierId: voucherEntries.supplierId,
      customerId: voucherEntries.customerId,
      employeeId: voucherEntries.employeeId,
      debitAmount: voucherEntries.debitAmount,
      creditAmount: voucherEntries.creditAmount,
      narration: voucherEntries.narration,
    })
    .from(voucherEntries)
    .where(eq(voucherEntries.voucherId, otherVoucherId));

  await writeAuditEvent(
    {
      userId: params.actor.userId ?? "unknown",
      username: params.actor.username || "unknown",
      companyId: counterpart.companyId,
      action: "delete",
      tableName: "vouchers",
      recordId: otherVoucherId,
      recordIdentifier: counterpart.voucherNumber,
      changes: {
        ...buildVoucherChangesForDelete(counterpart, entries),
        deletedAt: { old: null, new: deletedAt },
        interCompanyCounterpartOf: { old: { voucherId, voucherNumber: params.voucherNumber } },
        interCompanyTransfer: { old: transfer },
      },
    },
    tx
  );
}

export interface DeleteVoucherInput {
  companyId: number;
  voucher: NonNullable<Awaited<ReturnType<typeof storage.getVoucherById>>>;
  occurredAt: string;
  asOfDate: string;
  actor: { userId: string | undefined; username: string | undefined };
  retirementActor: VoucherRetirementActor;
}
