import Decimal from "decimal.js";

export type RawStockCostEventKind =
  "offload" | "post_offload_charge" | "commission" | "freight" | "manual_adjustment" | "recalculation";

export interface RawStockCostSourceIdentity {
  sourceType: string;
  sourceId: string;
  idempotencyKey: string;
}

export interface RawStockCostActor {
  userId?: string | number | null;
  username?: string | null;
  reason?: string | null;
}

export interface RawStockCostState {
  supplierId: number;
  currency: string;
  quantityKg: string;
  totalCost: string;
  unitCostPerKg: string;
  version: number;
}

export interface RawStockCostEventRequest {
  companyId: number;
  supplierId: number;
  kind: RawStockCostEventKind;
  currency: string;
  quantityDeltaKg: string;
  costDelta: string;
  occurredAt: string;
  source: RawStockCostSourceIdentity;
  actor?: RawStockCostActor;
  expectedVersion?: number | null;
  preserveUnitCost?: boolean;
}

export interface RawStockCostResult {
  before: RawStockCostState;
  after: RawStockCostState;
  quantityDeltaKg: string;
  costDelta: string;
  idempotent: boolean;
}

export interface RawStockCostingAdapter {
  findExisting(input: {
    tx: unknown;
    companyId: number;
    supplierId: number;
    source: RawStockCostSourceIdentity;
  }): Promise<RawStockCostResult | null>;
  validateOwnership(input: { tx: unknown; companyId: number; supplierId: number }): Promise<void>;
  lockCurrentState(input: { tx: unknown; companyId: number; supplierId: number }): Promise<RawStockCostState>;
  appendCostEvent(input: {
    tx: unknown;
    request: RawStockCostEventRequest;
    before: RawStockCostState;
    after: RawStockCostState;
    quantityDeltaKg: string;
    costDelta: string;
  }): Promise<void>;
  persistState(input: {
    tx: unknown;
    companyId: number;
    supplierId: number;
    expectedVersion: number;
    next: RawStockCostState;
  }): Promise<void>;
  recordIdempotency(input: {
    tx: unknown;
    companyId: number;
    supplierId: number;
    source: RawStockCostSourceIdentity;
    result: RawStockCostResult;
  }): Promise<void>;
  recordAudit(input: {
    tx: unknown;
    request: RawStockCostEventRequest;
    before: RawStockCostState;
    after: RawStockCostState;
  }): Promise<void>;
}

export class RawStockCostingValidationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "RawStockCostingValidationError";
    this.code = code;
  }
}

function positiveId(value: unknown, field: string): number {
  if (!Number.isInteger(value) || Number(value) <= 0) {
    throw new RawStockCostingValidationError("RAW_STOCK_ID_INVALID", `${field} must be a positive integer`);
  }
  return Number(value);
}

function requiredText(value: unknown, field: string): string {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    throw new RawStockCostingValidationError("RAW_STOCK_FIELD_REQUIRED", `${field} is required`);
  }
  return normalized;
}

function decimal(
  value: unknown,
  field: string,
  options: { allowNegative?: boolean; allowZero?: boolean } = {}
): Decimal {
  let parsed: Decimal;
  try {
    parsed = new Decimal(String(value));
  } catch {
    throw new RawStockCostingValidationError("RAW_STOCK_AMOUNT_INVALID", `${field} is invalid`);
  }
  if (!parsed.isFinite()) {
    throw new RawStockCostingValidationError("RAW_STOCK_AMOUNT_INVALID", `${field} must be finite`);
  }
  if (!options.allowNegative && parsed.isNegative()) {
    throw new RawStockCostingValidationError("RAW_STOCK_AMOUNT_INVALID", `${field} cannot be negative`);
  }
  if (!options.allowZero && parsed.isZero()) {
    throw new RawStockCostingValidationError("RAW_STOCK_AMOUNT_INVALID", `${field} cannot be zero`);
  }
  return parsed;
}

function normalizeCurrency(value: unknown): string {
  const currency = requiredText(value, "currency").toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new RawStockCostingValidationError("RAW_STOCK_CURRENCY_INVALID", "currency must be a 3-letter code");
  }
  return currency;
}

