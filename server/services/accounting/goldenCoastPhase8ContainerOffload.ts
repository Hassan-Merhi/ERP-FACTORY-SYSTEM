import { createHash } from "node:crypto";
import Decimal from "decimal.js";
import { releaseDebtEnglish } from "../../i18n/finalCloseoutEnglish";
import type { PostingActor, CentralPostingRequest } from "./centralPostingEngine";
import { buildGenericVoucherPostingRequest } from "./genericVoucherPosting";
import {
  GOLDEN_COAST_FRESH_START_EXCEL_FUNDING_MARKER,
  GOLDEN_COAST_PHASE8_SOURCE_TYPE,
  GoldenCoastPhase8Error,
  MONEY_SCALE,
  accountTarget,
  decimal,
  money,
  type GoldenCoastPhase8ContainerInput,
  type GoldenCoastPhase8FundedContainerState,
  type GoldenCoastPhase8FundingPlan,
  type GoldenCoastPhase8OffloadInput,
  type GoldenCoastPhase8OffloadPlan,
  type GoldenCoastPhase8RoleAccounts,
} from "./parseGoldenCoastPhase8ContainerInput";
export {
  parseGoldenCoastPhase8OffloadInput,
  planGoldenCoastPhase8Offload,
} from "./goldenCoastPhase8ContainerOffloadHelpers";
export {
  GOLDEN_COAST_FRESH_START_EXCEL_FUNDING_MARKER,
  GOLDEN_COAST_PHASE8_MAX_REQUEST_ID_LENGTH,
  GOLDEN_COAST_PHASE8_OFFLOAD_FIFO_SOURCE,
  GOLDEN_COAST_PHASE8_SOURCE_TYPE,
  GoldenCoastPhase8Error,
  parseGoldenCoastPhase8ContainerInput,
  planGoldenCoastPhase8Funding,
} from "./parseGoldenCoastPhase8ContainerInput";
export type {
  GoldenCoastPhase8ChargeInput,
  GoldenCoastPhase8ContainerInput,
  GoldenCoastPhase8ContainerLineInput,
  GoldenCoastPhase8ContainerOrigin,
  GoldenCoastPhase8ErrorCode,
  GoldenCoastPhase8FundedContainerState,
  GoldenCoastPhase8FundingPlan,
  GoldenCoastPhase8OffloadInput,
  GoldenCoastPhase8OffloadLinePlan,
  GoldenCoastPhase8OffloadPlan,
  GoldenCoastPhase8PostingAccount,
  GoldenCoastPhase8RoleAccounts,
} from "./parseGoldenCoastPhase8ContainerInput";

export function buildGoldenCoastPhase8FundingPosting(input: {
  container: GoldenCoastPhase8ContainerInput;
  plan: GoldenCoastPhase8FundingPlan;
  accounts: GoldenCoastPhase8RoleAccounts;
  actor?: PostingActor;
}): CentralPostingRequest {
  const { container, plan, accounts } = input;
  const entries: Array<Record<string, unknown>> = [
    {
      ledgerAccountId: accounts.stockOtwAccountId,
      debitAmount: plan.goodsCostUsd,
      creditAmount: "0.00",
      narration: `Golden Coast container ${container.invoiceNumber} goods in transit`,
    },
  ];
  if (new Decimal(plan.reserveUsd).gt(0)) {
    entries.push({
      ledgerAccountId: accounts.containerReserveAccountId,
      debitAmount: plan.reserveUsd,
      creditAmount: "0.00",
      narration: `Golden Coast container ${container.invoiceNumber} real reserve set aside`,
    });
  }
  entries.push({
    ...accountTarget(container.fundingAccount),
    debitAmount: "0.00",
    creditAmount: plan.totalFundingUsd,
    narration: `Golden Coast container ${container.invoiceNumber} funding`,
  });

  const built = buildGenericVoucherPostingRequest({
    companyId: container.companyId,
    clientRequestId: `gc8-${container.clientRequestId}-fund`,
    voucher: {
      voucherNumber: `GC-C8-${container.companyId}-${container.clientRequestId}-F`,
      voucherType: "Journal",
      voucherDate: container.invoiceDate,
      description: releaseDebtEnglish(`Golden Coast Phase 8 container funding — ${container.invoiceNumber}`),
      currency: "USD",
    },
    entries,
    exchangeRate: null,
    actor: input.actor,
  });
  return {
    ...built.request,
    source: {
      sourceType: GOLDEN_COAST_PHASE8_SOURCE_TYPE,
      sourceId: `container:${container.clientRequestId}:${plan.digest.slice(0, 20)}:fund`,
      idempotencyKey: `gc8:${container.companyId}:${container.clientRequestId}:fund`,
    },
  };
}

/** Post Fresh Start invoice against GC Goods OTW and its internal clearing
 * account, NOT a supplier payable or Cash/Bank account.
 */
