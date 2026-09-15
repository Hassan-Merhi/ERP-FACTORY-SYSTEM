/**
 * Pure cost and payload math for the production raw-stock OffloadDialog.
 *
 * Extracted from OffloadDialog.tsx during the P1 god-file split. These
 * functions own the accounting-sensitive behavior: the estimated landed
 * cost per kg, partial-receipt values, the account-reference parse
 * ("SUP:<id>" vs ledger id), and the exact PUT payload the server posts.
 */

import { resolveFactoryOffloadValuationKg } from "@shared/factoryOffloadValuation";
import type { AdditionalCharge, OffloadContainer, OffloadFormFields, OffloadPayload } from "./offloadDialogTypes";

/** Account combobox values are "SUP:<supplierId>" or a bare ledger account id. */
export function parseAccountValue(val: string): { type: "supplier" | "ledger"; id: number } | null {
  if (!val) return null;
  if (val.startsWith("SUP:")) return { type: "supplier", id: parseInt(val.split(":")[1]) };
  return { type: "ledger", id: parseInt(val) };
}

function positiveRate(value: string | null | undefined): number | null {
  const parsed = parseFloat(value || "");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Resolve the material FX rate that will be posted for a first offload.
 *
 * A same-currency charge (freight / other charges / commission) and the base
 * material cannot legitimately use two different USD rates on the same offload.
 * The form can currently hold an older container/import FX snapshot while a
 * same-currency charge has already resolved the offload-date FX rate. Prefer the
 * resolved same-currency charge rate so the estimate and submitted payload stay
 * consistent. Different-currency charges keep their own independent FX rates.
 */
export function resolveOffloadMaterialFxRate(fields: OffloadFormFields): string {
  const containerCcy = (fields.currencyCode || "USD").toUpperCase();
  if (containerCcy === "USD") return "1";

  const candidates: Array<{ amount: string; currency: string; rate: string }> = [
    {
      amount: fields.freight,
      currency: fields.freightCurrencyCode,
      rate: fields.freightFxRate,
    },
    {
      amount: fields.otherCharges,
      currency: fields.otherChargesCurrencyCode,
      rate: fields.otherChargesFxRate,
    },
  ];

  for (const candidate of candidates) {
    if (parseFloat(candidate.amount || "0") <= 0) continue;
    if ((candidate.currency || containerCcy).toUpperCase() !== containerCcy) continue;
    const rate = positiveRate(candidate.rate);
    if (rate) return String(rate);
  }

  if (
    fields.commissionPersonName.trim() &&
    parseFloat(fields.commissionRate || "0") > 0 &&
    fields.containerCommissionCcy.toUpperCase() === containerCcy
  ) {
    const rate = positiveRate(fields.commissionFxRate);
    if (rate) return String(rate);
  }

  return String(positiveRate(fields.fxRateToUsd) ?? 1);
}

export interface PartialReceiptInfo {
  declared: number;
  alreadyReceived: number;
  remaining: number;
}

/** Breakdown info for PARTIALLY_RECEIVED containers (charges are locked). */
export function computePartialReceiptInfo(container: OffloadContainer): PartialReceiptInfo | null {
  if (container.status !== "PARTIALLY_RECEIVED") return null;
  const declared = parseFloat(container.totalKg || "0");
  const alreadyReceived = parseFloat(container.actualReceivedKg || "0");
  const remaining = Math.max(0, declared - alreadyReceived);
  return { declared, alreadyReceived, remaining };
}

/** Live receipt value for subsequent receipts — receivingNow × fixedCostPerKgUsd (USD). */
export function computeReceiptValue(container: OffloadContainer | null, actualReceivedKg: string): number | null {
  if (!container || container.status !== "PARTIALLY_RECEIVED") return null;
  const kg = parseFloat(actualReceivedKg || "0");
  const rate = parseFloat(container.fixedCostPerKgUsd || "0");
  if (!kg || !rate) return null;
  return kg * rate;
}

export interface EstimatedAvgCostKgInputs {
  actualReceivedKg: string;
  selectedContainerId: string;
  selectedContainer: OffloadContainer | null;
  costPerKg: string;
  fxRateToUsd: string;
  freight: string;
  freightFxRate: string;
  otherCharges: string;
  otherChargesFxRate: string;
  commissionPersonName: string;
  commissionRate: string;
  commissionFxRate: string;
  commissionType: "PER_KG" | "FIXED";
  additionalCharges: AdditionalCharge[];
  dutyAmount: string;
  dutyPending: boolean;
}

/**
 * Estimated landed cost per received kg: (material + freight + other charges
 * + commission + extra charges + duty) converted to USD, divided by the
 * actual received weight. Uses the valuation kg (resolved from declared vs
 * total weight) for per-kg components, mirroring the server-side valuation.
 */
export function computeEstimatedAvgCostKg(inputs: EstimatedAvgCostKgInputs): number | null {
  const receivedKg = parseFloat(inputs.actualReceivedKg || "0");
  const container = inputs.selectedContainer;
  if (!receivedKg || !inputs.selectedContainerId || !container) return null;

  const valuationKg = resolveFactoryOffloadValuationKg({
    totalKg: container.totalKg,
    declaredKg: container.declaredKg,
    receivedKg,
  });
  if (valuationKg <= 0) return null;

  const containerCcy = (container.currencyCode || "USD").toUpperCase();
  const storedMaterialFx = positiveRate(inputs.fxRateToUsd) ?? 1;
  const freightCcy = (container.freightCurrencyCode || containerCcy).toUpperCase();
  const otherChargesCcy = (container.otherChargesCurrencyCode || containerCcy).toUpperCase();
  const sameCurrencyFreightFx = positiveRate(inputs.freightFxRate);
  const sameCurrencyOtherFx = positiveRate(inputs.otherChargesFxRate);
  const hasSameCurrencyFreight =
    parseFloat(inputs.freight || "0") > 0 && freightCcy === containerCcy && sameCurrencyFreightFx !== null;
  const hasSameCurrencyOtherCharges =
    parseFloat(inputs.otherCharges || "0") > 0 &&
    otherChargesCcy === containerCcy &&
    sameCurrencyOtherFx !== null;

  // A manually-entered same-currency charge is just as authoritative as a
  // prefilled one. The previous guard required the entered amount to equal the
  // container's stored charge, so typing AUD freight into an AUD container left
  // the material on an older FX snapshot while freight used the current rate.
  const materialFx =
    containerCcy === "USD"
      ? 1
      : hasSameCurrencyFreight
        ? sameCurrencyFreightFx!
        : hasSameCurrencyOtherCharges
          ? sameCurrencyOtherFx!
          : storedMaterialFx;

  const materialUsd = parseFloat(inputs.costPerKg || "0") * materialFx * valuationKg;
  const freightUsd = parseFloat(inputs.freight || "0") * parseFloat(inputs.freightFxRate || "1");
  const otherUsd = parseFloat(inputs.otherCharges || "0") * parseFloat(inputs.otherChargesFxRate || "1");

  let commissionUsd = 0;
  if (inputs.commissionPersonName.trim() && parseFloat(inputs.commissionRate || "0") > 0) {
    const commBase = parseFloat(inputs.commissionRate || "0") * parseFloat(inputs.commissionFxRate || "1");
    commissionUsd = inputs.commissionType === "PER_KG" ? commBase * valuationKg : commBase;
  }

  const extraUsd = inputs.additionalCharges
    .filter((c) => parseFloat(c.amount || "0") > 0)
    .reduce((sum, c) => sum + parseFloat(c.amount || "0") * parseFloat(c.fxRate || "1"), 0);

  const dutyUsd = inputs.dutyPending ? 0 : parseFloat(inputs.dutyAmount || "0");
  const totalUsd = materialUsd + freightUsd + otherUsd + commissionUsd + extraUsd + dutyUsd;

  return totalUsd / receivedKg;
}

/**
 * Assembles the offload PUT payload from the form snapshot. Pure — the
 * idempotency key is generated and reused by the dialog and passed in.
 */
export function buildOffloadPayload(fields: OffloadFormFields, idempotencyKey: string): OffloadPayload {
  // The dialog guards `selectedContainerId` before calling this; the builder
  // itself stays pure and total (no user-facing error string introduced here).
  const dutyStatus = fields.dutyPending ? "PENDING" : parseFloat(fields.dutyAmount || "0") > 0 ? "CONFIRMED" : "NONE";
  const effectiveFxRateToUsd = resolveOffloadMaterialFxRate(fields);
  const fxRate = parseFloat(effectiveFxRateToUsd || "1");

  const payload: OffloadPayload = {
    containerId: fields.selectedContainerId,
    offloadDate: fields.offloadDate,
    destination: fields.offloadDestination.trim() || null,
    receivedKg: fields.actualReceivedKg,
    costPerKg: fields.costPerKg,
    currencyCode: fields.currencyCode,
    fxRateToUsd: effectiveFxRateToUsd,
    freight: fields.freight || "0",
    freightCurrencyCode: fields.freightCurrencyCode,
    freightFxRate: fields.freightFxRate,
    ...(() => {
      const p = parseAccountValue(fields.freightAccountId);
      return p?.type === "supplier" ? { freightSupplierId: p.id } : { freightAccountId: p?.id ?? null };
    })(),
    ...(() => {
      const p = parseAccountValue(fields.otherChargesAccountId);
      return p?.type === "supplier"
        ? {
            otherChargesSupplierId: p.id,
            otherCharges: fields.otherCharges || "0",
            otherChargesCurrencyCode: fields.otherChargesCurrencyCode,
            otherChargesFxRate: fields.otherChargesFxRate,
          }
        : {
            otherChargesAccountId: p?.id ?? null,
            otherCharges: fields.otherCharges || "0",
            otherChargesCurrencyCode: fields.otherChargesCurrencyCode,
            otherChargesFxRate: fields.otherChargesFxRate,
          };
    })(),
    dutyAmount: (() => {
      const rawAmt = parseFloat(fields.dutyAmount || "0");
      if (rawAmt === 0) return "0";
      if (fields.currencyCode === "USD") return fields.dutyAmount || "0";
      return String(rawAmt / (fxRate || 1));
    })(),
    dutyAccountId: fields.dutyAccountId ? parseInt(fields.dutyAccountId) : null,
    dutyStatus,
    dutyNotes: fields.dutyNotes || null,
    additionalCharges: fields.additionalCharges
      .filter((c) => parseFloat(c.amount || "0") > 0)
      .map((c) => {
        const p = parseAccountValue(c.ledgerAccountId);
        return {
          description: c.description || "Additional Charge",
          amount: c.amount,
          currencyCode: c.currencyCode || "USD",
          fxRateToUsd: c.fxRate || (c.currencyCode === "USD" ? "1" : undefined),
          ledgerAccountId: p?.type === "ledger" ? p.id : null,
          supplierId: p?.type === "supplier" ? p.id : null,
        };
      }),
    mixBatchAllocations: fields.mixBatchAllocations
      .filter((a) => a.mixBatchId && parseFloat(a.weightKg || "0") > 0)
      .map((a) => ({
        mixBatchId: parseInt(a.mixBatchId || "0", 10),
        weightKg: a.weightKg,
      })),
  };

  if (fields.commissionPersonName.trim() && parseFloat(fields.commissionRate || "0") > 0) {
    const commCcy = (fields.commissionFromContainer ? fields.containerCommissionCcy : "USD").toUpperCase();
    payload.commission = {
      personName: fields.commissionPersonName.trim(),
      commissionType: fields.commissionType,
      commissionRate: fields.commissionRate,
      currencyCode: commCcy,
      // Always send the commission-specific FX rate, not the container's material FX.
      // The server validates/resolves this independently and is the authoritative source.
      fxRateToUsd: commCcy === "USD" ? "1" : fields.commissionFxRate,
      fxRateDate: fields.commissionFxEffectiveDate,
      ledgerAccountId: fields.commissionLedgerAccountId || null,
    };
  }

  payload.idempotencyKey = idempotencyKey;
  return payload;
}
