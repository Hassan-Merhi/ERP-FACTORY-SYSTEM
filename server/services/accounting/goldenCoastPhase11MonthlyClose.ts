import { createHash } from "node:crypto";
import Decimal from "decimal.js";
import { releaseDebtEnglish } from "../../i18n/finalCloseoutEnglish";
import type { CentralPostingRequest, PostingActor } from "./centralPostingEngine";
import { buildGenericVoucherPostingRequest } from "./genericVoucherPosting";
import { GOLDEN_COAST_PHASE11_SOURCE_TYPE } from "./goldenCoastPhase11CloseIdentity";

export { GOLDEN_COAST_PHASE11_SOURCE_TYPE } from "./goldenCoastPhase11CloseIdentity";
export const GOLDEN_COAST_PHASE11_SPLIT_PCT = "50.00";
const MONTH_PATTERN = /^\d{4}-\d{2}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;

export class GoldenCoastPhase11CloseError extends Error {
  constructor(
    message: string,
    readonly code: string = "GC_PHASE11_INPUT_INVALID"
  ) {
    super(releaseDebtEnglish(message));
    this.name = "GoldenCoastPhase11CloseError";
  }
}

export interface GoldenCoastPhase11CloseInput {
  companyId: number;
  periodMonth: string;
  clientRequestId: string;
  reference: string | null;
}

export interface GoldenCoastPhase11Accounts {
  salesAccountId: number;
  cogsAccountId: number;
  sharedChargesAccountId: number | null;
  correctionSuspenseAccountId?: number | null;
  profitPendingDistributionAccountId: number;
  freshStartEquityAccountId: number;
  hassanEquityAccountId: number;
}

export interface GoldenCoastPhase11ClosePlan extends GoldenCoastPhase11CloseInput {
  periodStart: string;
  periodEnd: string;
  totalRevenueUsd: string;
  totalCogsUsd: string;
  totalSharedChargesUsd: string;
  /** Developer-approved difference, booked to an auditable suspense ledger in the close Journal. */
  manualAdjustmentUsd: string;
  netProfitLossUsd: string;
  freshStartShareUsd: string;
  hassanShareUsd: string;
}

function positiveId(value: unknown, field: string): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new GoldenCoastPhase11CloseError(`${field} must be a positive integer`);
  return id;
}

function decimal(value: unknown, field: string): Decimal {
  try {
    const parsed = new Decimal(String(value ?? ""));
    if (!parsed.isFinite()) throw new Error("not finite");
    return parsed;
  } catch {
    throw new GoldenCoastPhase11CloseError(`${field} must be a finite number`);
  }
}

function money(value: Decimal): string {
  return value.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
}

function signedMoney(value: unknown, field: string): Decimal {
  const parsed = decimal(value, field);
  if (parsed.decimalPlaces() > 2) throw new GoldenCoastPhase11CloseError(`${field} supports at most 2 decimal places`);
  return parsed;
}

function parseMonth(value: unknown): { periodMonth: string; periodStart: string; periodEnd: string } {
  const periodMonth = typeof value === "string" ? value.trim() : "";
  if (!MONTH_PATTERN.test(periodMonth)) throw new GoldenCoastPhase11CloseError("periodMonth must use YYYY-MM");
  const [year, month] = periodMonth.split("-").map(Number);
  if (month < 1 || month > 12) throw new GoldenCoastPhase11CloseError("periodMonth must be a real calendar month");
  const periodStart = `${periodMonth}-01`;
  const end = new Date(Date.UTC(year, month, 0));
  const periodEnd = `${periodMonth}-${String(end.getUTCDate()).padStart(2, "0")}`;
  return { periodMonth, periodStart, periodEnd };
}

export function parseGoldenCoastPhase11CloseInput(input: {
  companyId: number;
  body: unknown;
}): GoldenCoastPhase11CloseInput {
  const companyId = positiveId(input.companyId, "companyId");
  if (!input.body || typeof input.body !== "object" || Array.isArray(input.body)) {
    throw new GoldenCoastPhase11CloseError("A Phase 11 monthly close request body is required");
  }
  const body = input.body as Record<string, unknown>;
  const { periodMonth } = parseMonth(body.periodMonth);
  const clientRequestId = typeof body.clientRequestId === "string" ? body.clientRequestId.trim() : "";
  if (!clientRequestId || clientRequestId.length > 64 || !REQUEST_ID_PATTERN.test(clientRequestId)) {
    throw new GoldenCoastPhase11CloseError("clientRequestId must be 1-64 supported characters");
  }
  const reference =
    typeof body.reference === "string" && body.reference.trim() ? body.reference.trim().slice(0, 200) : null;
  return { companyId, periodMonth, clientRequestId, reference };
}

