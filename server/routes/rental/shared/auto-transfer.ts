import { logger } from "../../../lib/logger";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { db, type DbTransaction } from "../../../db";
import {
  ledgerAccounts,
  vouchers,
  voucherEntries,
  rentalAutoTransferConfigs,
  interCompanyTransfers,
  companies,
} from "@shared/schema";
import { eq, and, inArray, isNull } from "drizzle-orm";
import { softDeleteVoucherTx } from "../../../services/accounting/voucherSoftDelete";
import { runWithAutoTransferCounterparties } from "../../../services/rental/autoTransferScope";
import { RentalModule } from "./ledger";

/**
 * The company's TRANSFER-CLEARING account. A soft-deleted row still owns the
 * unique (company_id, code) key, so it is revived rather than duplicated.
 */
async function getOrCreateClearingTx(tx: DbTransaction, companyId: number) {
  const [account] = await tx
    .insert(ledgerAccounts)
    .values({
      companyId,
      code: "TRANSFER-CLEARING",
      name: "Transfer Clearing",
      accountType: "Equity",
      active: true,
    })
    .onConflictDoUpdate({
      target: [ledgerAccounts.companyId, ledgerAccounts.code],
      set: { active: true, deletedAt: null },
    })
    .returning();
  return account;
}

/**
 * Soft-delete both sides of every auto-transfer posted for these payments and
 * drop the links. Run inside `runWithAutoTransferCounterparties` so the
 * receiving company's voucher is in scope; under the paying company's scope
 * alone it was silently left live.
 */
export async function reverseAutoTransfersTx(tx: DbTransaction, sourcePaymentIds: readonly number[]): Promise<void> {
  if (sourcePaymentIds.length === 0) return;
  const linked = await tx
    .select()
    .from(interCompanyTransfers)
    .where(inArray(interCompanyTransfers.sourcePaymentId, [...sourcePaymentIds]));
  for (const transfer of linked) {
    // Drop the link first: it holds restrict foreign keys on both vouchers.
    await tx.delete(interCompanyTransfers).where(eq(interCompanyTransfers.id, transfer.id));
    if (transfer.fromVoucherId) await softDeleteVoucherTx(tx, transfer.fromVoucherId);
    if (transfer.toVoucherId) await softDeleteVoucherTx(tx, transfer.toVoucherId);
  }
}

