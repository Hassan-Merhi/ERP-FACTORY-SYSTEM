import crypto from "node:crypto";
import Decimal from "decimal.js";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db, pool } from "../../db";
import { getFxRateToUsdReadOnly } from "./factoryFxRateReadOnly";
import {
  factoryContainerCommissions,
  factoryContainerOtherCharges,
  factoryContainers,
  factoryOffloadAdditionalCharges,
  factoryRawStock,
  factorySuppliers,
} from "@shared/schema";
import {
  calculateRateAfterInventoryValueDelta,
  formatFactoryLockedRate,
  formatFactoryQuantity,
  formatFactoryRate,
  formatFactoryTotal,
} from "./factoryCostingEngine";
import { previewHistoricalCostReplayWithExecutor, type ReplayQueryExecutor } from "./historicalCostReplay";
import { getAuthoritativeSupplierRemainingKg, getLockedSupplierRateReadOnly } from "./rawStockLockedRate";
import { computeCorrectContainerCost } from "./raw-stock-recalc";
import {
  ExpiredRepairTokenError,
  InvalidRepairTokenError,
  REPAIR_TOKEN_TTL_MS,
  signRepairToken,
  verifyRepairToken,
} from "./repairToken";
import { resolveStoredFxRate, UnresolvedExchangeRateError } from "./currencyConversion";

const PREVIEW_KIND = "POST_OFFLOAD_IMPACT_PREVIEW_V1" as const;
const PREVIEW_VERSION = 1 as const;

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

