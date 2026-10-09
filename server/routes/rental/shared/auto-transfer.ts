import { logger } from "../../../lib/logger";
import { db, type DbTransaction } from "../../../db";
import {
  ledgerAccounts,
  vouchers,
  voucherEntries,
  rentalAutoTransferConfigs,
  interCompanyTransfers,
  companies,
} from "@shared/schema";
import { eq, and, isNull } from "drizzle-orm";
import { RentalModule } from "./ledger";

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

    const [fromCompany] = await db.select().from(companies).where(eq(companies.id, companyId));
    if (!fromCompany) return;

    // Get or create TRANSFER-CLEARING account in a company
    async function getOrCreateClearing(tx: DbTransaction, cid: number) {
      const [existing] = await tx
        .select()
        .from(ledgerAccounts)
        .where(
          and(
            eq(ledgerAccounts.companyId, cid),
            eq(ledgerAccounts.code, "TRANSFER-CLEARING"),
            isNull(ledgerAccounts.deletedAt)
          )
        );
      if (existing) return existing;
      const [created] = await tx
        .insert(ledgerAccounts)
        .values({
          companyId: cid,
          code: "TRANSFER-CLEARING",
          name: "Transfer Clearing",
          accountType: "Equity",
          active: true,
        })
        .returning();
      return created;
    }

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

    const [toCompany] = await db.select().from(companies).where(eq(companies.id, cfg.destCompanyId));
    if (!toCompany) return;

    // Only one transfer per payment — use the matched rule. Wave 12: both
    // companies' vouchers, their lines, any clearing account created for them
    // and the link row are written in one transaction (they used to autocommit
    // one by one, so a failure could leave money out of one company only).
    await db.transaction(async (tx) => {
      const fromClearing = await getOrCreateClearing(tx, companyId);
      const toClearing = await getOrCreateClearing(tx, cfg.destCompanyId);
      const baseDesc = `Auto rent transfer - ${unitLabel}`;
      const desc = notes ? `${baseDesc} - ${notes}` : baseDesc;
      const txId = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

      const outNarration = notes ? `Transfer out to ${toCompany.name} - ${notes}` : `Transfer out to ${toCompany.name}`;
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
    });
  } catch (err) {
    logger.error("[RentalAutoTransfer] failed:", { error: err });
  }
}
