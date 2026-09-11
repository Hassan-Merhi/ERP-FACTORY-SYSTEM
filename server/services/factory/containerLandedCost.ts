/**
 * Shared, authoritative landed-cost computation for a factory container.
 *
 * Business rule: the full material value is based on the original agreed
 * container quantity (`totalKg || declaredKg`) and all landed charges are added
 * once. That fixed total value is then divided by the actual received weight,
 * so a shortage raises cost/kg and an overage lowers cost/kg without changing
 * the container's total value.
 */
import Decimal from "decimal.js";
import { factoryContainers } from "@shared/schema";
import { resolveFactoryOffloadValuationKg } from "@shared/factoryOffloadValuation";
import { resolveStoredFxRate } from "./currencyConversion";
import { FACTORY_COST_PRECISION, calculateCostLine, factoryCostDecimal } from "./factoryCostingEngine";

/** Compatibility export used by recalc and existing tests. */
export const COST_SCALE = FACTORY_COST_PRECISION.rate;

export interface ContainerLandedCostResult {
  valuationKg: number;
  allocationKg: number;
  fullCost: number;
  fullCostUsd: number;
  costPerKg: number;
  costPerKgUsd: number;
  fxUnresolved: boolean;
}

/** The four fields the helper actually reads from any charge/commission-like row. */
type ChargeMoneyFields = {
  amount?: string | null;
  currencyCode?: string | null;
  fxRateToUsd?: string | null;
  fxRateConfirmed?: boolean | null;
};