interface PostOffloadImpactPreviewTokenPayload {
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

function normalizeDate(value: unknown): string {
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

function stableHash(value: unknown): string {
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

async function resolvePreviewChargeFx(input: {
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

async function loadImpactScope(companyId: number, supplierId: number | null): Promise<PostOffloadImpactScope> {
  if (!supplierId) {
    return {
      supplierOwnedSources: 0,
      affectedSourceRows: 0,
      affectedBatches: 0,
      openBatches: 0,
      completedBatches: 0,
      availableBales: 0,
      finalizedBalesExcluded: 0,
    };
  }

  const result = await pool.query<{
    supplier_owned_sources: string;
    affected_source_rows: string;
    affected_batches: string;
    open_batches: string;
    completed_batches: string;
    available_bales: string;
    finalized_bales_excluded: string;
  }>(
    `WITH RECURSIVE affected_batches(batch_id) AS (
       SELECT DISTINCT mbs.mix_batch_id
       FROM factory_mix_batch_sources mbs
       JOIN factory_mix_batches mb ON mb.id = mbs.mix_batch_id
       WHERE mb.company_id = $1
         AND mb.deleted_at IS NULL
         AND mbs.inventory_supplier_id = $2
       UNION
       SELECT DISTINCT child.mix_batch_id
       FROM factory_mix_batch_sources child
       JOIN factory_mix_batches child_batch ON child_batch.id = child.mix_batch_id
       JOIN affected_batches parent ON child.source_batch_id = parent.batch_id
       WHERE child_batch.company_id = $1
         AND child_batch.deleted_at IS NULL
     ),
     bale_scope AS (
       SELECT
         fb.id,
         CASE
           WHEN fb.status IN ('SOLD','DISPATCHED','RESERVED_FOR_DISPATCH','RESERVED_FOR_ORDER','FINALIZED')
             OR fb.finalized_at IS NOT NULL
             OR EXISTS (
               SELECT 1
               FROM customer_order_bales cob
               JOIN customer_orders co ON co.id = cob.order_id
               WHERE cob.bale_id = fb.id
                 AND co.company_id = fb.company_id
                 AND co.deleted_at IS NULL
             )
             OR EXISTS (
               SELECT 1 FROM factory_invoice_loading_bales filb WHERE filb.bale_id = fb.id
             )
           THEN TRUE ELSE FALSE
         END AS finalized
       FROM factory_bales fb
       JOIN affected_batches ab ON ab.batch_id = fb.mix_batch_id
       WHERE fb.company_id = $1
         AND fb.status NOT IN ('DELETED','REMOVED')
     )
     SELECT
       (SELECT COUNT(*) FROM factory_mix_batch_sources mbs
         JOIN factory_mix_batches mb ON mb.id = mbs.mix_batch_id
        WHERE mb.company_id = $1 AND mb.deleted_at IS NULL AND mbs.inventory_supplier_id = $2)::text
         AS supplier_owned_sources,
       (SELECT COUNT(*) FROM factory_mix_batch_sources mbs
        WHERE mbs.mix_batch_id IN (SELECT batch_id FROM affected_batches))::text AS affected_source_rows,
       (SELECT COUNT(*) FROM affected_batches)::text AS affected_batches,
       (SELECT COUNT(*) FROM factory_mix_batches mb
        WHERE mb.id IN (SELECT batch_id FROM affected_batches)
          AND mb.status IN ('ACTIVE','OPEN','CARRY_FORWARD'))::text AS open_batches,
       (SELECT COUNT(*) FROM factory_mix_batches mb
        WHERE mb.id IN (SELECT batch_id FROM affected_batches)
          AND mb.status IN ('COMPLETED','CLOSED'))::text AS completed_batches,
       (SELECT COUNT(*) FROM bale_scope WHERE finalized = FALSE)::text AS available_bales,
       (SELECT COUNT(*) FROM bale_scope WHERE finalized = TRUE)::text AS finalized_bales_excluded`,
    [companyId, supplierId]
  );

  const row = result.rows[0];
  const count = (value: string | undefined) => Number.parseInt(value || "0", 10) || 0;
  return {
    supplierOwnedSources: count(row?.supplier_owned_sources),
    affectedSourceRows: count(row?.affected_source_rows),
    affectedBatches: count(row?.affected_batches),
    openBatches: count(row?.open_batches),
    completedBatches: count(row?.completed_batches),
    availableBales: count(row?.available_bales),
    finalizedBalesExcluded: count(row?.finalized_bales_excluded),
  };
}

async function loadReplaySafety(
  companyId: number,
  supplierId: number | null
): Promise<{
  safe: boolean;
  reasons: string[];
}> {
  if (!supplierId) return { safe: true, reasons: [] };

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const preview = await previewHistoricalCostReplayWithExecutor(client as unknown as ReplayQueryExecutor, companyId);
    await client.query("COMMIT");

    const supplier = preview.supplierRows.find((row) => row.supplierId === supplierId);
    const reasons = new Set<string>(supplier?.reasons ?? []);
    if (preview.financialImpact?.allSafetyGatesPassed === false) {
      reasons.add("COMPANY_WIDE_HISTORICAL_REPLAY_SAFETY_GATE_FAILED");
    }
    return {
      safe: (supplier?.safeToRepair ?? true) && preview.financialImpact?.allSafetyGatesPassed !== false,
      reasons: [...reasons].sort(),
    };
  } catch (error) {
    await client.query("ROLLBACK");
    return {
      safe: false,
      reasons: [
        (error as { code?: string }).code ||
          (error instanceof Error ? error.message : "HISTORICAL_REPLAY_PREVIEW_FAILED"),
      ],
    };
  } finally {
    client.release();
  }
}

async function loadPreviewState(companyId: number, containerId: number) {
  const [container] = await db
    .select()
    .from(factoryContainers)
    .where(
      and(
        eq(factoryContainers.id, containerId),
        eq(factoryContainers.companyId, companyId),
        isNull(factoryContainers.deletedAt)
      )
    );
  if (!container) {
    throw new InvalidPostOffloadImpactPreviewError("Container not found.");
  }
  if (!["OFFLOADED", "PARTIALLY_RECEIVED"].includes(container.status)) {
    throw new InvalidPostOffloadImpactPreviewError(
      "Post-offload impact preview is only available for received containers."
    );
  }

  const [activeCharges, commissions, otherCharges, rawStockRows, supplierRows] = await Promise.all([
    db
      .select()
      .from(factoryOffloadAdditionalCharges)
      .where(
        and(
          eq(factoryOffloadAdditionalCharges.companyId, companyId),
          eq(factoryOffloadAdditionalCharges.containerId, containerId),
          isNull(factoryOffloadAdditionalCharges.deletedAt)
        )
      ),
    db
      .select()
      .from(factoryContainerCommissions)
      .where(
        and(
          eq(factoryContainerCommissions.companyId, companyId),
          eq(factoryContainerCommissions.containerId, containerId)
        )
      )
      .orderBy(desc(factoryContainerCommissions.id)),
    db
      .select()
      .from(factoryContainerOtherCharges)
      .where(
        and(
          eq(factoryContainerOtherCharges.companyId, companyId),
          eq(factoryContainerOtherCharges.containerId, containerId)
        )
      ),
    db
      .select()
      .from(factoryRawStock)
      .where(and(eq(factoryRawStock.companyId, companyId), eq(factoryRawStock.containerId, containerId))),
    container.supplierId
      ? db
          .select({
            id: factorySuppliers.id,
            rate: factorySuppliers.currentRawMaterialCostPerKgUsd,
            updatedAt: factorySuppliers.updatedAt,
          })
          .from(factorySuppliers)
          .where(and(eq(factorySuppliers.companyId, companyId), eq(factorySuppliers.id, container.supplierId)))
      : Promise.resolve([]),
  ]);

  const commission = commissions[0] ?? null;
  const supplier = supplierRows[0] ?? null;
  const supplierRemainingKg = container.supplierId
    ? await getAuthoritativeSupplierRemainingKg(db, companyId, container.supplierId)
    : 0;
  const supplierLockedRate = container.supplierId
    ? (await getLockedSupplierRateReadOnly(db, companyId, container.supplierId)).rate
    : null;

  let receivedKg = new Decimal(0);
  let usedKg = new Decimal(0);
  for (const row of rawStockRows) {
    receivedKg = receivedKg.plus(String(row.receivedKg ?? "0"));
    usedKg = usedKg.plus(String(row.usedKg ?? "0"));
  }
  const remainingKg = Decimal.max(0, receivedKg.minus(usedKg));
  const remainingFraction = receivedKg.gt(0) ? Decimal.min(1, remainingKg.div(receivedKg)) : new Decimal(0);

  return {
    container,
    activeCharges,
    commission,
    otherCharges,
    rawStockRows,
    supplier,
    supplierRemainingKg,
    supplierLockedRate,
    receivedKg,
    remainingKg,
    remainingFraction,
  };
}

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
