import { createHash } from "node:crypto";
import Decimal from "decimal.js";
import { releaseDebtEnglish } from "../../i18n/finalCloseoutEnglish";
import type { CentralPostingRequest, PostingActor } from "./centralPostingEngine";
import { buildGenericVoucherPostingRequest } from "./genericVoucherPosting";

/**
 * Phase 15 makes GC Sales Cash one canonical credit-normal liability.
 *
 * The existing Phase 5/6 sale path first recognizes revenue through GC Sales
 * Cash and then moves the physical proceeds to HADI. After those two postings,
 * GC Sales Cash is back at zero. Fresh Start is nevertheless entitled to the
 * gross sale proceeds (less any separately-posted Hassan Savings deduction), so
 * the gross claim must be reclassified from Fresh Start capital into the
 * payable. This bridge is the balancing side that makes the accounting equation
 * hold without treating the gross sale as profit distribution.
 *
 * Journal for a $1,000 gross sale:
 *   Dr Fresh Start FZ Equity   1,000
 *   Cr GC Sales Cash Payable   1,000
 *
 * Sales and COGS remain in their existing P&L vouchers and are still closed
 * 50/50 only by the monthly-close phase.
 */
export const GOLDEN_COAST_PHASE15_SOURCE_TYPE = "golden-coast-phase15-sales-payable";
export const GOLDEN_COAST_PHASE15_POSTING_ROLE = "fresh_start_capital_to_payable" as const;

export class GoldenCoastPhase15SalesPayableError extends Error {
  constructor(
    message: string,
    readonly code: string = "GC_PHASE15_SALES_PAYABLE_INVALID"
  ) {
    super(releaseDebtEnglish(message));
    this.name = "GoldenCoastPhase15SalesPayableError";
  }
}

export interface GoldenCoastPhase15SalesPayableInput {
  companyId: number;
  saleDate: string;
  amountUsd: string | number;
  clientRequestId: string;
  saleDigest: string;
  freshStartEquityAccountId: number;
  gcSalesCashAccountId: number;
}

function positiveId(value: unknown, field: string): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw new GoldenCoastPhase15SalesPayableError(`${field} must be a positive integer`);
  }
  return id;
}

function requiredText(value: unknown, field: string, maxLength: number): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new GoldenCoastPhase15SalesPayableError(`${field} is required`);
  if (text.length > maxLength) {
    throw new GoldenCoastPhase15SalesPayableError(`${field} must be at most ${maxLength} characters`);
  }
  return text;
}

function positiveMoney(value: unknown): string {
  let amount: Decimal;
  try {
    amount = new Decimal(String(value ?? ""));
  } catch {
    throw new GoldenCoastPhase15SalesPayableError("amountUsd must be numeric");
  }
  if (!amount.isFinite() || !amount.greaterThan(0)) {
    throw new GoldenCoastPhase15SalesPayableError("amountUsd must be greater than zero");
  }
  if (amount.decimalPlaces() > 2) {
    throw new GoldenCoastPhase15SalesPayableError("amountUsd supports at most 2 decimal places");
  }
  return amount.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
}

export function goldenCoastPhase15SalesPayableDigest(input: GoldenCoastPhase15SalesPayableInput): string {
  const companyId = positiveId(input.companyId, "companyId");
  const freshStartEquityAccountId = positiveId(input.freshStartEquityAccountId, "freshStartEquityAccountId");
  const gcSalesCashAccountId = positiveId(input.gcSalesCashAccountId, "gcSalesCashAccountId");
  if (freshStartEquityAccountId === gcSalesCashAccountId) {
    throw new GoldenCoastPhase15SalesPayableError("Fresh Start Equity and GC Sales Cash must be different accounts");
  }
  return createHash("sha256")
    .update(
      JSON.stringify({
        companyId,
        saleDate: requiredText(input.saleDate, "saleDate", 10),
        amountUsd: positiveMoney(input.amountUsd),
        clientRequestId: requiredText(input.clientRequestId, "clientRequestId", 64),
        saleDigest: requiredText(input.saleDigest, "saleDigest", 64),
        freshStartEquityAccountId,
        gcSalesCashAccountId,
      })
    )
    .digest("hex")
    .slice(0, 32);
}

export function goldenCoastPhase15IdempotencyKey(companyId: number, clientRequestId: string): string {
  return `${GOLDEN_COAST_PHASE15_SOURCE_TYPE}:${positiveId(companyId, "companyId")}:${requiredText(
    clientRequestId,
    "clientRequestId",
    64
  )}`;
}

export function buildGoldenCoastPhase15SalesPayablePosting(input: {
  sale: GoldenCoastPhase15SalesPayableInput;
  digest: string;
  exchangeRate: string | null;
  actor?: PostingActor;
}): CentralPostingRequest {
  const sale = input.sale;
  const companyId = positiveId(sale.companyId, "companyId");
  const freshStartEquityAccountId = positiveId(sale.freshStartEquityAccountId, "freshStartEquityAccountId");
  const gcSalesCashAccountId = positiveId(sale.gcSalesCashAccountId, "gcSalesCashAccountId");
  if (freshStartEquityAccountId === gcSalesCashAccountId) {
    throw new GoldenCoastPhase15SalesPayableError("Fresh Start Equity and GC Sales Cash must be different accounts");
  }
  const amountUsd = positiveMoney(sale.amountUsd);
  const clientRequestId = requiredText(sale.clientRequestId, "clientRequestId", 64);
  const saleDigest = requiredText(sale.saleDigest, "saleDigest", 64);
  const postingDigest = requiredText(input.digest, "digest", 64);
  const description = releaseDebtEnglish(`Golden Coast sale payable reclassification — ${clientRequestId}`);

  const built = buildGenericVoucherPostingRequest({
    companyId,
    clientRequestId,
    voucher: {
      voucherNumber: `GC-P15-C${companyId}-${clientRequestId}`,
      voucherType: "Journal",
      voucherDate: requiredText(sale.saleDate, "saleDate", 10),
      description,
      currency: "USD",
    },
    entries: [
      {
        ledgerAccountId: freshStartEquityAccountId,
        debitAmount: amountUsd,
        creditAmount: "0",
        narration: description,
      },
      {
        ledgerAccountId: gcSalesCashAccountId,
        debitAmount: "0",
        creditAmount: amountUsd,
        narration: description,
      },
    ],
    exchangeRate: input.exchangeRate,
    actor: input.actor,
  });

  return {
    ...built.request,
    source: {
      sourceType: GOLDEN_COAST_PHASE15_SOURCE_TYPE,
      sourceId: `${clientRequestId}:${saleDigest}:${postingDigest}:${GOLDEN_COAST_PHASE15_POSTING_ROLE}`,
      idempotencyKey: goldenCoastPhase15IdempotencyKey(companyId, clientRequestId),
    },
  };
}
