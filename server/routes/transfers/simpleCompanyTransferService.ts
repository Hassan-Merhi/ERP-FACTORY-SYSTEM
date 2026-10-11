import {
  buildCompanyTransferPostingRequest,
  createDatabasePostingDependencies,
  postBalancedVoucherTx,
  type CentralPostingRequest,
  type PostingActor,
} from "../../services/accounting";
import {
  postIntercompanyTransferTx,
  softDeleteTransferLinkTx,
} from "../../services/accounting/intercompany/intercompanyTransferPosting";
import { requireCompanyAccess } from "./transferRequestContext";
import { TransferRouteError } from "./transferErrors";
import { transferRepository } from "./transferRepository";
import { parseSimpleTransferInput } from "./transferValidation";

const postingDependencies = createDatabasePostingDependencies();

type TransferSide = "from" | "to";

function buildTransferReversalRequest(input: {
  transferId: number;
  side: TransferSide;
  transferDate: string;
  // Exactly what transferRepository.getVoucherSnapshotTx resolves to, so the
  // reversal payload tracks the vouchers/voucher_entries schema automatically.
  snapshot: NonNullable<Awaited<ReturnType<typeof transferRepository.getVoucherSnapshotTx>>>;
  actor: PostingActor;
}): CentralPostingRequest {
  const { transferId, side, transferDate, snapshot, actor } = input;
  const idempotencyKey = `simple-company-transfer-reversal:${transferId}:${side}`;
  const entries = snapshot.entries.map((entry) => ({
    ledgerAccountId: entry.ledgerAccountId ?? undefined,
    bankAccountId: entry.bankAccountId ?? undefined,
    fixedAssetId: entry.fixedAssetId ?? undefined,
    supplierId: entry.supplierId ?? undefined,
    employeeId: entry.employeeId ?? undefined,
    customerId: entry.customerId ?? undefined,
    factorySupplierId: entry.factorySupplierId ?? undefined,
    debitAmount: String(entry.creditAmount ?? "0"),
    creditAmount: String(entry.debitAmount ?? "0"),
    narration: entry.narration ? `Reversal: ${entry.narration}` : `Reversal of ${snapshot.voucher.voucherNumber}`,
  }));

  return {
    voucher: {
      companyId: snapshot.voucher.companyId,
      voucherNumber: `REV-${snapshot.voucher.voucherNumber}-${Date.now()}`,
      voucherType: "Journal",
      voucherDate: transferDate,
      description: `Reversal of company transfer #${transferId} (${side})`,
      totalAmount: snapshot.voucher.totalAmount,
      optional: false,
    },
    entries,
    source: {
      sourceType: "simple-company-transfer-reversal",
      sourceId: `${transferId}:${side}`,
      idempotencyKey,
    },
    actor,
  };
}

