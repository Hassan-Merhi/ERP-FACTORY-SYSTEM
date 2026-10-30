import type { PoolClient } from "pg";
export class Phase8ApplyRefusal extends Error { constructor(code: string); }
export interface Phase8Approval {
  siteId: string;
  companyId: number;
  baselineSha256: string;
  cloudEpoch: string | number;
  operatorAck: string;
  sequence: string;
}
export interface Phase8StagedEvent {
  sequence: string;
  operationId: string;
  companyId: number;
  actorUserId: string;
  localVoucherId: number;
  kind: string;
  payloadSha256: string;
  payload: { voucher: Record<string, unknown>; entries: Array<Record<string, unknown>> };
}
export interface Phase8AppliedReceipt {
  sequence: string;
  operationId: string;
  payloadSha256: string;
  companyId: number;
  localVoucherId: number;
  cloudVoucherId: number;
  businessDate: string;
  state: "cloud-applied";
  replayed: boolean;
}
export function validatePhase8OperatorApproval(input: Phase8Approval): Phase8Approval;
export function ensurePhase8ApplySchema(queryable: Pick<PoolClient, "query">): Promise<void>;
export function applyStagedVoucherOnce(
  queryable: Pick<PoolClient, "query">,
  input: Phase8Approval,
  applyPosting: (client: PoolClient, event: Phase8StagedEvent) => Promise<{ cloudVoucherId: number; businessDate: string }>
): Promise<Phase8AppliedReceipt>;