export function computeContainerLandedCost(
  container: typeof factoryContainers.$inferSelect,
  additionalCharges: ChargeMoneyFields[],
  commissionRecord: (ChargeMoneyFields & { commissionTotal?: string | null }) | null,
  otherChargesRows?: ChargeMoneyFields[]
): ContainerLandedCostResult {
  const containerCcy = container.currencyCode || "USD";
  const { fxRate, looksSet: fxLooksSet } = resolveStoredFxRate(
    containerCcy,
    container.fxRateToUsdOffload || container.fxRateToUsd,
    container.fxRateConfirmed
  );
  if (!fxLooksSet) {
    return {
      valuationKg: 0,
      allocationKg: 0,
      fullCost: 0,
      fullCostUsd: 0,
      costPerKg: 0,
      costPerKgUsd: 0,
      fxUnresolved: true,
    };
  }

  const originalCostBasisKg = factoryCostDecimal(
    resolveFactoryOffloadValuationKg({
      totalKg: container.totalKg,
      declaredKg: container.declaredKg,
      receivedKg: container.actualReceivedKg,
    }),
    "container.valuationKg"
  );
  if (originalCostBasisKg.lte(0)) {
    return {
      valuationKg: 0,
      allocationKg: 0,
      fullCost: 0,
      fullCostUsd: 0,
      costPerKg: 0,
      costPerKgUsd: 0,
      fxUnresolved: false,
    };
  }

  // Keep the numerator fixed from the agreed container quantity, but divide
  // that fixed total value by the actual received weight entered at offload.
  const receivedKg = factoryCostDecimal(container.actualReceivedKg || "0", "container.actualReceivedKg");
  const allocationKg = receivedKg.gt(0) ? receivedKg : originalCostBasisKg;
  const dFxRate = factoryCostDecimal(fxRate, "container.fxRateToUsd", { allowZero: false });
  const baseRate = factoryCostDecimal(container.ratePerKg || "0", "container.ratePerKg");
  const basePayable = calculateCostLine(originalCostBasisKg, baseRate).totalCost;
  const baseMaterialUsd = containerCcy === "USD" ? basePayable : basePayable.times(dFxRate);

  const freightVal = factoryCostDecimal(container.freight || "0", "container.freight");
  const freightCcy = container.freightCurrencyCode || containerCcy;
  const rawFreightFx = parseFloat(container.freightFxRateToUsd || "");
  const freightFxConfirmed = !!container.freightFxRateConfirmed;
  let dFreightFx: Decimal;
  let freightFxUnresolved = false;
  if (freightCcy === "USD") {
    dFreightFx = new Decimal(1);
  } else if (Number.isFinite(rawFreightFx) && rawFreightFx > 0 && freightFxConfirmed) {
    dFreightFx = new Decimal(rawFreightFx);
  } else if (freightCcy === containerCcy) {
    dFreightFx = dFxRate;
  } else if (freightVal.gt(0)) {
    freightFxUnresolved = true;
    dFreightFx = new Decimal(0);
  } else {
    dFreightFx = dFxRate;
  }
  const freightUsd = freightCcy === "USD" ? freightVal : freightVal.times(dFreightFx);
  const freightInContainerCcy =
    freightCcy === containerCcy ? freightVal : dFxRate.gt(0) ? freightUsd.div(dFxRate) : freightVal;

  let ocInContainerCcy: Decimal;
  let ocUsd: Decimal;
  let ocFxUnresolved = false;
  if (otherChargesRows && otherChargesRows.length > 0) {
    ocInContainerCcy = new Decimal(0);
    ocUsd = new Decimal(0);
    for (const otherCharge of otherChargesRows) {
      const amount = factoryCostDecimal(otherCharge.amount || "0", "otherCharge.amount");
      const currency = otherCharge.currencyCode || containerCcy;
      const rawFx = parseFloat(otherCharge.fxRateToUsd || "");
      const confirmed = !!otherCharge.fxRateConfirmed;
      let chargeFx: Decimal;
      if (currency === "USD") {
        chargeFx = new Decimal(1);
      } else if (Number.isFinite(rawFx) && rawFx > 0 && confirmed) {
        chargeFx = new Decimal(rawFx);
      } else if (currency === containerCcy) {
        chargeFx = dFxRate;
      } else if (amount.gt(0)) {
        ocFxUnresolved = true;
        continue;
      } else {
        chargeFx = dFxRate;
      }
      const amountUsd = currency === "USD" ? amount : amount.times(chargeFx);
      const amountInContainerCcy = currency === containerCcy ? amount : dFxRate.gt(0) ? amountUsd.div(dFxRate) : amount;
      ocInContainerCcy = ocInContainerCcy.plus(amountInContainerCcy);
      ocUsd = ocUsd.plus(amountUsd);
    }
  } else {
    const amount = factoryCostDecimal(container.otherCharges || "0", "container.otherCharges");
    const currency = container.otherChargesCurrencyCode || containerCcy;
    if (currency === "USD") {
      ocUsd = amount;
      ocInContainerCcy = containerCcy === "USD" ? amount : amount.div(dFxRate);
    } else if (currency === containerCcy) {
      ocInContainerCcy = amount;
      ocUsd = amount.times(dFxRate);
    } else if (amount.gt(0)) {
      ocFxUnresolved = true;
      ocUsd = new Decimal(0);
      ocInContainerCcy = new Decimal(0);
    } else {
      ocUsd = new Decimal(0);
      ocInContainerCcy = new Decimal(0);
    }
  }

  let commissionUsd = new Decimal(0);
  let commissionInContainerCcy = new Decimal(0);
  let commissionFxUnresolved = false;

  function applyCommissionFx(amount: Decimal, currency: string, commissionFx: Decimal): void {
    if (currency === "USD") {
      commissionUsd = amount;
      commissionInContainerCcy = containerCcy === "USD" ? amount : amount.div(dFxRate);
    } else if (currency === containerCcy) {
      commissionInContainerCcy = amount;
      commissionUsd = amount.times(dFxRate);
    } else {
      commissionUsd = amount.times(commissionFx);
      commissionInContainerCcy = commissionUsd.div(dFxRate);
    }
  }

  if (commissionRecord) {
    const amount = factoryCostDecimal(commissionRecord.commissionTotal || "0", "commission.commissionTotal");
    const currency = commissionRecord.currencyCode || containerCcy;
    const rawFx = parseFloat(commissionRecord.fxRateToUsd || "");
    const confirmed = commissionRecord.fxRateConfirmed === true;
    if (currency === "USD") {
      applyCommissionFx(amount, "USD", new Decimal(1));
    } else if (currency === containerCcy) {
      applyCommissionFx(amount, currency, dFxRate);
    } else if (Number.isFinite(rawFx) && rawFx > 0 && confirmed) {
      applyCommissionFx(amount, currency, new Decimal(rawFx));
    } else {
      const snapshotFx = parseFloat(container.commissionFxRateToUsd || "");
      const snapshotConfirmed = container.commissionFxRateConfirmed === true;
      if (Number.isFinite(snapshotFx) && snapshotFx > 0 && snapshotConfirmed) {
        applyCommissionFx(amount, currency, new Decimal(snapshotFx));
      } else {
        commissionFxUnresolved = true;
      }
    }
  } else {
    const amount = factoryCostDecimal(container.commissionAmount || "0", "container.commissionAmount");
    const currency = container.commissionCurrencyCode || containerCcy;
    if (currency === "USD") {
      applyCommissionFx(amount, "USD", new Decimal(1));
    } else if (currency === containerCcy) {
      applyCommissionFx(amount, currency, dFxRate);
    } else {
      const snapshotFx = parseFloat(container.commissionFxRateToUsd || "");
      const snapshotConfirmed = container.commissionFxRateConfirmed === true;
      if (Number.isFinite(snapshotFx) && snapshotFx > 0 && snapshotConfirmed) {
        applyCommissionFx(amount, currency, new Decimal(snapshotFx));
      } else if (amount.gt(0)) {
        commissionFxUnresolved = true;
      }
    }
  }

  const dutyValue =
    container.dutyStatus === "CONFIRMED"
      ? factoryCostDecimal(container.dutyAmount || "0", "container.dutyAmount")
      : new Decimal(0);
  const dutyUsd = containerCcy === "USD" ? dutyValue : dutyValue.times(dFxRate);

  let additionalInContainerCcy = new Decimal(0);
  let additionalUsd = new Decimal(0);
  let additionalFxUnresolved = false;
  for (const charge of additionalCharges) {
    const amount = factoryCostDecimal(charge.amount || "0", "additionalCharge.amount");
    const currency = charge.currencyCode || containerCcy;
    const rawFx = parseFloat(charge.fxRateToUsd || "");
    const confirmed = !!charge.fxRateConfirmed;
    let chargeFx: Decimal;
    if (currency === "USD") {
      chargeFx = new Decimal(1);
    } else if (Number.isFinite(rawFx) && rawFx > 0 && confirmed) {
      chargeFx = new Decimal(rawFx);
    } else if (currency === containerCcy) {
      chargeFx = dFxRate;
    } else if (amount.gt(0)) {
      additionalFxUnresolved = true;
      continue;
    } else {
      chargeFx = dFxRate;
    }
    const amountUsd = currency === "USD" ? amount : amount.times(chargeFx);
    const amountInContainerCcy = currency === containerCcy ? amount : amountUsd.div(dFxRate);
    additionalInContainerCcy = additionalInContainerCcy.plus(amountInContainerCcy);
    additionalUsd = additionalUsd.plus(amountUsd);
  }

  const totalCost = basePayable
    .plus(freightInContainerCcy)
    .plus(ocInContainerCcy)
    .plus(commissionInContainerCcy)
    .plus(dutyValue)
    .plus(additionalInContainerCcy);
  const totalUsd = baseMaterialUsd.plus(freightUsd).plus(ocUsd).plus(commissionUsd).plus(dutyUsd).plus(additionalUsd);

  return {
    valuationKg: originalCostBasisKg.toNumber(),
    allocationKg: allocationKg.toNumber(),
    fullCost: totalCost.toNumber(),
    fullCostUsd: totalUsd.toNumber(),
    costPerKg: totalCost.div(allocationKg).toDecimalPlaces(COST_SCALE).toNumber(),
    costPerKgUsd: totalUsd.div(allocationKg).toDecimalPlaces(COST_SCALE).toNumber(),
    fxUnresolved: commissionFxUnresolved || freightFxUnresolved || ocFxUnresolved || additionalFxUnresolved,
  };
}
