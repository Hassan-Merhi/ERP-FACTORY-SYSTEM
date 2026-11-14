/**
 * Recognize intercompany parties by their verified, company-scoped mapping ID.
 * A name, keyword or editable display label can NEVER trigger a paired posting.
 * IC-AP is only a mapping alias; destination liability is posted once to the
 * actual Properties supplier subledger by confirmMirroredPayment.
 */
export type NormalVoucherAccount = { accountType: string; accountId: number };
export type NormalVoucherPolicy = {
  id: number;
  relationshipType: string;
  sourceCompanyId: number;
  destinationCompanyId: number;
  tradeEnabled: boolean;
  sourceReceivableAccountId: number | null;
  destinationPayableAccountId: number | null;
  destinationSupplierId: number | null;
};
export type NormalVoucherMatch = {
  relationshipId: number;
  sourceCompanyId: number;
  destinationCompanyId: number;
  role: "source-receipt" | "destination-payment";
};

export class NormalVoucherMirrorError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 422
  ) {
    super(message);
    this.name = "NormalVoucherMirrorError";
  }
}

function matchingPolicy(
  policy: NormalVoucherPolicy,
  companyId: number,
  account: NormalVoucherAccount
): "source" | "destination" | null {
  if (!Number.isSafeInteger(account.accountId) || account.accountId <= 0) return null;
  if (
    companyId === policy.sourceCompanyId &&
    account.accountType === "ledger" &&
    account.accountId === policy.sourceReceivableAccountId
  )
    return "source";
  if (
    companyId === policy.destinationCompanyId &&
    ((account.accountType === "supplier" && account.accountId === policy.destinationSupplierId) ||
      (account.accountType === "ledger" && account.accountId === policy.destinationPayableAccountId))
  )
    return "destination";
  return null;
}

export function matchNormalIntercompanyVoucher(args: {
  companyId: number;
  voucherType: string;
  paymentAccount: NormalVoucherAccount;
  entries: NormalVoucherAccount[];
  policies: NormalVoucherPolicy[];
}): NormalVoucherMatch | null {
  const { companyId, voucherType, paymentAccount, entries, policies } = args;
  const configured = policies.filter((policy) => policy.relationshipType === "container_trade");
  // Do not silently post a standalone voucher just because the user has
  // selected an IC payable/receivable account in the "Pay from" box.
  if (configured.some((policy) => matchingPolicy(policy, companyId, paymentAccount))) {
    throw new NormalVoucherMirrorError(
      "IC_VOUCHER_CASH_REQUIRED",
      "Select an actual cash or bank account in Pay From / Receive Into and the intercompany party in the voucher entry"
    );
  }
  const hits = configured.flatMap((policy) =>
    entries.flatMap((entry) => {
      const side = matchingPolicy(policy, companyId, entry);
      return side ? [{ policy, side }] : [];
    })
  );
  if (hits.length === 0) return null;
  if (hits.length !== 1 || entries.length !== 1) {
    throw new NormalVoucherMirrorError(
      "IC_VOUCHER_MIXED_ENTRIES",
      "Intercompany Payment/Receipt requires exactly one linked company entry. Post other suppliers or expenses separately."
    );
  }
  const { policy, side } = hits[0];
  const expectedVoucherType = side === "source" ? "Receipt" : "Payment";
  if (voucherType !== expectedVoucherType) {
    throw new NormalVoucherMirrorError(
      "IC_VOUCHER_DIRECTION",
      "The destination ERP pays Properties with a Payment voucher; Properties receives it with a Receipt voucher. Reverse an existing transfer using its linked vouchers."
    );
  }
  if (!policy.tradeEnabled) {
    throw new NormalVoucherMirrorError("IC_VOUCHER_PAIR_DISABLED", "This intercompany relationship is disabled", 409);
  }
  if (!["ledger", "bank"].includes(paymentAccount.accountType)) {
    throw new NormalVoucherMirrorError(
      "IC_VOUCHER_CASH_REQUIRED",
      "Choose an actual active cash ledger or bank account as the Payment/Receipt source"
    );
  }
  return {
    relationshipId: policy.id,
    sourceCompanyId: policy.sourceCompanyId,
    destinationCompanyId: policy.destinationCompanyId,
    role: side === "source" ? "source-receipt" : "destination-payment",
  };
}
