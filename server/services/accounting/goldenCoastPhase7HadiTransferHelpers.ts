// Extracted from ./goldenCoastPhase7HadiTransfer.ts
import { createHash } from "node:crypto";
import Decimal from "decimal.js";
import type { CentralPostingRequest } from "./centralPostingEngine";
import {
  GOLDEN_COAST_PHASE7_SOURCE_TYPE,
  MONEY_SCALE,
  clientRequestId,
  positiveId,
  requiredText,
  type GoldenCoastPhase7CashAccount,
  type GoldenCoastPhase7Operation,
  type GoldenCoastPhase7PostingRole,
  type GoldenCoastPhase7RoleAccounts,
  type GoldenCoastPhase7TransferInput,
} from "./parseGoldenCoastPhase7TransferInput";

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

export function cashTarget(account: GoldenCoastPhase7CashAccount): Record<string, number> {
  return account.kind === "bank" ? { bankAccountId: account.id } : { ledgerAccountId: account.id };
}

export function taggedRequest(input: {
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
