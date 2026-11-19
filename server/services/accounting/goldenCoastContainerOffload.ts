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
  QUANTITY_SCALE,
  accountTarget,
  decimal,
  digest,
  isoDate,
  money,
  optionalText,
  positiveId,
  postingAccount,
  record,
  requestId,
  type GoldenCoastPhase8ChargeInput,
  type GoldenCoastPhase8ContainerInput,
  type GoldenCoastPhase8FundedContainerState,
  type GoldenCoastPhase8FundingPlan,
  type GoldenCoastPhase8OffloadInput,
  type GoldenCoastPhase8OffloadLinePlan,
  type GoldenCoastPhase8OffloadPlan,
  type GoldenCoastPhase8RoleAccounts,
} from "./parseGoldenCoastContainerInput";
export {
  GOLDEN_COAST_FRESH_START_EXCEL_FUNDING_MARKER,
  GOLDEN_COAST_PHASE8_MAX_REQUEST_ID_LENGTH,
  GOLDEN_COAST_PHASE8_OFFLOAD_FIFO_SOURCE,
  GOLDEN_COAST_PHASE8_SOURCE_TYPE,
  GoldenCoastPhase8Error,
  parseGoldenCoastPhase8ContainerInput,
  planGoldenCoastPhase8Funding,
} from "./parseGoldenCoastContainerInput";
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
} from "./parseGoldenCoastContainerInput";

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

export function parseGoldenCoastPhase8OffloadInput(input: {
  companyId: number;
  body: unknown;
  maxCharges?: number;
}): GoldenCoastPhase8OffloadInput {
  const companyId = positiveId(input.companyId, "companyId");
  const raw = record(input.body, "request body");
  const maxCharges = input.maxCharges ?? 50;
  const chargeRows = raw.charges == null ? [] : raw.charges;
  if (!Array.isArray(chargeRows)) throw new GoldenCoastPhase8Error("charges must be an array");
  if (chargeRows.length > maxCharges)
    throw new GoldenCoastPhase8Error(`charges must contain at most ${maxCharges} items`);
  const charges = chargeRows.map((value, index): GoldenCoastPhase8ChargeInput => {
    const charge = record(value, `charges[${index}]`);
    if (charge.chargeType !== "duty" && charge.chargeType !== "transport" && charge.chargeType !== "other") {
      throw new GoldenCoastPhase8Error(`charges[${index}].chargeType must be duty, transport, or other`);
    }
    const amount = decimal(charge.amountUsd, `charges[${index}].amountUsd`);
    if (!amount.gt(0) || amount.decimalPlaces() > MONEY_SCALE) {
      throw new GoldenCoastPhase8Error(
        `charges[${index}].amountUsd must be greater than zero with at most ${MONEY_SCALE} decimals`
      );
    }
    return {
      chargeType: charge.chargeType,
      description: optionalText(charge.description, `charges[${index}].description`, 500),
      amountUsd: money(amount),
    };
  });
  return {
    companyId,
    clientRequestId: requestId(raw.clientRequestId),
    containerId: positiveId(raw.containerId, "containerId"),
    locationId: positiveId(raw.locationId, "locationId"),
    offloadDate: isoDate(raw.offloadDate, "offloadDate"),
    charges,
    chargeFundingAccount:
      raw.chargeFundingAccount == null ? null : postingAccount(raw.chargeFundingAccount, "chargeFundingAccount"),
  };
}

export function planGoldenCoastPhase8Offload(input: {
  offload: GoldenCoastPhase8OffloadInput;
  funded: GoldenCoastPhase8FundedContainerState;
}): GoldenCoastPhase8OffloadPlan {
  const { offload, funded } = input;
  if (offload.companyId !== funded.companyId || offload.containerId !== funded.containerId) {
    throw new GoldenCoastPhase8Error(
      "Offload does not belong to the funded container company",
      "GC_PHASE8_SCOPE_MISMATCH"
    );
  }
  const goods = new Decimal(funded.goodsCostUsd);
  const reserve = new Decimal(funded.reserveUsd);
  const actual = offload.charges.reduce((sum, charge) => sum.plus(charge.amountUsd), new Decimal(0));
  // A cutover container never had a reserve funded for it, so there is no
  // ceiling to exceed and nothing to sweep back: its charges settle straight
  // against the funding account the operator names on the offload.
  if (funded.origin === "cutover" || funded.origin === "fresh_start_excel") {
    if (!reserve.isZero()) {
      throw new GoldenCoastPhase8Error(
        "An unfunded-clearing container cannot carry a cash reserve",
        "GC_PHASE8_SCOPE_MISMATCH"
      );
    }
    if (actual.gt(0) && !offload.chargeFundingAccount) {
      throw new GoldenCoastPhase8Error(
        "chargeFundingAccount is required to offload a cutover container with charges",
        "GC_PHASE8_CHARGE_FUNDING_REQUIRED"
      );
    }
  } else if (actual.gt(reserve)) {
    throw new GoldenCoastPhase8Error(
      `Actual container charges ${money(actual)} exceed the funded reserve ${money(reserve)}`,
      "GC_PHASE8_RESERVE_EXCEEDED"
    );
  }
  const unused =
    funded.origin === "cutover" || funded.origin === "fresh_start_excel" ? new Decimal(0) : reserve.minus(actual);
  const totalQty = funded.lines.reduce((sum, line) => sum.plus(line.qty), new Decimal(0));
  if (!totalQty.gt(0)) throw new GoldenCoastPhase8Error("Funded container has no positive quantity");
  const grossLines = funded.lines.reduce(
    (sum, line) => sum.plus(new Decimal(line.qty).times(line.unitRateUsd)),
    new Decimal(0)
  );
  // Original item rates remain unchanged; net invoice freight, fees and
  // discount already in Goods OTW are allocated as landed cost at offload.
  const invoiceAdjustment = funded.origin === "fresh_start_excel" ? goods.minus(grossLines) : new Decimal(0);
  const landedPerUnit = actual.plus(invoiceAdjustment).div(totalQty);
  const lines = funded.lines.map((line): GoldenCoastPhase8OffloadLinePlan => {
    const base = new Decimal(line.unitRateUsd);
    const final = base.plus(landedPerUnit);
    return {
      ...line,
      // `landedUnitCostUsd` carries the per-unit charge allocation on its own,
      // matching what the pre-Golden-Coast offload route writes to the same
      // `sp_stock_movements` column; `finalUnitCostUsd` is base + allocation.
      baseUnitCostUsd: base.toDecimalPlaces(6).toFixed(6),
      landedUnitCostUsd: landedPerUnit.toDecimalPlaces(6).toFixed(6),
      finalUnitCostUsd: final.toDecimalPlaces(6).toFixed(6),
    };
  });
  return {
    goodsCostUsd: money(goods),
    reserveUsd: money(reserve),
    actualChargesUsd: money(actual),
    unusedReserveUsd: money(unused),
    totalQty: totalQty.toDecimalPlaces(QUANTITY_SCALE).toFixed(QUANTITY_SCALE),
    totalFinalCostUsd: money(goods.plus(actual)),
    lines,
    digest: digest({
      companyId: offload.companyId,
      containerId: offload.containerId,
      locationId: offload.locationId,
      offloadDate: offload.offloadDate,
      charges: offload.charges,
      chargeFundingAccount: offload.chargeFundingAccount,
      origin: funded.origin,
      fundingVoucherId: funded.fundingVoucherId,
      goodsCostUsd: funded.goodsCostUsd,
      reserveUsd: funded.reserveUsd,
      fundingAccount: funded.fundingAccount,
    }),
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
