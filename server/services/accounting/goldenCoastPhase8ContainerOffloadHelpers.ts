// Extracted from ./goldenCoastPhase8ContainerOffload.ts
import Decimal from "decimal.js";
import {
  GoldenCoastPhase8Error,
  MONEY_SCALE,
  QUANTITY_SCALE,
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
  type GoldenCoastPhase8FundedContainerState,
  type GoldenCoastPhase8OffloadInput,
  type GoldenCoastPhase8OffloadLinePlan,
  type GoldenCoastPhase8OffloadPlan,
} from "./parseGoldenCoastPhase8ContainerInput";

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