function validateState(state: RawStockCostState, supplierId: number, currency: string): void {
  if (state.supplierId !== supplierId) {
    throw new RawStockCostingValidationError(
      "RAW_STOCK_SUPPLIER_MISMATCH",
      "Locked raw-stock state belongs to another supplier"
    );
  }
  if (normalizeCurrency(state.currency) !== currency) {
    throw new RawStockCostingValidationError(
      "RAW_STOCK_CURRENCY_MISMATCH",
      `Raw-stock state currency ${state.currency} does not match event currency ${currency}`
    );
  }
  if (!Number.isInteger(state.version) || state.version < 0) {
    throw new RawStockCostingValidationError("RAW_STOCK_VERSION_INVALID", "Raw-stock state version is invalid");
  }
  const quantity = decimal(state.quantityKg, "state.quantityKg", { allowZero: true });
  const totalCost = decimal(state.totalCost, "state.totalCost", { allowZero: true });
  const unitCost = decimal(state.unitCostPerKg, "state.unitCostPerKg", { allowZero: true });
  if (quantity.isZero() && (!totalCost.isZero() || !unitCost.isZero())) {
    throw new RawStockCostingValidationError(
      "RAW_STOCK_ZERO_QUANTITY_COST_INVALID",
      "Zero raw-stock quantity must have zero total cost and zero unit cost"
    );
  }
  if (!quantity.isZero() && !totalCost.div(quantity).eq(unitCost)) {
    throw new RawStockCostingValidationError(
      "RAW_STOCK_STATE_INCONSISTENT",
      "Raw-stock total cost, quantity, and unit cost are inconsistent"
    );
  }
}

export interface ValidatedRawStockCostEvent {
  currency: string;
  quantityDeltaKg: Decimal;
  costDelta: Decimal;
}

export function validateRawStockCostEvent(request: RawStockCostEventRequest): ValidatedRawStockCostEvent {
  positiveId(request.companyId, "companyId");
  positiveId(request.supplierId, "supplierId");
  requiredText(request.occurredAt, "occurredAt");
  requiredText(request.source.sourceType, "source.sourceType");
  requiredText(request.source.sourceId, "source.sourceId");
  requiredText(request.source.idempotencyKey, "source.idempotencyKey");

  const currency = normalizeCurrency(request.currency);
  const quantityDeltaKg = decimal(request.quantityDeltaKg, "quantityDeltaKg", {
    allowNegative: true,
    allowZero: true,
  });
  const costDelta = decimal(request.costDelta, "costDelta", {
    allowNegative: true,
    allowZero: true,
  });

  if (quantityDeltaKg.isZero() && costDelta.isZero()) {
    throw new RawStockCostingValidationError(
      "RAW_STOCK_EVENT_EMPTY",
      "A raw-stock cost event must change quantity or cost"
    );
  }

  if (request.kind === "offload" && quantityDeltaKg.lte(0)) {
    throw new RawStockCostingValidationError("RAW_STOCK_OFFLOAD_QUANTITY_INVALID", "Offload quantity must be positive");
  }

  if (["post_offload_charge", "commission", "freight"].includes(request.kind) && !quantityDeltaKg.isZero()) {
    throw new RawStockCostingValidationError(
      "RAW_STOCK_CHARGE_QUANTITY_INVALID",
      `${request.kind} events cannot change raw-stock quantity`
    );
  }

  if (request.preserveUnitCost && !costDelta.isZero()) {
    throw new RawStockCostingValidationError(
      "RAW_STOCK_PRESERVED_COST_CHANGED",
      "A preserve-unit-cost event cannot independently change total cost"
    );
  }

  return { currency, quantityDeltaKg, costDelta };
}

