// Extracted from ./parseGoldenCoastPhase8ContainerInput.ts

export type GoldenCoastPhase8ErrorCode =
  | "GC_PHASE8_INPUT_INVALID"
  | "GC_PHASE8_PRE_CUTOVER_DATE"
  | "GC_PHASE8_RESERVE_EXCEEDED"
  | "GC_PHASE8_CHARGE_FUNDING_REQUIRED"
  | "GC_PHASE8_SCOPE_MISMATCH";

export type GoldenCoastPhase8PostingAccount = { kind: "ledger"; id: number } | { kind: "bank"; id: number };

export interface GoldenCoastPhase8ContainerLineInput {
  stockItemId: number;
  articleCode: string;
  description: string | null;
  qty: string;
  unitRateUsd: string;
}

export interface GoldenCoastPhase8ContainerInput {
  companyId: number;
  clientRequestId: string;
  supplierId: number | null;
  supplierName: string;
  containerNumber: string | null;
  invoiceNumber: string;
  invoiceDate: string;
  reserveUsd: string;
  fundingAccount: GoldenCoastPhase8PostingAccount;
  lines: GoldenCoastPhase8ContainerLineInput[];
  notes: string | null;
}

export interface GoldenCoastPhase8ChargeInput {
  chargeType: "duty" | "transport" | "other";
  description: string | null;
  amountUsd: string;
}

export interface GoldenCoastPhase8OffloadInput {
  companyId: number;
  clientRequestId: string;
  containerId: number;
  locationId: number;
  offloadDate: string;
  charges: GoldenCoastPhase8ChargeInput[];
  /**
   * Where the actual charges are paid from. Phase 8-funded containers already
   * hold a real reserve, so this is unused for them; a container carried
   * through the cutover has no reserve, so its charges need a funding account.
   */
  chargeFundingAccount: GoldenCoastPhase8PostingAccount | null;
}

export interface GoldenCoastPhase8RoleAccounts {
  stockOtwAccountId: number;
  stockInHandAccountId: number;
  containerReserveAccountId: number;
  hassanEquityAccountId: number;
  hassanSavingsAccountId: number;
}

export interface GoldenCoastPhase8FundingPlan {
  goodsCostUsd: string;
  reserveUsd: string;
  totalFundingUsd: string;
  totalQty: string;
  digest: string;
}

/**
 * `phase8` containers were funded by this phase's own endpoint and carry a real
 * container reserve. `cutover` containers were carried across the September 1
 * cutover by the migration, which links a `GC-OTW-*` voucher and never funds a
 * reserve — their charges settle against a funding account at offload instead.
 */
export type GoldenCoastPhase8ContainerOrigin = "phase8" | "cutover" | "fresh_start_excel";

export interface GoldenCoastPhase8FundedContainerState {
  containerId: number;
  companyId: number;
  origin: GoldenCoastPhase8ContainerOrigin;
  fundingVoucherId: number;
  goodsCostUsd: string;
  reserveUsd: string;
  fundingAccount: GoldenCoastPhase8PostingAccount;
  lines: GoldenCoastPhase8ContainerLineInput[];
}

export interface GoldenCoastPhase8OffloadLinePlan extends GoldenCoastPhase8ContainerLineInput {
  baseUnitCostUsd: string;
  landedUnitCostUsd: string;
  finalUnitCostUsd: string;
}

export interface GoldenCoastPhase8OffloadPlan {
  goodsCostUsd: string;
  reserveUsd: string;
  actualChargesUsd: string;
  unusedReserveUsd: string;
  totalQty: string;
  totalFinalCostUsd: string;
  lines: GoldenCoastPhase8OffloadLinePlan[];
  digest: string;
}