export function buildGoldenCoastFreshStartExcelFundingPosting(input: {
  container: GoldenCoastPhase8ContainerInput;
  invoiceTotalUsd: string;
  otwClearingAccountId: number;
  stockOtwAccountId: number;
  actor?: PostingActor;
}): CentralPostingRequest {
  const { container, invoiceTotalUsd, otwClearingAccountId, stockOtwAccountId } = input;
  const amount = decimal(invoiceTotalUsd, "invoiceTotalUsd");
  if (!amount.gt(0) || amount.decimalPlaces() > MONEY_SCALE) {
    throw new GoldenCoastPhase8Error("invoiceTotalUsd must be positive with at most two decimals");
  }
  const entries = [
    {
      ledgerAccountId: stockOtwAccountId,
      debitAmount: money(amount),
      creditAmount: "0.00",
      narration: `Fresh Start FZE container ${container.invoiceNumber} goods in transit`,
    },
    {
      ledgerAccountId: otwClearingAccountId,
      debitAmount: "0.00",
      creditAmount: money(amount),
      narration: `Fresh Start FZE container ${container.invoiceNumber} Goods OTW Clearing`,
    },
  ];
  const built = buildGenericVoucherPostingRequest({
    companyId: container.companyId,
    clientRequestId: `gc8-${container.clientRequestId}-fund`,
    voucher: {
      voucherNumber: `GC-C8-${container.companyId}-${container.clientRequestId}-F`,
      voucherType: "Journal",
      voucherDate: container.invoiceDate,
      description: releaseDebtEnglish(`Golden Coast Fresh Start container funding — ${container.invoiceNumber}`),
      currency: "USD",
    },
    entries,
    exchangeRate: null,
    actor: input.actor,
  });
  return {
    ...built.request,
    source: {
      sourceType: GOLDEN_COAST_PHASE8_SOURCE_TYPE,
      sourceId: `container:${container.clientRequestId}:${createHash("sha256").update(JSON.stringify({ container, invoiceTotalUsd })).digest("hex").slice(0, 20)}:${GOLDEN_COAST_FRESH_START_EXCEL_FUNDING_MARKER}`,
      idempotencyKey: `gc8:${container.companyId}:${container.clientRequestId}:fund`,
    },
  };
}

export function buildGoldenCoastPhase8OffloadPosting(input: {
  offload: GoldenCoastPhase8OffloadInput;
  funded: GoldenCoastPhase8FundedContainerState;
  plan: GoldenCoastPhase8OffloadPlan;
  accounts: GoldenCoastPhase8RoleAccounts;
  actor?: PostingActor;
}): CentralPostingRequest {
  const { offload, funded, plan, accounts } = input;
  const entries: Array<Record<string, unknown>> = [
    {
      ledgerAccountId: accounts.stockInHandAccountId,
      debitAmount: plan.totalFinalCostUsd,
      creditAmount: "0.00",
      narration: `Golden Coast container #${offload.containerId} stock received`,
    },
    {
      ledgerAccountId: accounts.stockOtwAccountId,
      debitAmount: "0.00",
      creditAmount: plan.goodsCostUsd,
      narration: `Golden Coast container #${offload.containerId} clears Stock OTW`,
    },
  ];
  const reserve = new Decimal(plan.reserveUsd);
  const unused = new Decimal(plan.unusedReserveUsd);
  // A cutover container has no reserve to clear and no unused remainder to
  // sweep. Its actual charges are paid at offload, so they credit the funding
  // account the operator named instead of a pre-funded reserve.
  if (funded.origin === "cutover" || funded.origin === "fresh_start_excel") {
    const actual = new Decimal(plan.actualChargesUsd);
    if (actual.gt(0)) {
      if (!offload.chargeFundingAccount) {
        throw new GoldenCoastPhase8Error(
          "chargeFundingAccount is required to offload a cutover container with charges",
          "GC_PHASE8_CHARGE_FUNDING_REQUIRED"
        );
      }
      entries.push({
        ...accountTarget(offload.chargeFundingAccount),
        debitAmount: "0.00",
        creditAmount: plan.actualChargesUsd,
        narration: `Golden Coast container #${offload.containerId} cutover charges paid at offload`,
      });
    }
  } else {
    if (reserve.gt(0)) {
      entries.push({
        ledgerAccountId: accounts.containerReserveAccountId,
        debitAmount: "0.00",
        creditAmount: plan.reserveUsd,
        narration: `Golden Coast container #${offload.containerId} clears funded reserve`,
      });
    }
    if (unused.gt(0)) {
      entries.push(
        {
          ...accountTarget(funded.fundingAccount),
          debitAmount: plan.unusedReserveUsd,
          creditAmount: "0.00",
          narration: `Golden Coast container #${offload.containerId} unused reserve returned to funding account`,
        },
        {
          ledgerAccountId: accounts.hassanEquityAccountId,
          debitAmount: plan.unusedReserveUsd,
          creditAmount: "0.00",
          narration: `Golden Coast container #${offload.containerId} unused reserve reclassified from Hassan equity`,
        },
        {
          ledgerAccountId: accounts.hassanSavingsAccountId,
          debitAmount: "0.00",
          creditAmount: plan.unusedReserveUsd,
          narration: `Golden Coast container #${offload.containerId} unused reserve moved to Hassan Savings`,
        }
      );
    }
  }

  const built = buildGenericVoucherPostingRequest({
    companyId: offload.companyId,
    clientRequestId: `gc8-${offload.clientRequestId}-offload`,
    voucher: {
      voucherNumber: `GC-C8-${offload.companyId}-${offload.clientRequestId}-O`,
      voucherType: "Journal",
      voucherDate: offload.offloadDate,
      locationId: offload.locationId,
      description: releaseDebtEnglish(`Golden Coast Phase 8 container offload #${offload.containerId}`),
      currency: "USD",
    },
    entries,
    exchangeRate: null,
    actor: input.actor,
  });
  return {
    ...built.request,
    source: {
      sourceType: GOLDEN_COAST_PHASE8_SOURCE_TYPE,
      sourceId: `container:${offload.containerId}:${offload.clientRequestId}:${plan.digest.slice(0, 20)}:offload`,
      idempotencyKey: `gc8:${offload.companyId}:${offload.clientRequestId}:offload`,
    },
  };
}
