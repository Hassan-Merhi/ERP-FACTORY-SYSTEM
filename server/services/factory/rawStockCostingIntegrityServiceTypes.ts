// Extracted from ./rawStockCostingIntegrityService.ts
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

export interface ValidatedRawStockCostEvent {
  currency: string;
  quantityDeltaKg: Decimal;
  costDelta: Decimal;
}
