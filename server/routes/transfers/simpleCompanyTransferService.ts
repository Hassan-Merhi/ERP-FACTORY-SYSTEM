import {
  buildCompanyTransferPostingRequest,
  createDatabasePostingDependencies,
  postBalancedVoucherTx,
  type CentralPostingRequest,
  type PostingActor,
} from "../../services/accounting";
import { requireCompanyAccess } from "./transferRequestContext";
import { TransferRouteError } from "./transferErrors";
import { transferRepository } from "./transferRepository";
import { parseSimpleTransferInput } from "./transferValidation";

const postingDependencies = createDatabasePostingDependencies();

type TransferSide = "from" | "to";

async function getOrCreateClearingAccount(companyId: number) {
  const accounts = await transferRepository.listLedgerAccounts(companyId);
  const existing = accounts.find((account) => account.code === "TRANSFER-CLEARING");
  if (existing) return existing;
  return transferRepository.createLedgerAccount({
    companyId,
    code: "TRANSFER-CLEARING",
    name: "Transfer Clearing",
    accountType: "Equity",
    openingBalance: "0",
    active: true,
  });
}

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
    const [fromClearing, toClearing] = await Promise.all([
      getOrCreateClearingAccount(parsed.fromCompanyId),
      getOrCreateClearingAccount(parsed.toCompanyId),
    ]);
    const voucherTimestamp = Date.now();

    return transferRepository.transaction(async (tx) => {
      const fromNarration = `Transfer out to ${toCompany.name}`;
      const fromBuilt = buildCompanyTransferPostingRequest({
        companyId: parsed.fromCompanyId,
        voucherNumber: `TR-OUT-${voucherTimestamp}`,
        voucherType: "Payment",
        voucherDate: parsed.transferDate,
        description: `${description} → ${toCompany.name}`,
        debitNarration: fromNarration,
        creditNarration: fromNarration,
        amount: parsed.amount,
        debitLedgerAccountId: fromClearing.id,
        creditLedgerAccountId: parsed.fromLedgerAccountId,
        clientRequestId: parsed.clientRequestId,
        sourceType: "simple-company-transfer",
        sourceSide: "from",
        actor: actor ?? { userId, reason: "Simple company transfer source posting" },
      });
      const fromPosted = await postBalancedVoucherTx(tx, fromBuilt.request, postingDependencies);

      const toNarration = `Transfer in from ${fromCompany.name}`;
      const toBuilt = buildCompanyTransferPostingRequest({
        companyId: parsed.toCompanyId,
        voucherNumber: `TR-IN-${voucherTimestamp}`,
        voucherType: "Receipt",
        voucherDate: parsed.transferDate,
        description: `Transfer from ${fromCompany.name}`,
        debitNarration: toNarration,
        creditNarration: toNarration,
        amount: parsed.amount,
        debitLedgerAccountId: parsed.toLedgerAccountId,
        creditLedgerAccountId: toClearing.id,
        clientRequestId: fromBuilt.clientRequestId,
        sourceType: "simple-company-transfer",
        sourceSide: "to",
        actor: actor ?? { userId, reason: "Simple company transfer destination posting" },
      });
      const toPosted = await postBalancedVoucherTx(tx, toBuilt.request, postingDependencies);

      const existingTransfer = await transferRepository.findTransferByVoucherIdsTx(
        tx,
        Number((fromPosted.voucher as { id: unknown }).id),
        Number((toPosted.voucher as { id: unknown }).id)
      );
      if (existingTransfer) return existingTransfer;

      return transferRepository.createTransferTx(tx, {
        transferType: "Cash",
        fromCompanyId: parsed.fromCompanyId,
        toCompanyId: parsed.toCompanyId,
        transferDate: parsed.transferDate,
        amount: fromBuilt.amount,
        fromLedgerAccountId: parsed.fromLedgerAccountId,
        toLedgerAccountId: parsed.toLedgerAccountId,
        fromVoucherId: (fromPosted.voucher as { id: unknown }).id,
        toVoucherId: (toPosted.voucher as { id: unknown }).id,
        description,
      });
    });
  },

  async delete(userId: string, transferId: number, actor?: PostingActor) {
    const transfer = await transferRepository.getSimpleTransfer(transferId);
    if (!transfer) {
      if (await transferRepository.hasCompletedTransferReversal(transferId)) {
        return { success: true, replayed: true };
      }
      throw new TransferRouteError(404, "Transfer not found");
    }
    await requireCompanyAccess(userId, [transfer.fromCompanyId, transfer.toCompanyId]);

    return transferRepository.transaction(async (tx) => {
      const lockedTransfer = await transferRepository.getSimpleTransferForUpdateTx(tx, transferId);
      if (!lockedTransfer) return { success: true, replayed: true };

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

      // Replaces the legacy deleteTransferVoucher behavior: originals remain for audit.
      await transferRepository.deleteSimpleTransferTx(tx, transferId);
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
