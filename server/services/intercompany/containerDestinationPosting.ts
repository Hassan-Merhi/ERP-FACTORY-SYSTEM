import type { ErpVoucherLine } from "../accounting/erpVoucherPosting";

/**
 * A destination's actual intercompany payable is represented by its supplier
 * subledger for the supplier named after the source Properties company.
 *
 * Dr GIT / Cr named supplier payable. Do NOT also credit a separate GL payable
 * account: that would book the same liability twice. Relationship GL account
 * mapping is retained for Phase 6 reconciliation and consolidated reporting.
 */
export function destinationContainerGitPostingLines(input: {
  goodsInTransitLedgerAccountId: number;
  propertiesSupplierId: number;
  confirmedLandedCost: string;
  sourceCompanyName: string;
}): ErpVoucherLine[] {
  const { goodsInTransitLedgerAccountId, propertiesSupplierId, confirmedLandedCost, sourceCompanyName } = input;
  if (!Number.isSafeInteger(goodsInTransitLedgerAccountId) || goodsInTransitLedgerAccountId <= 0) {
    throw new Error("Destination GIT account must be configured.");
  }
  if (!Number.isSafeInteger(propertiesSupplierId) || propertiesSupplierId <= 0) {
    throw new Error("Destination Properties supplier must be configured.");
  }
  return [
    {
      ledgerAccountId: goodsInTransitLedgerAccountId,
      debit: confirmedLandedCost,
      narration: "Confirmed goods in transit at landed cost",
    },
    {
      supplierId: propertiesSupplierId,
      credit: confirmedLandedCost,
      narration: "Intercompany supplier payable to " + sourceCompanyName,
    },
  ];
}