export function planGoldenCoastPhase11MonthlyClose(input: {
  close: GoldenCoastPhase11CloseInput;
  totalRevenueUsd: string | number;
  totalCogsUsd: string | number;
  totalSharedChargesUsd: string | number;
  manualAdjustmentUsd?: string | number;
}): GoldenCoastPhase11ClosePlan {
  const { periodStart, periodEnd } = parseMonth(input.close.periodMonth);
  const revenue = signedMoney(input.totalRevenueUsd, "totalRevenueUsd");
  const cogs = signedMoney(input.totalCogsUsd, "totalCogsUsd");
  const shared = signedMoney(input.totalSharedChargesUsd, "totalSharedChargesUsd");
  const manualAdjustment = signedMoney(input.manualAdjustmentUsd ?? "0", "manualAdjustmentUsd");
  if (revenue.isZero() && cogs.isZero() && shared.isZero()) {
    throw new GoldenCoastPhase11CloseError(
      "The selected month has no closeable Golden Coast activity",
      "GC_PHASE11_NOTHING_TO_CLOSE"
    );
  }
  const net = revenue.minus(cogs).minus(shared).plus(manualAdjustment);
  const fresh = net.div(2).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  const hassan = net.minus(fresh);
  return {
    ...input.close,
    periodStart,
    periodEnd,
    totalRevenueUsd: money(revenue),
    totalCogsUsd: money(cogs),
    totalSharedChargesUsd: money(shared),
    manualAdjustmentUsd: money(manualAdjustment),
    netProfitLossUsd: money(net),
    freshStartShareUsd: money(fresh),
    hassanShareUsd: money(hassan),
  };
}

export function goldenCoastPhase11CloseDigest(input: {
  plan: GoldenCoastPhase11ClosePlan;
  accounts: GoldenCoastPhase11Accounts;
}): string {
  return createHash("sha256")
    .update(JSON.stringify({ plan: input.plan, accounts: input.accounts, splitPct: GOLDEN_COAST_PHASE11_SPLIT_PCT }))
    .digest("hex")
    .slice(0, 32);
}

export function goldenCoastPhase11IdempotencyKey(companyId: number, periodMonth: string): string {
  return `${GOLDEN_COAST_PHASE11_SOURCE_TYPE}:${positiveId(companyId, "companyId")}:${parseMonth(periodMonth).periodMonth}`;
}

