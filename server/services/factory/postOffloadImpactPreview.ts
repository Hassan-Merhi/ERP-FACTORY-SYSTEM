import Decimal from "decimal.js";
import { factoryOffloadAdditionalCharges } from "@shared/schema";
import {
  calculateRateAfterInventoryValueDelta,
  formatFactoryLockedRate,
  formatFactoryQuantity,
  formatFactoryRate,
  formatFactoryTotal,
} from "./factoryCostingEngine";
import { computeCorrectContainerCost } from "./raw-stock-recalc";
import {
  ExpiredRepairTokenError,
  InvalidRepairTokenError,
  REPAIR_TOKEN_TTL_MS,
  signRepairToken,
  verifyRepairToken,
} from "./repairToken";
import { resolveStoredFxRate, UnresolvedExchangeRateError } from "./currencyConversion";
import {
  InvalidPostOffloadImpactPreviewError,
  PREVIEW_KIND,
  PREVIEW_VERSION,
  StalePostOffloadImpactPreviewError,
  computePostOffloadImpactRequestFingerprint,
  normalizeDate,
  normalizePostOffloadImpactCharges,
  resolvePreviewChargeFx,
  stableHash,
  type PostOffloadImpactPreviewSummary,
  type PostOffloadImpactPreviewTokenPayload,
  type PreparedPostOffloadImpactPreview,
} from "./normalizePostOffloadImpactCharges";
import { loadImpactScope, loadPreviewState, loadReplaySafety } from "./loadPreviewState";
export {
  InvalidPostOffloadImpactPreviewError,
  StalePostOffloadImpactPreviewError,
  computePostOffloadImpactRequestFingerprint,
  normalizePostOffloadImpactCharges,
} from "./normalizePostOffloadImpactCharges";
export type {
  PostOffloadImpactChargeInput,
  PostOffloadImpactPreviewSummary,
  PostOffloadImpactScope,
  PreparedPostOffloadImpactPreview,
} from "./normalizePostOffloadImpactCharges";

function fingerprintPostOffloadImpactState(state: Awaited<ReturnType<typeof loadPreviewState>>): string {
  return stableHash({
    container: state.container,
    activeCharges: [...state.activeCharges].sort((left, right) => left.id - right.id),
    commission: state.commission,
    otherCharges: [...state.otherCharges].sort((left, right) => left.id - right.id),
    rawStockRows: [...state.rawStockRows].sort((left, right) => left.id - right.id),
    supplier: state.supplier,
    supplierRemainingKg: formatFactoryQuantity(state.supplierRemainingKg),
    supplierLockedRate: state.supplierLockedRate === null ? null : formatFactoryLockedRate(state.supplierLockedRate),
  });
}

export async function computePostOffloadImpactStateFingerprint(
  companyId: number,
  containerId: number
): Promise<string> {
  return fingerprintPostOffloadImpactState(await loadPreviewState(companyId, containerId));
}