/**
 * Canonical transaction-owned factory raw-stock costing boundary.
 *
 * Quantity and cost are updated from one locked supplier state using Decimal.
 * A deduction can explicitly preserve unit cost; in that mode its cost delta is
 * derived from the locked unit cost instead of being accepted from the caller.
 * Charges that change cost without quantity always recalculate unit cost over the
 * remaining quantity. Every mutation is append-only, version-checked, idempotent,
 * and audit recorded inside the caller-owned transaction.
 */
export async function applyRawStockCostEventTx(
  tx: unknown,
  request: RawStockCostEventRequest,
  adapter: RawStockCostingAdapter
): Promise<RawStockCostResult> {
  const validated = validateRawStockCostEvent(request);

  const existing = await adapter.findExisting({
    tx,
    companyId: request.companyId,
    supplierId: request.supplierId,
    source: request.source,
  });
  if (existing) return { ...existing, idempotent: true };

  await adapter.validateOwnership({ tx, companyId: request.companyId, supplierId: request.supplierId });
  const before = await adapter.lockCurrentState({
    tx,
    companyId: request.companyId,
    supplierId: request.supplierId,
  });
  validateState(before, request.supplierId, validated.currency);

  if (request.expectedVersion != null && request.expectedVersion !== before.version) {
    throw new RawStockCostingValidationError(
      "RAW_STOCK_VERSION_CONFLICT",
      `Expected raw-stock version ${request.expectedVersion} but locked version is ${before.version}`
    );
  }

  const beforeQuantity = new Decimal(before.quantityKg);
  const beforeUnitCost = new Decimal(before.unitCostPerKg);
  const quantityDelta = validated.quantityDeltaKg;
  const derivedCostDelta = request.preserveUnitCost ? quantityDelta.mul(beforeUnitCost) : validated.costDelta;
  const nextQuantity = beforeQuantity.plus(quantityDelta);
  const nextTotalCost = new Decimal(before.totalCost).plus(derivedCostDelta);

  if (nextQuantity.isNegative()) {
    throw new RawStockCostingValidationError(
      "RAW_STOCK_NEGATIVE_QUANTITY",
      `Raw-stock quantity would become negative (${nextQuantity.toFixed()})`
    );
  }
  if (nextTotalCost.isNegative()) {
    throw new RawStockCostingValidationError(
      "RAW_STOCK_NEGATIVE_COST",
      `Raw-stock total cost would become negative (${nextTotalCost.toFixed()})`
    );
  }
  if (nextQuantity.isZero() && !nextTotalCost.isZero()) {
    throw new RawStockCostingValidationError(
      "RAW_STOCK_ZERO_QUANTITY_COST_INVALID",
      "A fully depleted raw-stock balance must also have zero total cost"
    );
  }

  const nextUnitCost = nextQuantity.isZero() ? new Decimal(0) : nextTotalCost.div(nextQuantity);
  if (request.preserveUnitCost && !nextQuantity.isZero() && !nextUnitCost.eq(beforeUnitCost)) {
    throw new RawStockCostingValidationError(
      "RAW_STOCK_UNIT_COST_DRIFT",
      "Preserve-unit-cost event changed the supplier unit cost"
    );
  }

  const after: RawStockCostState = {
    supplierId: request.supplierId,
    currency: validated.currency,
    quantityKg: nextQuantity.toFixed(),
    totalCost: nextTotalCost.toFixed(),
    unitCostPerKg: nextUnitCost.toFixed(),
    version: before.version + 1,
  };

  const result: RawStockCostResult = {
    before,
    after,
    quantityDeltaKg: quantityDelta.toFixed(),
    costDelta: derivedCostDelta.toFixed(),
    idempotent: false,
  };

  await adapter.appendCostEvent({
    tx,
    request,
    before,
    after,
    quantityDeltaKg: result.quantityDeltaKg,
    costDelta: result.costDelta,
  });
  await adapter.persistState({
    tx,
    companyId: request.companyId,
    supplierId: request.supplierId,
    expectedVersion: before.version,
    next: after,
  });
  await adapter.recordIdempotency({
    tx,
    companyId: request.companyId,
    supplierId: request.supplierId,
    source: request.source,
    result,
  });
  await adapter.recordAudit({ tx, request, before, after });

  return result;
}
