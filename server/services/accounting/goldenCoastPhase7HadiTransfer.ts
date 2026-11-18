import { createHash } from "node:crypto";
import Decimal from "decimal.js";
import { releaseDebtEnglish } from "../../i18n/finalCloseoutEnglish";
import type { CentralPostingRequest, PostingActor } from "./centralPostingEngine";
import { buildGenericVoucherPostingRequest } from "./genericVoucherPosting";
import { gcSalesCashPayableBalance } from "./goldenCoastSalesCashPayable";
import {
  GOLDEN_COAST_PHASE7_SOURCE_TYPE,
  GoldenCoastPhase7TransferError,
  MONEY_SCALE,
  balanceMoney,
  clientRequestId,
  money,
  positiveId,
  positiveMoney,
  requiredText,
  type GoldenCoastPhase7Balances,
  type GoldenCoastPhase7CashAccount,
  type GoldenCoastPhase7Operation,
  type GoldenCoastPhase7PostingBatch,
  type GoldenCoastPhase7PostingRole,
  type GoldenCoastPhase7RoleAccounts,
  type GoldenCoastPhase7TransferInput,
  type GoldenCoastPhase7TransferPlan,
} from "./parseGoldenCoastPhase7TransferInput";
export {
  GOLDEN_COAST_PHASE7_MAX_REQUEST_ID_LENGTH,
  GOLDEN_COAST_PHASE7_SOURCE_TYPE,
  GoldenCoastPhase7TransferError,
  parseGoldenCoastPhase7TransferInput,
} from "./parseGoldenCoastPhase7TransferInput";
export type {
  GoldenCoastPhase7Balances,
  GoldenCoastPhase7CashAccount,
  GoldenCoastPhase7ErrorCode,
  GoldenCoastPhase7Operation,
  GoldenCoastPhase7Posting,
  GoldenCoastPhase7PostingBatch,
  GoldenCoastPhase7PostingRole,
  GoldenCoastPhase7RoleAccounts,
  GoldenCoastPhase7TransferInput,
  GoldenCoastPhase7TransferPlan,
} from "./parseGoldenCoastPhase7TransferInput";

/**
 * Apply the balance rules for a new (non-replay) transfer.
 *
 * A collection RAISES the GC Sales Cash payable, so it has no ceiling on that
 * account: capping it against the account it grows is what made this operation
 * unusable while GC Sales Cash was misread as a receivable. Remittance can only
 * move cash already collected through Phase 7 and not yet remitted; it never
 * consumes unrelated historical balances on the shared intercompany accounts
 * (for example parent-agent offload charges), and it leaves the payable alone.
 */
export function planGoldenCoastPhase7Transfer(input: {
  transfer: GoldenCoastPhase7TransferInput;
  balances: GoldenCoastPhase7Balances;
}): GoldenCoastPhase7TransferPlan {
  const amount = positiveMoney(input.transfer.amountUsd, "amountUsd");
  const balance = balanceMoney(input.balances.gcSalesCashDebitBalanceUsd, "gcSalesCashDebitBalanceUsd");
  const payable = new Decimal(gcSalesCashPayableBalance(balance.toFixed()));
  const outstanding = balanceMoney(input.balances.outstandingHadiCollectionsUsd, "outstandingHadiCollectionsUsd");
  if (outstanding.lessThan(0)) {
    throw new GoldenCoastPhase7TransferError(
      "Phase 7 HADI collection history is inconsistent: remittances exceed collections",
      "GC_PHASE7_SCOPE_INVALID"
    );
  }

  if (input.transfer.operation === "collect_via_hadi") {
    return {
      ...input.transfer,
      gcSalesCashDebitBalanceBeforeUsd: money(balance),
      gcSalesCashDebitBalanceAfterUsd: money(balance.minus(amount)),
      gcSalesCashPayableBeforeUsd: money(payable),
      gcSalesCashPayableAfterUsd: money(payable.plus(amount)),
      outstandingHadiCollectionsBeforeUsd: money(outstanding),
      outstandingHadiCollectionsAfterUsd: money(outstanding.plus(amount)),
    };
  }

  if (amount.greaterThan(outstanding)) {
    throw new GoldenCoastPhase7TransferError(
      `Remittance ${money(amount)} exceeds unremitted Phase 7 HADI collections ${money(outstanding)}`,
      "GC_PHASE7_REMITTANCE_EXCEEDS_COLLECTIONS"
    );
  }

  return {
    ...input.transfer,
    gcSalesCashDebitBalanceBeforeUsd: money(balance),
    gcSalesCashDebitBalanceAfterUsd: money(balance),
    gcSalesCashPayableBeforeUsd: money(payable),
    gcSalesCashPayableAfterUsd: money(payable),
    outstandingHadiCollectionsBeforeUsd: money(outstanding),
    outstandingHadiCollectionsAfterUsd: money(outstanding.minus(amount)),
  };
}

