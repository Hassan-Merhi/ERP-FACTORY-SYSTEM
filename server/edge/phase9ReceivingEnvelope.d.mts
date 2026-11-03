export const PHASE9_RECEIVING_KIND: "receiving.container-offload.v1";
export const PHASE9_RECEIVING_ORDER_CHANGED: "PHASE9_RECEIVING_ORDER_CHANGED";
export class Phase9ReceivingRefusal extends Error {
  constructor(code: string);
}
export interface Phase9ReceivingEvidence {
  companyId: number;
  localOffloadId: number;
  containerId: number;
  locationId: number;
  actorUserId: string;
  actorUsername: string;
  requestId: string;
  offloadDate: string;
  lineDigest: string;
  mode: "create" | "edit";
  offload: Phase9ReceivingOffloadInputs;
}
export interface Phase9ReceivingOffloadInputs {
  duties: string;
  dutiesAccountId: number | null;
  officeCharges: string;
  officeChargesAccountId: number | null;
  officeChargesCashAccountId: number | null;
  transferCharges: string;
  transportFees: string;
  transportAccountId: number | null;
  additionalCharges: Array<{ description: string; amount: string; ledgerAccountId: number }>;
  inventoryCostCorrections: Array<{ stockItemId: number; correctRate: string }>;
  agentChargeLines: Array<{ description: string | null; amountUsd: string; parentAgentAccountId: number }>;
}
export interface Phase9ReceivingEnvelope extends Phase9ReceivingEvidence {
  kind: "receiving.container-offload.v1";
}
export function phase9ReceivingLineDigest(
  lines: ReadonlyArray<{ stockItemId: number | string; quantity: number | string }>
): string;
export function phase9ReceivingEnvelope(evidence: Phase9ReceivingEvidence): Phase9ReceivingEnvelope;