export const simpleCompanyTransferService = {
  list(companyId: number) {
    return transferRepository.listSimpleTransfers(companyId);
  },

  listCompanyAccounts(companyId: number) {
    return transferRepository.listLedgerAccounts(companyId, true);
  },

  async create(userId: string, input: unknown, actor?: PostingActor) {
    const parsed = parseSimpleTransferInput(input);
    await requireCompanyAccess(userId, [parsed.fromCompanyId, parsed.toCompanyId]);

    const [fromCompany, toCompany] = await Promise.all([
      transferRepository.getCompany(parsed.fromCompanyId),
      transferRepository.getCompany(parsed.toCompanyId),
    ]);
    if (!fromCompany || !toCompany) throw new TransferRouteError(404, "Company not found");

    const description = parsed.description || `Transfer to ${toCompany.name}`;
    const voucherTimestamp = Date.now();
    let clientRequestId: unknown = parsed.clientRequestId;

    // Phase 26 (MC-1, decided by default): a simple transfer posts against the
    // companies' intercompany accounts (IC-TO-/IC-FROM-, type Intercompany)
    // through the one intercompany service, no longer against the Equity-typed
    // TRANSFER-CLEARING account (kept for history; group reports eliminate it).
    return transferRepository.transaction(async (tx) => {
      const { transfer } = await postIntercompanyTransferTx(tx, {
        fromCompanyId: parsed.fromCompanyId,
        toCompanyId: parsed.toCompanyId,
        amount: parsed.amount,
        transferDate: parsed.transferDate,
        transferType: "Cash",
        description,
        sourceType: "simple-company-transfer",
        authorization: "membership-checked",
        actor: actor ?? { userId },
        from: {
          accountId: parsed.fromLedgerAccountId,
          post: async (legTx, leg) => {
            const fromNarration = `Transfer out to ${toCompany.name}`;
            const built = buildCompanyTransferPostingRequest({
              companyId: leg.companyId,
              voucherNumber: `TR-OUT-${voucherTimestamp}`,
              voucherType: "Payment",
              voucherDate: parsed.transferDate,
              description: `${description} → ${toCompany.name}`,
              debitNarration: fromNarration,
              creditNarration: fromNarration,
              amount: leg.amount,
              debitLedgerAccountId: leg.debitAccountId,
              creditLedgerAccountId: leg.creditAccountId,
              clientRequestId,
              sourceType: "simple-company-transfer",
              sourceSide: "from",
              actor: actor ?? { userId, reason: "Simple company transfer source posting" },
            });
            clientRequestId = built.clientRequestId;
            const posted = await postBalancedVoucherTx(legTx, built.request, postingDependencies);
            return Number((posted.voucher as { id: unknown }).id);
          },
        },
        to: {
          accountId: parsed.toLedgerAccountId,
          post: async (legTx, leg) => {
            const toNarration = `Transfer in from ${fromCompany.name}`;
            const built = buildCompanyTransferPostingRequest({
              companyId: leg.companyId,
              voucherNumber: `TR-IN-${voucherTimestamp}`,
              voucherType: "Receipt",
              voucherDate: parsed.transferDate,
              description: `Transfer from ${fromCompany.name}`,
              debitNarration: toNarration,
              creditNarration: toNarration,
              amount: leg.amount,
              debitLedgerAccountId: leg.debitAccountId,
              creditLedgerAccountId: leg.creditAccountId,
              clientRequestId,
              sourceType: "simple-company-transfer",
              sourceSide: "to",
              actor: actor ?? { userId, reason: "Simple company transfer destination posting" },
            });
            const posted = await postBalancedVoucherTx(legTx, built.request, postingDependencies);
            return Number((posted.voucher as { id: unknown }).id);
          },
        },
      });
      return transfer;
    });
  },

  async delete(userId: string, transferId: number, actor?: PostingActor) {
    const transfer = await transferRepository.getSimpleTransfer(transferId);
    if (!transfer || transfer.deletedAt) {
      if (await transferRepository.hasCompletedTransferReversal(transferId)) {
        return { success: true, replayed: true };
      }
      throw new TransferRouteError(404, "Transfer not found");
    }
    await requireCompanyAccess(userId, [transfer.fromCompanyId, transfer.toCompanyId]);

    return transferRepository.transaction(async (tx) => {
      const lockedTransfer = await transferRepository.getSimpleTransferForUpdateTx(tx, transferId);
      if (!lockedTransfer || lockedTransfer.deletedAt) return { success: true, replayed: true };

      const fromVoucherId = Number(lockedTransfer.fromVoucherId);
      const toVoucherId = Number(lockedTransfer.toVoucherId);
      if (!Number.isInteger(fromVoucherId) || !Number.isInteger(toVoucherId)) {
        throw new TransferRouteError(409, "Transfer is missing one or both accounting vouchers");
      }

      const [fromSnapshot, toSnapshot] = await Promise.all([
        transferRepository.getVoucherSnapshotTx(tx, lockedTransfer.fromCompanyId, fromVoucherId),
        transferRepository.getVoucherSnapshotTx(tx, lockedTransfer.toCompanyId, toVoucherId),
      ]);
      if (!fromSnapshot || !toSnapshot) {
        throw new TransferRouteError(409, "Transfer accounting vouchers could not be loaded for reversal");
      }

      const reversalActor = actor ?? { userId, reason: `Reverse company transfer ${transferId}` };
      const fromReversal = await postBalancedVoucherTx(
        tx,
        buildTransferReversalRequest({
          transferId,
          side: "from",
          transferDate: lockedTransfer.transferDate,
          snapshot: fromSnapshot,
          actor: reversalActor,
        }),
        postingDependencies
      );
      const toReversal = await postBalancedVoucherTx(
        tx,
        buildTransferReversalRequest({
          transferId,
          side: "to",
          transferDate: lockedTransfer.transferDate,
          snapshot: toSnapshot,
          actor: reversalActor,
        }),
        postingDependencies
      );

      // Replaces the legacy deleteTransferVoucher behavior: originals remain for
      // audit, and the link is soft-deleted (phase 26, MC-11), not removed.
      await softDeleteTransferLinkTx(tx, transferId, {
        reason: `Reverse company transfer ${transferId}`,
        actor: reversalActor,
      });
      return {
        success: true,
        replayed: fromReversal.replayed && toReversal.replayed,
        reversalVoucherIds: [
          Number((fromReversal.voucher as { id: unknown }).id),
          Number((toReversal.voucher as { id: unknown }).id),
        ],
      };
    });
  },
};
