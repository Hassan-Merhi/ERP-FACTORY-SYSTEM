import type { Pool, PoolClient } from "pg";
type Queryable = Pick<Pool | PoolClient, "query">;
export class Phase10OperatorRefusal extends Error {
  constructor(code: string, status?: number);
  readonly status: number;
}
export function ensurePhase10SyncControlFunction(queryable: Queryable): Promise<void>;
export function ensurePhase10ConflictDecisionFunction(queryable: Queryable): Promise<void>;
export function recordPhase10OperatorSyncControl(
  queryable: Queryable,
  input: { siteId: string; companyId: number; userId: string; action: "pause" | "resume"; reason: string }
): Promise<void>;
export interface Phase10OpenConflict {
  stream: string;
  sequence: string;
  operationId: string;
  kind: string;
  code: string;
  detail: Record<string, unknown>;
  detectedAt: string;
  canApprove: boolean;
}
export function listPhase10OpenConflicts(
  queryable: Queryable,
  input: { siteId: string; companyId: number }
): Promise<Phase10OpenConflict[]>;
export function decidePhase10Conflict(
  queryable: Queryable,
  input: {
    siteId: string;
    stream: string;
    sequence: string;
    decision: "reject-event" | "approve-override";
    userId: string;
    reason: string;
  }
): Promise<{ stream: string; sequence: string; decision: string }>;
