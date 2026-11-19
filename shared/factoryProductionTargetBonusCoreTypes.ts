// Extracted from ./factoryProductionTargetBonusCore.ts

export type ProductionBonusScope = "company" | "worker";

export type ProductionBonusStatus = "Present" | "Absent" | "New";

export interface ProductionTargetBonusRate {
  id: number;
  scope: ProductionBonusScope;
  workerId: number | null;
  effectiveFrom: string;
  enabled: boolean;
  ratePerExtraBale: string;
}

export interface ProductionTargetBonusWorker {
  workerId: number;
  workerName: string;
  employeeCode: string | null;
  category: string | null;
  status: ProductionBonusStatus;
  targetBales: number | null;
  // The finalized daily snapshot repeats the entire team total for each
  // linked member. Never add these repeated values together.
  producedBales: number | null;
}

export interface ProductionTargetBonusLink {
  id: number;
  workerIds: number[];
}

export interface ProductionTargetBonusDayInput {
  date: string;
  finalized: boolean;
  workers: ProductionTargetBonusWorker[];
  links: ProductionTargetBonusLink[];
}

export type ProductionTargetBonusIssue =
  | "NOT_FINALIZED"
  | "EMPTY_FINALIZED_DAY"
  | "INVALID_PRODUCTION"
  | "LINK_MEMBER_MISSING"
  | "OVERLAPPING_LINKS"
  | "LINKED_OUTPUT_CONFLICT"
  | "NO_TARGET"
  | "ABSENT"
  | "RATE_DISABLED"
  | "NO_RATE"
  | "ODD_LINKED_BALES";

export interface ProductionTargetBonusWorkerPreview {
  date: string;
  workerId: number;
  workerName: string;
  employeeCode: string | null;
  category: string | null;
  status: ProductionBonusStatus;
  linkGroupId: number | null;
  partnerIds: number[];
  targetBales: number | null;
  // Credited share, not the repeated team total.
  creditedBales: number;
  extraBales: number;
  ratePerExtraBale: string;
  rateVersionId: number | null;
  rateScope: ProductionBonusScope | null;
  bonusUsd: string;
  eligibleForReview: boolean;
  requiresReview: boolean;
  issues: ProductionTargetBonusIssue[];
}

export interface ProductionTargetBonusDayPreview {
  date: string;
  finalized: boolean;
  payoutReady: boolean;
  totalProducedBales: number;
  extraBales: number;
  proposedBonusUsd: string;
  workers: ProductionTargetBonusWorkerPreview[];
  warnings: ProductionTargetBonusIssue[];
}