export function buildGoldenCoastPhase11MonthlyClosePosting(input: {
  plan: GoldenCoastPhase11ClosePlan;
  accounts: GoldenCoastPhase11Accounts;
  digest: string;
  actor?: PostingActor;
}): CentralPostingRequest {
  const { plan, accounts } = input;
  const revenue = new Decimal(plan.totalRevenueUsd);
  const cogs = new Decimal(plan.totalCogsUsd);
  const shared = new Decimal(plan.totalSharedChargesUsd);
  const adjustment = new Decimal(plan.manualAdjustmentUsd || "0");
  const net = new Decimal(plan.netProfitLossUsd);
  const description = releaseDebtEnglish(`Golden Coast monthly 50/50 close — ${plan.periodMonth}`);
  const entries: Parameters<typeof buildGenericVoucherPostingRequest>[0]["entries"] = [];

  if (revenue.gt(0)) {
    entries.push({
      ledgerAccountId: accounts.salesAccountId,
      debitAmount: money(revenue),
      creditAmount: "0",
      narration: description,
    });
    entries.push({
      ledgerAccountId: accounts.profitPendingDistributionAccountId,
      debitAmount: "0",
      creditAmount: money(revenue),
      narration: description,
    });
  } else if (revenue.lt(0)) {
    const contraRevenue = revenue.abs();
    entries.push({
      ledgerAccountId: accounts.profitPendingDistributionAccountId,
      debitAmount: money(contraRevenue),
      creditAmount: "0",
      narration: description,
    });
    entries.push({
      ledgerAccountId: accounts.salesAccountId,
      debitAmount: "0",
      creditAmount: money(contraRevenue),
      narration: description,
    });
  }
  if (cogs.gt(0)) {
    entries.push({
      ledgerAccountId: accounts.profitPendingDistributionAccountId,
      debitAmount: money(cogs),
      creditAmount: "0",
      narration: description,
    });
    entries.push({
      ledgerAccountId: accounts.cogsAccountId,
      debitAmount: "0",
      creditAmount: money(cogs),
      narration: description,
    });
  } else if (cogs.lt(0)) {
    const contraCogs = cogs.abs();
    entries.push({
      ledgerAccountId: accounts.cogsAccountId,
      debitAmount: money(contraCogs),
      creditAmount: "0",
      narration: description,
    });
    entries.push({
      ledgerAccountId: accounts.profitPendingDistributionAccountId,
      debitAmount: "0",
      creditAmount: money(contraCogs),
      narration: description,
    });
  }
  if (!shared.isZero()) {
    if (!accounts.sharedChargesAccountId)
      throw new GoldenCoastPhase11CloseError(
        "Shared Charges account is required when monthly shared charges are non-zero",
        "GC_PHASE11_ACCOUNT_INVALID"
      );
    if (shared.gt(0)) {
      entries.push({
        ledgerAccountId: accounts.profitPendingDistributionAccountId,
        debitAmount: money(shared),
        creditAmount: "0",
        narration: description,
      });
      entries.push({
        ledgerAccountId: accounts.sharedChargesAccountId,
        debitAmount: "0",
        creditAmount: money(shared),
        narration: description,
      });
    } else {
      const contraShared = shared.abs();
      entries.push({
        ledgerAccountId: accounts.sharedChargesAccountId,
        debitAmount: money(contraShared),
        creditAmount: "0",
        narration: description,
      });
      entries.push({
        ledgerAccountId: accounts.profitPendingDistributionAccountId,
        debitAmount: "0",
        creditAmount: money(contraShared),
        narration: description,
      });
    }
  }

  // An approved profit difference must have a real, balanced ledger counterpart:
  // the suspense debit/credit remains auditable until its underlying economics
  // are reconciled. No POS sales/costs are rewritten by this correction.
  if (!adjustment.isZero()) {
    if (!accounts.correctionSuspenseAccountId) {
      throw new GoldenCoastPhase11CloseError(
        "Manual profit correction suspense ledger is not configured",
        "GC_PHASE11_ACCOUNT_INVALID"
      );
    }
    const amount = money(adjustment.abs());
    entries.push({
      ledgerAccountId: accounts.correctionSuspenseAccountId,
      debitAmount: adjustment.gt(0) ? amount : "0",
      creditAmount: adjustment.lt(0) ? amount : "0",
      narration: description,
    });
    entries.push({
      ledgerAccountId: accounts.profitPendingDistributionAccountId,
      debitAmount: adjustment.lt(0) ? amount : "0",
      creditAmount: adjustment.gt(0) ? amount : "0",
      narration: description,
    });
  }

  if (net.gt(0)) {
    entries.push({
      ledgerAccountId: accounts.profitPendingDistributionAccountId,
      debitAmount: money(net),
      creditAmount: "0",
      narration: description,
    });
    entries.push({
      ledgerAccountId: accounts.freshStartEquityAccountId,
      debitAmount: "0",
      creditAmount: money(new Decimal(plan.freshStartShareUsd)),
      narration: description,
    });
    entries.push({
      ledgerAccountId: accounts.hassanEquityAccountId,
      debitAmount: "0",
      creditAmount: money(new Decimal(plan.hassanShareUsd)),
      narration: description,
    });
  } else if (net.lt(0)) {
    const loss = net.abs();
    entries.push({
      ledgerAccountId: accounts.freshStartEquityAccountId,
      debitAmount: money(new Decimal(plan.freshStartShareUsd).abs()),
      creditAmount: "0",
      narration: description,
    });
    entries.push({
      ledgerAccountId: accounts.hassanEquityAccountId,
      debitAmount: money(new Decimal(plan.hassanShareUsd).abs()),
      creditAmount: "0",
      narration: description,
    });
    entries.push({
      ledgerAccountId: accounts.profitPendingDistributionAccountId,
      debitAmount: "0",
      creditAmount: money(loss),
      narration: description,
    });
  }

  const posting = buildGenericVoucherPostingRequest({
    companyId: plan.companyId,
    clientRequestId: plan.clientRequestId,
    voucher: {
      voucherNumber: `GC-MC-C${plan.companyId}-${plan.periodMonth.replace("-", "")}`,
      voucherType: "Journal",
      voucherDate: plan.periodEnd,
      description,
      currency: "USD",
    },
    entries,
    exchangeRate: null,
    actor: input.actor,
  });

  return {
    ...posting.request,
    source: {
      sourceType: GOLDEN_COAST_PHASE11_SOURCE_TYPE,
      sourceId: `month:${plan.periodMonth}:${input.digest}`,
      idempotencyKey: goldenCoastPhase11IdempotencyKey(plan.companyId, plan.periodMonth),
    },
  };
}
