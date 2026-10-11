import { randomUUID } from "node:crypto";
import type { DbTransaction } from "../../../db";
import { rentalAutoTransferConfigs, interCompanyTransfers, companies } from "@shared/schema";
import { eq, and, inArray, isNull } from "drizzle-orm";
import type { PostingActor } from "../../../services/accounting/centralPostingEngine";
import {
  postIntercompanyTransferTx,
  softDeleteTransferLinkTx,
} from "../../../services/accounting/intercompany/intercompanyTransferPosting";
import { retireVouchersTx, type VoucherRetirementActor } from "../../../services/accounting/voucherRetirement";
import { RentalModule } from "./ledger";

/**
 * Retire both sides of every auto-transfer posted for these payments and drop
 * the links. Run inside `runWithAutoTransferCounterparties` so the receiving
 * company's voucher is in scope; under the paying company's scope alone it was
 * silently left live. Wave 16 (A): each leg is retired (soft delete with its
 * lines, audited in this transaction, number released), not hard-deleted.
 */
export async function reverseAutoTransfersTx(
  tx: DbTransaction,
  sourcePaymentIds: readonly number[],
  retirement: { reason: string; actor?: VoucherRetirementActor | null }
): Promise<void> {
  if (sourcePaymentIds.length === 0) return;
  const linked = await tx
    .select()
    .from(interCompanyTransfers)
    .where(
      and(
        inArray(interCompanyTransfers.sourcePaymentId, [...sourcePaymentIds]),
        isNull(interCompanyTransfers.deletedAt)
      )
    );
  for (const transfer of linked) {
    // Phase 26 (MC-11): the link is soft-deleted (kept, audited) with its legs.
    await softDeleteTransferLinkTx(tx, transfer.id, {
      reason: retirement?.reason ?? "rental-auto-transfer-reversal",
      actor: retirement?.actor ?? null,
    });
    if (transfer.fromVoucherId) {
      await retireVouchersTx(tx, {
        companyId: transfer.fromCompanyId,
        voucherIds: [transfer.fromVoucherId],
        ...retirement,
      });
    }
    if (transfer.toVoucherId) {
      await retireVouchersTx(tx, {
        companyId: transfer.toCompanyId,
        voucherIds: [transfer.toVoucherId],
        ...retirement,
      });
    }
  }
}

export interface RentalAutoTransferInput {
  companyId: number;
  module: RentalModule;
  /** The cash account the rent was received in (the rule's source filter). */
  fromLedgerAccountId: number;
  amount: string;
  transferDate: string;
  unitLabel: string;
  /** The rental payment row; a reversal finds the transfer by it. */
  sourcePaymentId?: number | null;
  /** Posting identity when there is no payment row (e.g. a guarantee statement). */
  sourceKey?: string | null;
  notes?: string | null;
  actor?: PostingActor;
}

/** The enabled rule of the company/module for the source cash account, or null. */
export async function findRentalAutoTransferRuleTx(
  tx: DbTransaction,
  companyId: number,
  module: RentalModule,
  fromLedgerAccountId: number
) {
  const configs = await tx
    .select()
    .from(rentalAutoTransferConfigs)
    .where(
      and(
        eq(rentalAutoTransferConfigs.companyId, companyId),
        eq(rentalAutoTransferConfigs.module, module),
        eq(rentalAutoTransferConfigs.enabled, true)
      )
    );
  // Rules with a specific sourceCashAccountIds list take precedence; the first
  // rule with an empty filter applies only when no specific rule matched.
  const specificMatch = configs.find((c) => {
    const ids = (c.sourceCashAccountIds ?? []) as number[];
    return ids.length > 0 && ids.includes(fromLedgerAccountId);
  });
  const fallbackMatch = configs.find((c) => ((c.sourceCashAccountIds ?? []) as number[]).length === 0);
  return specificMatch ?? fallbackMatch ?? null;
}

/**
 * The rental auto-transfer, posted INSIDE the payment's transaction (phase 26,
 * MC-3): the payment and both legs of the transfer commit together, or the
 * whole payment is refused. It used to run after the payment committed and
 * only log a failure (money recorded as received and never moved). Both legs
 * and the link go through the one intercompany service: Dr due-from <dest> /
 * Cr cash in the paying company, Dr the rule's configured destination account
 * / Cr due-to <source> in the receiving one (no longer the Equity-typed
 * TRANSFER-CLEARING on both sides), with the requesting user's membership of
 * the receiving company checked. One transfer per payment: a replay posts
 * nothing more. Returns the link id, or null when no rule applies.
 */
export async function runRentalAutoTransferTx(
  tx: DbTransaction,
  input: RentalAutoTransferInput
): Promise<number | null> {
  const cfg = await findRentalAutoTransferRuleTx(tx, input.companyId, input.module, input.fromLedgerAccountId);
  if (!cfg) return null;

  if (input.sourcePaymentId) {
    const [already] = await tx
      .select({ id: interCompanyTransfers.id })
      .from(interCompanyTransfers)
      .where(
        and(eq(interCompanyTransfers.sourcePaymentId, input.sourcePaymentId), isNull(interCompanyTransfers.deletedAt))
      )
      .limit(1);
    if (already) return already.id;
  }

  const [fromCompany] = await tx.select().from(companies).where(eq(companies.id, input.companyId));
  const [toCompany] = await tx.select().from(companies).where(eq(companies.id, cfg.destCompanyId));
  if (!fromCompany || !toCompany) {
    throw new Error(`Auto-transfer rule ${cfg.id}: company ${input.companyId} or ${cfg.destCompanyId} not found`);
  }

  const baseDesc = `Auto rent transfer - ${input.unitLabel}`;
  const desc = input.notes ? `${baseDesc} - ${input.notes}` : baseDesc;
  const transferSourceId = input.sourcePaymentId
    ? String(input.sourcePaymentId)
    : input.sourceKey || `once-${randomUUID()}`;
  const outNarration = input.notes
    ? `Transfer out to ${toCompany.name} - ${input.notes}`
    : `Transfer out to ${toCompany.name}`;
  const inNarration = input.notes
    ? `Transfer in from ${fromCompany.name} - ${input.notes}`
    : `Transfer in from ${fromCompany.name}`;

  const { transfer } = await postIntercompanyTransferTx(tx, {
    fromCompanyId: input.companyId,
    toCompanyId: cfg.destCompanyId,
    amount: input.amount,
    transferDate: input.transferDate,
    transferType: "Cash",
    description: desc,
    sourceType: "rental-auto-transfer",
    sourcePaymentId: input.sourcePaymentId ?? null,
    authorization: "verify-membership",
    actor: input.actor ?? { reason: "Rental auto-transfer" },
    from: {
      accountId: input.fromLedgerAccountId,
      voucherType: "Payment",
      description: `${desc} → ${toCompany.name}`,
      narration: outNarration,
      source: { type: "rental-auto-transfer-out", id: transferSourceId },
    },
    to: {
      accountId: cfg.destLedgerAccountId,
      voucherType: "Receipt",
      description: input.notes
        ? `Transfer from ${fromCompany.name} - ${input.notes}`
        : `Transfer from ${fromCompany.name}`,
      narration: inNarration,
      source: { type: "rental-auto-transfer-in", id: transferSourceId },
    },
  });
  return transfer.id;
}
