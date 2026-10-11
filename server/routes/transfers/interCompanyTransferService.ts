import {
  buildCompanyTransferPostingRequest,
  createDatabasePostingDependencies,
  postBalancedVoucherTx,
  type PostingActor,
} from "../../services/accounting";
import { postIntercompanyTransferTx } from "../../services/accounting/intercompany/intercompanyTransferPosting";
import { requireCompanyAccess } from "./transferRequestContext";
import { TransferRouteError } from "./transferErrors";
import { transferRepository } from "./transferRepository";
import { parseInterCompanyTransferInput } from "./transferValidation";

const postingDependencies = createDatabasePostingDependencies();

export const interCompanyTransferService = {
  list(companyId: number) {
    return transferRepository.listInterCompanyTransfers(companyId);
  },

  async create(userId: string, input: unknown, actor?: PostingActor) {
    const parsed = parseInterCompanyTransferInput(input);
    await requireCompanyAccess(userId, [parsed.fromCompanyId, parsed.toCompanyId]);

    const [fromCompany, toCompany, fromAccount, toAccount] = await Promise.all([
      transferRepository.getCompany(parsed.fromCompanyId),
      transferRepository.getCompany(parsed.toCompanyId),
      transferRepository.getLedgerAccount(parsed.fromLedgerAccountId),
      transferRepository.getLedgerAccount(parsed.toLedgerAccountId),
    ]);

    if (!fromCompany) throw new TransferRouteError(404, "From company not found");
    if (!toCompany) throw new TransferRouteError(404, "To company not found");
    if (!fromAccount || fromAccount.companyId !== parsed.fromCompanyId) {
      throw new TransferRouteError(404, "From ledger account not found or doesn't belong to from company");
    }
    if (!toAccount || toAccount.companyId !== parsed.toCompanyId) {
      throw new TransferRouteError(404, "To ledger account not found or doesn't belong to to company");
    }

    const voucherTimestamp = Date.now();
    const fromVoucherNumber = `ICT-FROM-${voucherTimestamp}`;
    const toVoucherNumber = `ICT-TO-${voucherTimestamp}`;
    const description = parsed.description || `Inter-company transfer to ${toCompany.name}`;
    let clientRequestId: unknown = parsed.clientRequestId;

    // Phase 26 (MC-1): both legs and the link through the one intercompany
    // service (IC-TO-/IC-FROM- typed Intercompany, their ids on the link).
    return transferRepository.transaction(async (tx) => {
      const { transfer } = await postIntercompanyTransferTx(tx, {
        fromCompanyId: parsed.fromCompanyId,
        toCompanyId: parsed.toCompanyId,
        amount: parsed.amount,
        transferDate: parsed.transferDate,
        transferType: parsed.transferType,
        description: parsed.description ?? null,
        sourceType: "inter-company-transfer",
        sourcePaymentId: parsed.sourcePaymentId ?? null,
        authorization: "membership-checked",
        actor: actor ?? { userId },
        from: {
          accountId: parsed.fromLedgerAccountId,
          post: async (legTx, leg) => {
            const fromNarration = `Transfer to ${toCompany.name} - ${fromVoucherNumber}`;
            const built = buildCompanyTransferPostingRequest({
              companyId: leg.companyId,
              voucherNumber: fromVoucherNumber,
              voucherType: "Payment",
              voucherDate: parsed.transferDate,
              description,
              debitNarration: fromNarration,
              creditNarration: fromNarration,
              amount: leg.amount,
              debitLedgerAccountId: leg.debitAccountId,
              creditLedgerAccountId: leg.creditAccountId,
              clientRequestId,
              sourceType: "inter-company-transfer",
              sourceSide: "from",
              actor: actor ?? { userId, reason: "Inter-company transfer source posting" },
            });
            clientRequestId = built.clientRequestId;
            const posted = await postBalancedVoucherTx(legTx, built.request, postingDependencies);
            return Number((posted.voucher as { id: unknown }).id);
          },
        },
        to: {
          accountId: parsed.toLedgerAccountId,
          post: async (legTx, leg) => {
            const toNarration = `Transfer from ${fromCompany.name} - ${toVoucherNumber}`;
            const built = buildCompanyTransferPostingRequest({
              companyId: leg.companyId,
              voucherNumber: toVoucherNumber,
              voucherType: "Receipt",
              voucherDate: parsed.transferDate,
              description: parsed.description || `Inter-company transfer from ${fromCompany.name}`,
              debitNarration: toNarration,
              creditNarration: toNarration,
              amount: leg.amount,
              debitLedgerAccountId: leg.debitAccountId,
              creditLedgerAccountId: leg.creditAccountId,
              clientRequestId,
              sourceType: "inter-company-transfer",
              sourceSide: "to",
              actor: actor ?? { userId, reason: "Inter-company transfer destination posting" },
            });
            const posted = await postBalancedVoucherTx(legTx, built.request, postingDependencies);
            return Number((posted.voucher as { id: unknown }).id);
          },
        },
      });
      return transfer;
    });
  },
};