export async function preparePostOffloadImpactPreview(input: {
  companyId: number;
  userId: string;
  containerId: number;
  transactionDate: string;
  charges: unknown;
}): Promise<PreparedPostOffloadImpactPreview> {
  const transactionDate = normalizeDate(input.transactionDate);
  const charges = normalizePostOffloadImpactCharges(input.charges);
  const state = await loadPreviewState(input.companyId, input.containerId);

  const containerCurrency = String(state.container.currencyCode || "USD").toUpperCase();
  const storedFx = resolveStoredFxRate(
    containerCurrency,
    state.container.fxRateToUsdOffload || state.container.fxRateToUsd,
    state.container.fxRateConfirmed
  );
  if (!storedFx.looksSet) {
    throw new InvalidPostOffloadImpactPreviewError(new UnresolvedExchangeRateError(containerCurrency).message);
  }

  const resolvedCharges = await resolvePreviewChargeFx({
    companyId: input.companyId,
    transactionDate,
    containerCurrency,
    containerFxRate: storedFx.fxRate,
    containerFxDate: state.container.fxRateDateOffload || null,
    containerFxConfirmed: Boolean(state.container.fxRateConfirmed),
    charges,
  });

  const syntheticRows: (typeof factoryOffloadAdditionalCharges.$inferSelect)[] = resolvedCharges.map(
    (charge, index) => ({
      id: -(index + 1),
      companyId: input.companyId,
      containerId: input.containerId,
      description: charge.description,
      amount: charge.amount,
      currencyCode: charge.currencyCode,
      fxRateToUsd: charge.fxRateToUsd,
      fxRateConfirmed: true,
      fxRateDate: charge.fxRateDate,
      ledgerAccountId: charge.ledgerAccountId,
      supplierId: charge.supplierId,
      voucherId: null,
      daybookEntryId: null,
      reversalDaybookEntryId: null,
      supplierLockedRateBefore: null,
      supplierLockedRateAfter: null,
      supplierRemainingKgAtApply: null,
      fullContainerValueDeltaUsd: null,
      supplierInventoryValueDeltaUsd: null,
      remainingFractionAtApply: null,
      createdByUserId: input.userId || null,
      updatedByUserId: input.userId || null,
      deletedAt: null,
      version: 1,
      createdAt: new Date(`${transactionDate}T00:00:00.000Z`),
      updatedAt: new Date(`${transactionDate}T00:00:00.000Z`),
    })
  );

  const currentCost = computeCorrectContainerCost(
    state.container,
    state.activeCharges,
    state.commission,
    state.otherCharges
  );
  const projectedCost = computeCorrectContainerCost(
    state.container,
    [...state.activeCharges, ...syntheticRows],
    state.commission,
    state.otherCharges
  );
  if (currentCost.fxUnresolved || projectedCost.fxUnresolved) {
    throw new InvalidPostOffloadImpactPreviewError(
      `FX rate unresolved for container ${state.container.containerNumber}.`
    );
  }

  const fullDelta = new Decimal(projectedCost.totalUsd).minus(currentCost.totalUsd);
  const supplierInventoryDelta = fullDelta.times(state.remainingFraction);
  const currentSupplierRate = state.supplierLockedRate;
  const projectedSupplierRate = state.container.supplierId
    ? calculateRateAfterInventoryValueDelta({
        inventoryQuantityKg: state.supplierRemainingKg,
        currentRatePerKg: currentSupplierRate ?? 0,
        valueDelta: supplierInventoryDelta,
        fallbackRatePerKg: projectedCost.costPerKgUsd,
      })
    : null;
  const [scope, replaySafety] = await Promise.all([
    loadImpactScope(input.companyId, state.container.supplierId),
    loadReplaySafety(input.companyId, state.container.supplierId),
  ]);
  const stateFingerprint = fingerprintPostOffloadImpactState(state);

  const preview: PostOffloadImpactPreviewSummary = {
    containerId: input.containerId,
    containerNumber: state.container.containerNumber,
    supplierId: state.container.supplierId,
    transactionDate,
    chargeCount: charges.length,
    currentContainerCostPerKgUsd: formatFactoryRate(currentCost.costPerKgUsd),
    projectedContainerCostPerKgUsd: formatFactoryRate(projectedCost.costPerKgUsd),
    currentContainerTotalUsd: formatFactoryTotal(currentCost.totalUsd),
    projectedContainerTotalUsd: formatFactoryTotal(projectedCost.totalUsd),
    fullContainerValueDeltaUsd: fullDelta.toFixed(6),
    containerReceivedKg: formatFactoryQuantity(state.receivedKg),
    containerRemainingKg: formatFactoryQuantity(state.remainingKg),
    remainingFraction: state.remainingFraction.toDecimalPlaces(8).toFixed(8),
    supplierRemainingKg: formatFactoryQuantity(state.supplierRemainingKg),
    supplierLockedRateBefore: currentSupplierRate ? formatFactoryLockedRate(currentSupplierRate) : null,
    supplierLockedRateProjected: projectedSupplierRate ? formatFactoryLockedRate(projectedSupplierRate) : null,
    supplierInventoryValueDeltaUsd: supplierInventoryDelta.toFixed(6),
    historicalReplaySafe: replaySafety.safe,
    historicalReplayBlockedReasons: replaySafety.reasons,
    scope,
  };

  const payload: PostOffloadImpactPreviewTokenPayload = {
    kind: PREVIEW_KIND,
    version: PREVIEW_VERSION,
    companyId: input.companyId,
    userId: input.userId,
    containerId: input.containerId,
    transactionDate,
    requestFingerprint: computePostOffloadImpactRequestFingerprint({
      containerId: input.containerId,
      transactionDate,
      charges,
    }),
    stateFingerprint,
    preview,
    expiresAt: Date.now() + REPAIR_TOKEN_TTL_MS,
  };

  return {
    dryRun: true,
    confirmationToken: signRepairToken(payload),
    expiresInMs: REPAIR_TOKEN_TTL_MS,
    preview,
  };
}

export async function verifyPostOffloadImpactPreview(input: {
  token: unknown;
  companyId: number;
  userId: string;
  containerId: number;
  transactionDate: string;
  charges: unknown;
}): Promise<PostOffloadImpactPreviewSummary> {
  let payload: PostOffloadImpactPreviewTokenPayload;
  try {
    payload = verifyRepairToken<PostOffloadImpactPreviewTokenPayload>(String(input.token ?? ""));
  } catch (error) {
    if (error instanceof ExpiredRepairTokenError) {
      throw new StalePostOffloadImpactPreviewError(
        "Post-offload impact preview expired. Review the impact again before saving."
      );
    }
    if (error instanceof InvalidRepairTokenError) {
      throw new InvalidPostOffloadImpactPreviewError(error.message);
    }
    throw error;
  }

  const transactionDate = normalizeDate(input.transactionDate);
  if (payload.kind !== PREVIEW_KIND || payload.version !== PREVIEW_VERSION) {
    throw new InvalidPostOffloadImpactPreviewError("Unsupported post-offload impact preview token.");
  }
  if (
    payload.companyId !== input.companyId ||
    payload.userId !== input.userId ||
    payload.containerId !== input.containerId ||
    payload.transactionDate !== transactionDate
  ) {
    throw new InvalidPostOffloadImpactPreviewError(
      "Post-offload impact preview does not match this user, company, container, or date."
    );
  }

  const requestFingerprint = computePostOffloadImpactRequestFingerprint({
    containerId: input.containerId,
    transactionDate,
    charges: input.charges,
  });
  if (requestFingerprint !== payload.requestFingerprint) {
    throw new InvalidPostOffloadImpactPreviewError(
      "Post-offload charges changed after preview. Review the updated impact before saving."
    );
  }

  const stateFingerprint = await computePostOffloadImpactStateFingerprint(input.companyId, input.containerId);
  if (stateFingerprint !== payload.stateFingerprint) {
    throw new StalePostOffloadImpactPreviewError();
  }

  const recomputed = await preparePostOffloadImpactPreview({
    companyId: input.companyId,
    userId: input.userId,
    containerId: input.containerId,
    transactionDate,
    charges: input.charges,
  });
  if (stableHash(recomputed.preview) !== stableHash(payload.preview)) {
    throw new StalePostOffloadImpactPreviewError(
      "Post-offload cost impact changed after preview. Review the updated impact before saving."
    );
  }

  return payload.preview;
}
