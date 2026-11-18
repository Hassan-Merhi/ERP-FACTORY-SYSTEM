// Extracted from ./postOffloadImpactPreview.ts to keep that module under the source-size cap.
import crypto from "node:crypto";
import Decimal from "decimal.js";
import { getFxRateToUsdReadOnly } from "./factoryFxRateReadOnly";

export const PREVIEW_KIND = "POST_OFFLOAD_IMPACT_PREVIEW_V1" as const;

export const PREVIEW_VERSION = 1 as const;

export interface PostOffloadImpactChargeInput {
  description?: unknown;
  amount?: unknown;
  currencyCode?: unknown;
  ledgerAccountId?: unknown;
  supplierId?: unknown;
}

interface NormalizedChargeRequest {
  description: string;
  amount: string;
  currencyCode: string;
  ledgerAccountId: number | null;
  supplierId: number | null;
}

interface ResolvedPreviewCharge extends NormalizedChargeRequest {
  fxRateToUsd: string;
  fxRateConfirmed: true;
  fxRateDate: string;
}

export interface PostOffloadImpactScope {
  supplierOwnedSources: number;
  affectedSourceRows: number;
  affectedBatches: number;
  openBatches: number;
  completedBatches: number;
  availableBales: number;
  finalizedBalesExcluded: number;
}

export interface PostOffloadImpactPreviewSummary {
  containerId: number;
  containerNumber: string;
  supplierId: number | null;
  transactionDate: string;
  chargeCount: number;
  currentContainerCostPerKgUsd: string;
  projectedContainerCostPerKgUsd: string;
  currentContainerTotalUsd: string;
  projectedContainerTotalUsd: string;
  fullContainerValueDeltaUsd: string;
  containerReceivedKg: string;
  containerRemainingKg: string;
  remainingFraction: string;
  supplierRemainingKg: string;
  supplierLockedRateBefore: string | null;
  supplierLockedRateProjected: string | null;
  supplierInventoryValueDeltaUsd: string;
  historicalReplaySafe: boolean;
  historicalReplayBlockedReasons: string[];
  scope: PostOffloadImpactScope;
}

export interface PostOffloadImpactPreviewTokenPayload {
  kind: typeof PREVIEW_KIND;
  version: typeof PREVIEW_VERSION;
  companyId: number;
  userId: string;
  containerId: number;
  transactionDate: string;
  requestFingerprint: string;
  stateFingerprint: string;
  preview: PostOffloadImpactPreviewSummary;
  expiresAt: number;
}

export interface PreparedPostOffloadImpactPreview {
  dryRun: true;
  confirmationToken: string;
  expiresInMs: number;
  preview: PostOffloadImpactPreviewSummary;
}

export class StalePostOffloadImpactPreviewError extends Error {
  readonly code = "POST_OFFLOAD_IMPACT_PREVIEW_STALE";
  readonly statusCode = 409;

  constructor(message = "Post-offload cost inputs changed after preview. Review the impact again before saving.") {
    super(message);
    this.name = "StalePostOffloadImpactPreviewError";
  }
}

export class InvalidPostOffloadImpactPreviewError extends Error {
  readonly code = "POST_OFFLOAD_IMPACT_PREVIEW_INVALID";
  readonly statusCode = 400;

  constructor(message: string) {
    super(message);
    this.name = "InvalidPostOffloadImpactPreviewError";
  }
}

function positiveId(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export function normalizeDate(value: unknown): string {
  const date = String(value ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new InvalidPostOffloadImpactPreviewError("A valid transaction date is required for preview.");
  }
  return date;
}

export function normalizePostOffloadImpactCharges(value: unknown): NormalizedChargeRequest[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new InvalidPostOffloadImpactPreviewError("At least one post-offload charge is required.");
  }

  const normalized = value.map((raw, index) => {
    const input = (raw ?? {}) as PostOffloadImpactChargeInput;
    let amount: Decimal;
    try {
      amount = new Decimal(String(input.amount ?? "0"));
    } catch {
      throw new InvalidPostOffloadImpactPreviewError(`Charge ${index + 1} has an invalid amount.`);
    }
    if (!amount.isFinite() || amount.lte(0)) {
      throw new InvalidPostOffloadImpactPreviewError(`Charge ${index + 1} amount must be greater than zero.`);
    }

    const currencyCode = String(input.currencyCode ?? "USD")
      .trim()
      .toUpperCase();
    if (!/^[A-Z]{3,10}$/.test(currencyCode)) {
      throw new InvalidPostOffloadImpactPreviewError(`Charge ${index + 1} has an invalid currency code.`);
    }

    return {
      description: String(input.description ?? "Post-offload charge").trim() || "Post-offload charge",
      amount: amount.toFixed(6),
      currencyCode,
      ledgerAccountId: positiveId(input.ledgerAccountId),
      supplierId: positiveId(input.supplierId),
    };
  });

  return normalized;
}

export function stableHash(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

export function computePostOffloadImpactRequestFingerprint(input: {
  containerId: number;
  transactionDate: string;
  charges: unknown;
}): string {
  return stableHash({
    containerId: input.containerId,
    transactionDate: normalizeDate(input.transactionDate),
    charges: normalizePostOffloadImpactCharges(input.charges),
  });
}

export async function resolvePreviewChargeFx(input: {
  companyId: number;
  transactionDate: string;
  containerCurrency: string;
  containerFxRate: number;
  containerFxDate: string | null;
  containerFxConfirmed: boolean;
  charges: NormalizedChargeRequest[];
}): Promise<ResolvedPreviewCharge[]> {
  const resolved: ResolvedPreviewCharge[] = [];
  for (const charge of input.charges) {
    if (charge.currencyCode === "USD") {
      resolved.push({
        ...charge,
        fxRateToUsd: "1.00000000",
        fxRateConfirmed: true,
        fxRateDate: input.transactionDate,
      });
      continue;
    }

    if (charge.currencyCode === input.containerCurrency) {
      if (!input.containerFxConfirmed || input.containerFxRate <= 0) {
        throw new InvalidPostOffloadImpactPreviewError(
          `Container FX rate for ${input.containerCurrency} is not confirmed. Confirm it before adding this charge.`
        );
      }
      resolved.push({
        ...charge,
        fxRateToUsd: new Decimal(input.containerFxRate).toFixed(8),
        fxRateConfirmed: true,
        fxRateDate: input.containerFxDate || input.transactionDate,
      });
      continue;
    }

    const fetched = await getFxRateToUsdReadOnly(input.companyId, charge.currencyCode, input.transactionDate);
    const rate = new Decimal(String(fetched ?? "0"));
    if (!rate.isFinite() || rate.lte(0)) {
      throw new InvalidPostOffloadImpactPreviewError(
        `Cannot resolve FX rate for ${charge.currencyCode} on ${input.transactionDate}. Add the FX rate first.`
      );
    }
    resolved.push({
      ...charge,
      fxRateToUsd: rate.toFixed(8),
      fxRateConfirmed: true,
      fxRateDate: input.transactionDate,
    });
  }
  return resolved;
}