export function goldenCoastPhase7TransferDigest(input: {
  transfer: GoldenCoastPhase7TransferInput;
  accounts: GoldenCoastPhase7RoleAccounts;
}): string {
  const { transfer, accounts } = input;
  const canonicalAccounts: GoldenCoastPhase7RoleAccounts = {
    gcSalesCashAccountId: positiveId(accounts.gcSalesCashAccountId, "gcSalesCashAccountId"),
    goldenCoastHadiIntercompanyAccountId: positiveId(
      accounts.goldenCoastHadiIntercompanyAccountId,
      "goldenCoastHadiIntercompanyAccountId"
    ),
    hadiGoldenCoastIntercompanyAccountId: positiveId(
      accounts.hadiGoldenCoastIntercompanyAccountId,
      "hadiGoldenCoastIntercompanyAccountId"
    ),
  };

  return createHash("sha256")
    .update(
      JSON.stringify({
        companyId: transfer.companyId,
        parentCompanyId: transfer.parentCompanyId,
        operation: transfer.operation,
        transferDate: transfer.transferDate,
        amountUsd: new Decimal(transfer.amountUsd).toFixed(MONEY_SCALE),
        reference: transfer.reference,
        hadiCashAccount: transfer.hadiCashAccount,
        goldenCoastCashAccount: transfer.goldenCoastCashAccount,
        accounts: canonicalAccounts,
      })
    )
    .digest("hex")
    .slice(0, 32);
}

export function goldenCoastPhase7SourceId(
  operation: GoldenCoastPhase7Operation,
  transferDigest: string,
  role: GoldenCoastPhase7PostingRole
): string {
  const digest = requiredText(transferDigest, "transferDigest", 64);
  return `${operation}:${digest}:${role}`;
}

export function goldenCoastPhase7IdempotencyKey(
  companyId: number,
  requestId: string,
  role: GoldenCoastPhase7PostingRole
): string {
  return `${GOLDEN_COAST_PHASE7_SOURCE_TYPE}:${positiveId(companyId, "companyId")}:${clientRequestId(requestId)}:${role}`;
}

function cashTarget(account: GoldenCoastPhase7CashAccount): Record<string, number> {
  return account.kind === "bank" ? { bankAccountId: account.id } : { ledgerAccountId: account.id };
}

function taggedRequest(input: {
  request: CentralPostingRequest;
  transfer: GoldenCoastPhase7TransferInput;
  transferDigest: string;
  role: GoldenCoastPhase7PostingRole;
}): CentralPostingRequest {
  return {
    ...input.request,
    source: {
      sourceType: GOLDEN_COAST_PHASE7_SOURCE_TYPE,
      sourceId: goldenCoastPhase7SourceId(input.transfer.operation, input.transferDigest, input.role),
      idempotencyKey: goldenCoastPhase7IdempotencyKey(
        input.transfer.companyId,
        input.transfer.clientRequestId,
        input.role
      ),
    },
  };
}

/**
 * Build the two-company accounting pair. Both vouchers must be persisted in the
 * caller's single database transaction.
 *
 * collect_via_hadi (raises the GC Sales Cash payable):
 *   Golden Coast  Dr HADI Intercompany / Cr GC Sales Cash
 *   HADI          Dr Cash/Bank         / Cr Golden Coast Intercompany
 *
 * remit_from_hadi:
 *   Golden Coast  Dr Cash/Bank         / Cr HADI Intercompany
 *   HADI          Dr Golden Coast IC   / Cr Cash/Bank
 */
