// ── Golden Coast Phase 5: post-cutover POS sale FIFO + accounting planner ─────
//
// Phase 5 owns the *production* Golden Coast sale flow that runs on top of the
// September 1, 2026 cutover:
//
//   * Phase 3 posted the opening balance sheet (Stock in Hand opening value).
//   * Phase 4 populated the canonical post-cutover FIFO lots in
//     `sp_stock_movements` from that same opening value, so every unit on the
//     floor now carries a real acquisition cost.
//   * Phase 5 consumes those lots when a sale is posted and derives COGS from
//     the consumed lots — never from a user-entered estimate.
//
// This module is deliberately pure: it takes plain rows and returns the FIFO
// allocation plan plus the two central-posting requests. Everything that needs
// a database (lot locking, inventory adjustment, voucher writes) lives in the
// route so the accounting arithmetic can be unit tested without one.
//
// Journal shape for one sale (both vouchers carry the sale location):
//
//   Revenue voucher   Dr  Golden Coast sale-side balance   = revenue
//                     Cr  Sales                            = revenue
//   COGS voucher      Dr  Cost of Goods Sold               = FIFO cost
//                     Cr  Stock in Hand                    = FIFO cost
//
// The Phase 1 single-voucher `location_sale` mutation path and the retired
// Supplier Partner `/api/sp/sales` payable-only posting are intentionally NOT
// reused: Phase 4 retired both for Golden Coast companies.

import { createHash } from "node:crypto";
import Decimal from "decimal.js";
import { releaseDebtEnglish } from "../../i18n/finalCloseoutEnglish";
import type { CentralPostingRequest, PostingActor } from "./centralPostingEngine";
import { buildGenericVoucherPostingRequest } from "./genericVoucherPosting";
import {
  GOLDEN_COAST_PHASE5_SOURCE_TYPE,
  GoldenCoastPhase5SaleError,
  positiveId,
  type GoldenCoastPhase5RoleAccounts,
  type GoldenCoastPhase5SaleInput,
  type GoldenCoastPhase5SalePlan,
} from "./goldenCoastPosSaleDecimalOf";
export {
  GOLDEN_COAST_CURRENT_INVENTORY_FIFO_SOURCE,
  GOLDEN_COAST_PHASE5_MAX_REQUEST_ID_LENGTH,
  GOLDEN_COAST_PHASE5_SOURCE_TYPE,
  GOLDEN_COAST_POST_CUTOVER_FIFO_SOURCES,
  GoldenCoastPhase5SaleError,
} from "./goldenCoastPosSaleDecimalOf";
export type {
  GoldenCoastFifoLot,
  GoldenCoastPhase5Allocation,
  GoldenCoastPhase5ErrorCode,
  GoldenCoastPhase5PlannedLine,
  GoldenCoastPhase5RoleAccounts,
  GoldenCoastPhase5SaleInput,
  GoldenCoastPhase5SaleLineInput,
  GoldenCoastPhase5SalePlan,
} from "./goldenCoastPosSaleDecimalOf";
export { parseGoldenCoastPhase5SaleInput } from "./parseGoldenCoastSaleInput";
export { planGoldenCoastPhase5Sale } from "./planGoldenCoastSale";

// ── Posting builder ──────────────────────────────────────────────────────────

export type GoldenCoastPhase5PostingRole = "revenue" | "cogs";

export interface GoldenCoastPhase5Posting {
  role: GoldenCoastPhase5PostingRole;
  request: CentralPostingRequest;
}

export interface GoldenCoastPhase5PostingBatch {
  clientRequestId: string;
  saleDigest: string;
  revenueVoucherNumber: string;
  cogsVoucherNumber: string;
  postings: GoldenCoastPhase5Posting[];
}

export function goldenCoastPhase5VoucherNumber(companyId: number, requestId: string): string {
  return `GC-POS-C${companyId}-${requestId}`;
}

/**
 * Stable digest of everything about a sale request that changes its accounting
 * meaning. It is persisted in the posting `sourceId`, so a caller that reuses a
 * `clientRequestId` with different sale data is rejected instead of being
 * silently handed the original sale's vouchers.
 */
export function goldenCoastPhase5SaleDigest(input: {
  sale: GoldenCoastPhase5SaleInput;
  saleSideAccount: GoldenCoastPhase5SaleSideAccount;
}): string {
  const { sale, saleSideAccount } = input;
  return createHash("sha256")
    .update(
      JSON.stringify({
        companyId: sale.companyId,
        locationId: sale.locationId,
        saleDate: sale.saleDate,
        customerName: sale.customerName,
        notes: sale.notes ?? null,
        saleSideAccount: { kind: saleSideAccount.kind, id: saleSideAccount.id },
        lines: sale.lines.map((line) => ({
          stockItemId: line.stockItemId,
          qty: new Decimal(line.qty).toFixed(),
          unitPriceUsd: new Decimal(line.unitPriceUsd).toFixed(),
          description: line.description ?? null,
        })),
      })
    )
    .digest("hex")
    .slice(0, 32);
}

export function goldenCoastPhase5SourceId(
  requestId: string,
  saleDigest: string,
  role: GoldenCoastPhase5PostingRole
): string {
  return `${requestId}:${saleDigest}:${role}`;
}

