import {
  buildCompanyTransferPostingRequest,
  createDatabasePostingDependencies,
  postBalancedVoucherTx,
  type PostingActor,
} from "../../services/accounting";
import { requireCompanyAccess } from "./transferRequestContext";
import { TransferRouteError } from "./transferErrors";
import { transferRepository } from "./transferRepository";
import { parseInterCompanyTransferInput } from "./transferValidation";

const postingDependencies = createDatabasePostingDependencies();

async function getOrCreateInterCompanyAccount(params: {
  companyId: number;
  code: string;
  name: string;
  accountType: "Asset" | "Liability";
  accounts: {
    code: string;
    id: number;
    name: string;
    active: boolean;
    createdAt: Date;
    companyId: number;
    deletedAt: Date | null;
    accountType: string;
    subType: string | null;
    parentId: number | null;
    openingBalance: string | null;
    openingBalanceSide: string | null;
    openingBalanceNativeAmount: string | null;
    openingBalanceCurrency: string | null;
    openingBalanceHistoricalRate: string | null;
    openingBalanceBaseAmount: string | null;
    isHidden: boolean;
  }[];
}) {
  const existing = params.accounts.find((account) => account.code === params.code);
  if (existing) return existing;
  return transferRepository.createLedgerAccount({
    companyId: params.companyId,
    code: params.code,
    name: params.name,
    accountType: params.accountType,
    openingBalance: "0",
    active: true,
  });
}

export const interCompanyTransferService = {
  list(companyId: number) {
    return transferRepository.listInterCompanyTransfers(companyId);
  },

  async create(userId: string, input: unknown, actor?: PostingActor) {
    const parsed = parseInterCompanyTransferInput(input);
    await requireCompanyAccess(userId, [parsed.fromCompanyId, parsed.toCompanyId]);

    const [fromCompany, toCompany, fromAccount, toAccount, fromAccounts, toAccounts] = await Promise.all([
      transferRepository.getCompany(parsed.fromCompanyId),
      transferRepository.getCompany(parsed.toCompanyId),
      transferRepository.getLedgerAccount(parsed.fromLedgerAccountId),
      transferRepository.getLedgerAccount(parsed.toLedgerAccountId),
      transferRepository.listLedgerAccounts(parsed.fromCompanyId),
      transferRepository.listLedgerAccounts(parsed.toCompanyId),
    ]);

    if (!fromCompany) throw new TransferRouteError(404, "From company not found");
    if (!toCompany) throw new TransferRouteError(404, "To company not found");
    if (!fromAccount || fromAccount.companyId !== parsed.fromCompanyId) {
      throw new TransferRouteError(404, "From ledger account not found or doesn't belong to from company");
    }
    if (!toAccount || toAccount.companyId !== parsed.toCompanyId) {
      throw new TransferRouteError(404, "To ledger account not found or doesn't belong to to company");
    }

    const fromInterCompanyAccount = await getOrCreateInterCompanyAccount({
      companyId: parsed.fromCompanyId,
      code: `IC-TO-${toCompany.code}`,
      name: `Inter-Company - ${toCompany.name}`,
      accountType: "Asset",
      accounts: fromAccounts,
    });
    const toInterCompanyAccount = await getOrCreateInterCompanyAccount({
      companyId: parsed.toCompanyId,
      code: `IC-FROM-${fromCompany.code}`,
      name: `Inter-Company - ${fromCompany.name}`,
      accountType: "Liability",
      accounts: toAccounts,
    });
    const voucherTimestamp = Date.now();
    const fromVoucherNumber = `ICT-FROM-${voucherTimestamp}`;
    const toVoucherNumber = `ICT-TO-${voucherTimestamp}`;
    const description = parsed.description || `Inter-company transfer to ${toCompany.name}`;

    return transferRepository.transaction(async (tx) => {
      const fromNarration = `Transfer to ${toCompany.name} - ${fromVoucherNumber}`;
      const fromBuilt = buildCompanyTransferPostingRequest({
        companyId: parsed.fromCompanyId,
        voucherNumber: fromVoucherNumber,
        voucherType: "Payment",
        voucherDate: parsed.transferDate,
        description,
        debitNarration: fromNarration,
        creditNarration: fromNarration,
        amount: parsed.amount,
        debitLedgerAccountId: fromInterCompanyAccount.id,
        creditLedgerAccountId: parsed.fromLedgerAccountId,
        clientRequestId: parsed.clientRequestId,
        sourceType: "inter-company-transfer",
        sourceSide: "from",
        actor: actor ?? { userId, reason: "Inter-company transfer source posting" },
      });
      const fromPosted = await postBalancedVoucherTx(tx, fromBuilt.request, postingDependencies);

      const toNarration = `Transfer from ${fromCompany.name} - ${toVoucherNumber}`;
      const toBuilt = buildCompanyTransferPostingRequest({
        companyId: parsed.toCompanyId,
        voucherNumber: toVoucherNumber,
        voucherType: "Receipt",
        voucherDate: parsed.transferDate,
        description: parsed.description || `Inter-company transfer from ${fromCompany.name}`,
        debitNarration: toNarration,
        creditNarration: toNarration,
        amount: parsed.amount,
        debitLedgerAccountId: parsed.toLedgerAccountId,
        creditLedgerAccountId: toInterCompanyAccount.id,
        clientRequestId: fromBuilt.clientRequestId,
        sourceType: "inter-company-transfer",
        sourceSide: "to",
        actor: actor ?? { userId, reason: "Inter-company transfer destination posting" },
      });
      const toPosted = await postBalancedVoucherTx(tx, toBuilt.request, postingDependencies);

      const existingTransfer = await transferRepository.findTransferByVoucherIdsTx(
        tx,
        Number((fromPosted.voucher as { id: unknown }).id),
        Number((toPosted.voucher as { id: unknown }).id)
      );
      if (existingTransfer) return existingTransfer;

      return transferRepository.createTransferTx(tx, {
        transferType: parsed.transferType,
        fromCompanyId: parsed.fromCompanyId,
        toCompanyId: parsed.toCompanyId,
        transferDate: parsed.transferDate,
        amount: fromBuilt.amount,
        fromLedgerAccountId: parsed.fromLedgerAccountId,
        toLedgerAccountId: parsed.toLedgerAccountId,
        fromVoucherId: Number((fromPosted.voucher as { id: unknown }).id),
        toVoucherId: Number((toPosted.voucher as { id: unknown }).id),
        description: parsed.description ?? null,
        sourcePaymentId: parsed.sourcePaymentId ?? null,
      });
    });
  },
};
