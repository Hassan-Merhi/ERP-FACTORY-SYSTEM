// Extracted from ./mixBatchCostingIntegrityService.ts

export interface MixBatchSourceIdentity {
  sourceType: string;
  sourceId: string;
  idempotencyKey: string;
}

export interface MixBatchActor {
  userId?: string | number | null;
  username?: string | null;
  reason?: string | null;
}

export interface MixBatchComponentRequest {
  supplierId: number;
  quantityKg: string;
  expectedUnitCostPerKg: string;
  expectedRawStockVersion?: number | null;
}

export interface MixBatchCostingRequest {
  companyId: number;
  batchId: string;
  currency: string;
  occurredAt: string;
  components: MixBatchComponentRequest[];
  source: MixBatchSourceIdentity;
  actor?: MixBatchActor;
}

export interface LockedSupplierCostState {
  supplierId: number;
  currency: string;
  quantityKg: string;
  totalCost: string;
  unitCostPerKg: string;
  version: number;
}

export interface MixBatchComponentResult {
  supplierId: number;
  quantityKg: string;
  unitCostPerKg: string;
  value: string;
  beforeQuantityKg: string;
  afterQuantityKg: string;
  beforeTotalCost: string;
  afterTotalCost: string;
  rawStockVersion: number;
}

export interface MixBatchCostingResult {
  companyId: number;
  batchId: string;
  currency: string;
  totalQuantityKg: string;
  totalValue: string;
  weightedUnitCostPerKg: string;
  components: MixBatchComponentResult[];
  idempotent: boolean;
}

export interface MixBatchCostingAdapter {
  findExisting(input: {
    tx: unknown;
    companyId: number;
    batchId: string;
    source: MixBatchSourceIdentity;
  }): Promise<MixBatchCostingResult | null>;
  validateOwnership(input: { tx: unknown; companyId: number; batchId: string; supplierIds: number[] }): Promise<void>;
  lockSupplierStates(input: {
    tx: unknown;
    companyId: number;
    supplierIds: number[];
  }): Promise<LockedSupplierCostState[]>;
  appendSupplierDeductions(input: {
    tx: unknown;
    request: MixBatchCostingRequest;
    components: MixBatchComponentResult[];
  }): Promise<void>;
  persistSupplierStates(input: {
    tx: unknown;
    companyId: number;
    states: Array<{
      supplierId: number;
      expectedVersion: number;
      quantityKg: string;
      totalCost: string;
      unitCostPerKg: string;
      nextVersion: number;
    }>;
  }): Promise<void>;
  persistMixBatchCost(input: {
    tx: unknown;
    request: MixBatchCostingRequest;
    result: MixBatchCostingResult;
  }): Promise<void>;
  recordIdempotency(input: {
    tx: unknown;
    request: MixBatchCostingRequest;
    result: MixBatchCostingResult;
  }): Promise<void>;
  recordAudit(input: { tx: unknown; request: MixBatchCostingRequest; result: MixBatchCostingResult }): Promise<void>;
}