export function goldenCoastPhase5IdempotencyKey(
  companyId: number,
  requestId: string,
  role: GoldenCoastPhase5PostingRole
): string {
  return `${GOLDEN_COAST_PHASE5_SOURCE_TYPE}:${companyId}:${requestId}:${role}`;
}

/** Sale-side account the revenue is debited to: a ledger or a bank account. */
export interface GoldenCoastPhase5SaleSideAccount {
  kind: "ledger" | "bank";
  id: number;
}

function saleSideEntryTarget(account: GoldenCoastPhase5SaleSideAccount): Record<string, number> {
  return account.kind === "bank" ? { bankAccountId: account.id } : { ledgerAccountId: account.id };
}

/**
 * Builds the two balanced central-posting requests for one Golden Coast sale.
 * They are separate vouchers on purpose so the Sales voucher stays a pure
 * revenue document and the COGS/Stock in Hand movement stays auditable on its
 * own, matching how the rest of the Golden Coast programme reports margin.
 */
export function buildGoldenCoastPhase5SalePostings(input: {
  plan: GoldenCoastPhase5SalePlan;
  accounts: GoldenCoastPhase5RoleAccounts;
  saleSideAccount: GoldenCoastPhase5SaleSideAccount;
  /** Digest of the originating sale request; see goldenCoastPhase5SaleDigest. */
  saleDigest: string;
  exchangeRate: string | null;
  actor?: PostingActor;
}): GoldenCoastPhase5PostingBatch {
  const { plan, accounts } = input;
  const saleDigest = String(input.saleDigest ?? "").trim();
  if (!saleDigest) throw new GoldenCoastPhase5SaleError("saleDigest is required to tag a Golden Coast sale posting");
  const companyId = positiveId(plan.companyId, "companyId");
  const locationId = positiveId(plan.locationId, "locationId");
  const saleSide = input.saleSideAccount;
  if (saleSide.kind !== "ledger" && saleSide.kind !== "bank") {
    throw new GoldenCoastPhase5SaleError('saleSideAccount.kind must be "ledger" or "bank"');
  }
  positiveId(saleSide.id, "saleSideAccount.id");
  positiveId(accounts.salesRevenueAccountId, "salesRevenueAccountId");
  positiveId(accounts.cogsAccountId, "cogsAccountId");
  positiveId(accounts.stockInHandAccountId, "stockInHandAccountId");

  const revenueVoucherNumber = goldenCoastPhase5VoucherNumber(companyId, plan.clientRequestId);
  const cogsVoucherNumber = `${revenueVoucherNumber}-COGS`;
  const description = releaseDebtEnglish(`Golden Coast POS sale — ${plan.customerName}`);

  const revenue = buildGenericVoucherPostingRequest({
    companyId,
    clientRequestId: plan.clientRequestId,
    voucher: {
      locationId,
      voucherNumber: revenueVoucherNumber,
      voucherType: "Sales",
      voucherDate: plan.saleDate,
      description,
      currency: "USD",
    },
    entries: [
      {
        ...saleSideEntryTarget(saleSide),
        debitAmount: plan.revenueUsd,
        creditAmount: "0",
        narration: description,
      },
      {
        ledgerAccountId: accounts.salesRevenueAccountId,
        debitAmount: "0",
        creditAmount: plan.revenueUsd,
        narration: description,
      },
    ],
    exchangeRate: input.exchangeRate,
    actor: input.actor,
  });

  const cogsDescription = releaseDebtEnglish(`Golden Coast POS sale COGS — ${plan.customerName}`);
  const cogs = buildGenericVoucherPostingRequest({
    companyId,
    clientRequestId: plan.clientRequestId,
    voucher: {
      locationId,
      voucherNumber: cogsVoucherNumber,
      voucherType: "Journal",
      voucherDate: plan.saleDate,
      description: cogsDescription,
      currency: "USD",
    },
    entries: [
      {
        ledgerAccountId: accounts.cogsAccountId,
        debitAmount: plan.cogsUsd,
        creditAmount: "0",
        narration: cogsDescription,
      },
      {
        ledgerAccountId: accounts.stockInHandAccountId,
        debitAmount: "0",
        creditAmount: plan.cogsUsd,
        narration: cogsDescription,
      },
    ],
    exchangeRate: input.exchangeRate,
    actor: input.actor,
  });

  // The idempotency key stays keyed on the client request id so a replay is
  // still found by lookup, while the sourceId carries the payload digest. The
  // central engine compares the stored sourceId on replay, so the same request
  // id submitted with different sale data conflicts instead of replaying.
  const tag = (request: CentralPostingRequest, role: GoldenCoastPhase5PostingRole): CentralPostingRequest => ({
    ...request,
    source: {
      sourceType: GOLDEN_COAST_PHASE5_SOURCE_TYPE,
      sourceId: goldenCoastPhase5SourceId(plan.clientRequestId, saleDigest, role),
      idempotencyKey: goldenCoastPhase5IdempotencyKey(companyId, plan.clientRequestId, role),
    },
  });

  return {
    clientRequestId: plan.clientRequestId,
    saleDigest,
    revenueVoucherNumber,
    cogsVoucherNumber,
    postings: [
      { role: "revenue", request: tag(revenue.request, "revenue") },
      { role: "cogs", request: tag(cogs.request, "cogs") },
    ],
  };
}