export function buildGoldenCoastPhase7TransferPostings(input: {
  plan: GoldenCoastPhase7TransferPlan;
  accounts: GoldenCoastPhase7RoleAccounts;
  transferDigest: string;
  goldenCoastExchangeRate: string | null;
  hadiExchangeRate: string | null;
  actor?: PostingActor;
}): GoldenCoastPhase7PostingBatch {
  const { plan, accounts } = input;
  positiveId(accounts.gcSalesCashAccountId, "gcSalesCashAccountId");
  positiveId(accounts.goldenCoastHadiIntercompanyAccountId, "goldenCoastHadiIntercompanyAccountId");
  positiveId(accounts.hadiGoldenCoastIntercompanyAccountId, "hadiGoldenCoastIntercompanyAccountId");
  if (accounts.gcSalesCashAccountId === accounts.goldenCoastHadiIntercompanyAccountId) {
    throw new GoldenCoastPhase7TransferError(
      "GC Sales Cash and the Golden Coast HADI intercompany role must resolve to distinct accounts",
      "GC_PHASE7_SCOPE_INVALID"
    );
  }

  const amountUsd = money(positiveMoney(plan.amountUsd, "amountUsd"));
  const suffix = plan.operation === "collect_via_hadi" ? "COLLECT" : "REMIT";
  const gcVoucherNumber = `GC-P7-C${plan.companyId}-${plan.clientRequestId}-${suffix}`;
  const hadiVoucherNumber = `GC-P7-C${plan.companyId}-${plan.clientRequestId}-${suffix}-HADI`;
  const referenceSuffix = plan.reference ? ` — ${plan.reference}` : "";
  const gcDescription = releaseDebtEnglish(
    plan.operation === "collect_via_hadi"
      ? `Golden Coast sales cash collected via HADI${referenceSuffix}`
      : `HADI cash remittance to Golden Coast${referenceSuffix}`
  );
  const hadiDescription = releaseDebtEnglish(
    plan.operation === "collect_via_hadi"
      ? `Cash collected for Golden Coast${referenceSuffix}`
      : `Cash remitted to Golden Coast${referenceSuffix}`
  );

  const goldenCoastEntries =
    plan.operation === "collect_via_hadi"
      ? [
          {
            ledgerAccountId: accounts.goldenCoastHadiIntercompanyAccountId,
            debitAmount: amountUsd,
            creditAmount: "0",
            narration: gcDescription,
          },
          {
            ledgerAccountId: accounts.gcSalesCashAccountId,
            debitAmount: "0",
            creditAmount: amountUsd,
            narration: gcDescription,
          },
        ]
      : [
          {
            ...cashTarget(plan.goldenCoastCashAccount as GoldenCoastPhase7CashAccount),
            debitAmount: amountUsd,
            creditAmount: "0",
            narration: gcDescription,
          },
          {
            ledgerAccountId: accounts.goldenCoastHadiIntercompanyAccountId,
            debitAmount: "0",
            creditAmount: amountUsd,
            narration: gcDescription,
          },
        ];

  const hadiEntries =
    plan.operation === "collect_via_hadi"
      ? [
          {
            ...cashTarget(plan.hadiCashAccount),
            debitAmount: amountUsd,
            creditAmount: "0",
            narration: hadiDescription,
          },
          {
            ledgerAccountId: accounts.hadiGoldenCoastIntercompanyAccountId,
            debitAmount: "0",
            creditAmount: amountUsd,
            narration: hadiDescription,
          },
        ]
      : [
          {
            ledgerAccountId: accounts.hadiGoldenCoastIntercompanyAccountId,
            debitAmount: amountUsd,
            creditAmount: "0",
            narration: hadiDescription,
          },
          {
            ...cashTarget(plan.hadiCashAccount),
            debitAmount: "0",
            creditAmount: amountUsd,
            narration: hadiDescription,
          },
        ];

  const goldenCoastPosting = buildGenericVoucherPostingRequest({
    companyId: plan.companyId,
    clientRequestId: plan.clientRequestId,
    voucher: {
      voucherNumber: gcVoucherNumber,
      voucherType: "Journal",
      voucherDate: plan.transferDate,
      description: gcDescription,
      currency: "USD",
    },
    entries: goldenCoastEntries,
    exchangeRate: input.goldenCoastExchangeRate,
    actor: input.actor,
  });

  const hadiPosting = buildGenericVoucherPostingRequest({
    companyId: plan.parentCompanyId,
    clientRequestId: plan.clientRequestId,
    voucher: {
      voucherNumber: hadiVoucherNumber,
      voucherType: "Journal",
      voucherDate: plan.transferDate,
      description: hadiDescription,
      currency: "USD",
    },
    entries: hadiEntries,
    exchangeRate: input.hadiExchangeRate,
    actor: input.actor,
  });

  return {
    clientRequestId: plan.clientRequestId,
    transferDigest: input.transferDigest,
    postings: [
      {
        role: "golden_coast",
        request: taggedRequest({
          request: goldenCoastPosting.request,
          transfer: plan,
          transferDigest: input.transferDigest,
          role: "golden_coast",
        }),
      },
      {
        role: "hadi",
        request: taggedRequest({
          request: hadiPosting.request,
          transfer: plan,
          transferDigest: input.transferDigest,
          role: "hadi",
        }),
      },
    ],
  };
}
