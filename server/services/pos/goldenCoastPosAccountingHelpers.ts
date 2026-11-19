// Extracted from ./goldenCoastPosAccounting.ts
import { vouchers } from "@shared/schema";
import { buildGenericVoucherPostingRequest } from "../accounting/genericVoucherPosting";
import { type PostingActor, type CentralPostingRequest } from "../accounting/centralPostingEngine";
import { GOLDEN_COAST_POS_SETTLEMENT_SOURCE_TYPE } from "./goldenCoastPosAccountingResolveCashTarget";

export async function buildPosting(input: {
  companyId: number;
  locationId: number | null;
  voucherDate: string;
  voucherNumber: string;
  description: string;
  amount: string;
  clientRequestId: string;
  sourceId: string;
  idempotencyKey: string;
  entries: Array<Record<string, unknown>>;
  actor?: PostingActor;
}): Promise<CentralPostingRequest> {
  const built = buildGenericVoucherPostingRequest({
    companyId: input.companyId,
    clientRequestId: input.clientRequestId,
    voucher: {
      locationId: input.locationId,
      voucherNumber: input.voucherNumber,
      voucherType: "Journal",
      voucherDate: input.voucherDate,
      description: input.description,
      currency: "USD",
    },
    entries: input.entries,
    exchangeRate: null,
    actor: input.actor,
  });
  return {
    ...built.request,
    voucher: { ...built.request.voucher, totalAmount: input.amount },
    source: {
      sourceType: GOLDEN_COAST_POS_SETTLEMENT_SOURCE_TYPE,
      sourceId: input.sourceId,
      idempotencyKey: input.idempotencyKey,
    },
  };
}

/**
 * Returns true only for a fully provisioned Golden Coast company. This is
 * deliberately local to the POS service so the POS route does not import a
 * route module just to classify a company.
 */
export function requireGoldenCoastSettlementClientSaleId(value: string | null | undefined): string {
  const clientSaleId = String(value ?? "").trim();
  if (!clientSaleId) {
    throw new Error("Golden Coast POS requires clientSaleId for settlement idempotency");
  }
  return clientSaleId;
}

export function isGeneratedGoldenCoastSettlementVoucher(
  voucher: typeof vouchers.$inferSelect,
  clientSaleId: string
): boolean {
  if (!String(voucher.voucherNumber || "").startsWith(`GC-POS-${clientSaleId}-`)) return false;
  const description = String(voucher.description || "");
  return (
    description === "Golden Coast POS cash transferred to HADI" ||
    description === "Golden Coast POS cash received by HADI" ||
    description === "Golden Coast POS payable reclassification" ||
    description.startsWith("Golden Coast POS settlement reversal ")
  );
}