export async function maybeRunAutoTransfer(
  companyId: number,
  module: RentalModule,
  fromLedgerAccountId: number,
  amount: string,
  transferDate: string,
  unitLabel: string,
  sourcePaymentId?: number,
  notes?: string
) {
  try {
    // Fetch ALL active rules for this company+module
    const configs = await db
      .select()
      .from(rentalAutoTransferConfigs)
      .where(
        and(
          eq(rentalAutoTransferConfigs.companyId, companyId),
          eq(rentalAutoTransferConfigs.module, module),
          eq(rentalAutoTransferConfigs.enabled, true)
        )
      );
    if (configs.length === 0) return;

    // Find the FIRST rule that matches the source account.
    // Rules with a specific sourceCashAccountIds list take precedence; fallback to the
    // first rule with an empty filter only when no specific rule matched.
    const specificMatch = configs.find((c) => {
      const ids = (c.sourceCashAccountIds ?? []) as number[];
      return ids.length > 0 && ids.includes(fromLedgerAccountId);
    });
    const fallbackMatch = configs.find((c) => {
      const ids = (c.sourceCashAccountIds ?? []) as number[];
      return ids.length === 0;
    });
    const cfg = specificMatch ?? fallbackMatch;
    if (!cfg) return;

    // Both sides post in one transaction, with the receiving company in scope.
    await runWithAutoTransferCounterparties([cfg.destCompanyId], () =>
      db.transaction(async (tx) => {
        // One transfer per payment: a retried or repeated call posts nothing more.
        if (sourcePaymentId) {
          const [already] = await tx
            .select({ id: interCompanyTransfers.id })
            .from(interCompanyTransfers)
            .where(eq(interCompanyTransfers.sourcePaymentId, sourcePaymentId))
            .limit(1);
          if (already) return;
        }

        const [fromCompany] = await tx.select().from(companies).where(eq(companies.id, companyId));
        const [toCompany] = await tx.select().from(companies).where(eq(companies.id, cfg.destCompanyId));
        if (!fromCompany || !toCompany) return;

        const [destAccount] = await tx
          .select({ id: ledgerAccounts.id })
          .from(ledgerAccounts)
          .where(
            and(
              eq(ledgerAccounts.id, cfg.destLedgerAccountId),
              eq(ledgerAccounts.companyId, cfg.destCompanyId),
              isNull(ledgerAccounts.deletedAt)
            )
          );
        if (!destAccount) {
          throw new Error(
            `Auto-transfer rule ${cfg.id}: account ${cfg.destLedgerAccountId} is not a live account of company ${cfg.destCompanyId}`
          );
        }

        const fromClearing = await getOrCreateClearingTx(tx, companyId);
        const toClearing = await getOrCreateClearingTx(tx, cfg.destCompanyId);
        const baseDesc = `Auto rent transfer - ${unitLabel}`;
        const desc = notes ? `${baseDesc} - ${notes}` : baseDesc;
        const txId = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

        const outNarration = notes
          ? `Transfer out to ${toCompany.name} - ${notes}`
          : `Transfer out to ${toCompany.name}`;
        const inNarration = notes
          ? `Transfer in from ${fromCompany.name} - ${notes}`
          : `Transfer in from ${fromCompany.name}`;

        // Voucher in FROM company (Payment — money leaves)
        const [fromVoucher] = await tx
          .insert(vouchers)
          .values({
            companyId,
            voucherNumber: `TR-OUT-${txId}`,
            voucherType: "Payment",
            voucherDate: transferDate,
            description: `${desc} → ${toCompany.name}`,
            totalAmount: amount,
            optional: false,
          })
          .returning();
        await tx.insert(voucherEntries).values([
          {
            voucherId: fromVoucher.id,
            ledgerAccountId: fromClearing.id,
            debitAmount: amount,
            creditAmount: "0",
            narration: outNarration,
          },
          {
            voucherId: fromVoucher.id,
            ledgerAccountId: fromLedgerAccountId,
            debitAmount: "0",
            creditAmount: amount,
            narration: outNarration,
          },
        ]);

        // Voucher in TO company (Receipt — money arrives)
        // DR destLedgerAccountId (cash/account receives money), CR toClearing (clearing settled)
        const [toVoucher] = await tx
          .insert(vouchers)
          .values({
            companyId: cfg.destCompanyId,
            voucherNumber: `TR-IN-${txId}`,
            voucherType: "Receipt",
            voucherDate: transferDate,
            description: notes ? `Transfer from ${fromCompany.name} - ${notes}` : `Transfer from ${fromCompany.name}`,
            totalAmount: amount,
            optional: false,
          })
          .returning();
        await tx.insert(voucherEntries).values([
          {
            voucherId: toVoucher.id,
            ledgerAccountId: cfg.destLedgerAccountId,
            debitAmount: amount,
            creditAmount: "0",
            narration: inNarration,
          },
          {
            voucherId: toVoucher.id,
            ledgerAccountId: toClearing.id,
            debitAmount: "0",
            creditAmount: amount,
            narration: inNarration,
          },
        ]);

        // Record link (sourcePaymentId links this transfer back to the originating payment)
        await tx.insert(interCompanyTransfers).values({
          transferType: "Cash",
          fromCompanyId: companyId,
          toCompanyId: cfg.destCompanyId,
          transferDate: transferDate,
          amount,
          fromLedgerAccountId,
          toLedgerAccountId: cfg.destLedgerAccountId,
          fromVoucherId: fromVoucher.id,
          toVoucherId: toVoucher.id,
          description: desc,
          sourcePaymentId: sourcePaymentId ?? null,
        });
      })
    );
  } catch (err) {
    // The payment itself is already posted; a failed transfer must not undo it,
    // but it has to be visible: nothing else records that the money did not move.
    logger.error("[RentalAutoTransfer] failed:", {
      companyId,
      module,
      sourcePaymentId: sourcePaymentId ?? null,
      amount,
      error: getErrorMessage(err),
    });
  }
}
