import type { Pool } from "pg";
export const PHASE8_RECEIPT_QUERY_PATH: string;
export const PHASE8_RECEIPT_QUERY_PROTOCOL: string;
export const PHASE8_RECEIPT_PROTOCOL: string;
export interface Phase8AppliedReceiptQuery {
  protocol: string;
  siteId: string;
  fromSequence: string;
}
export interface Phase8AppliedReceiptItem {
  sequence: string;
  operationId: string;
  companyId: number;
  actorUserId: string;
  localVoucherId: number;
  cloudVoucherId: number;
  payloadSha256: string;
  businessDate: string;
  state: "cloud-applied";
}
export function validateAppliedReceiptQuery(body: unknown, expectedSite: string): Phase8AppliedReceiptQuery;
export function getAppliedCloudReceipts(
  queryable: Pick<Pool, "query">,
  body: unknown,
  expectedSite: string
): Promise<{ protocol: string; siteId: string; state: "cloud-applied"; events: Phase8AppliedReceiptItem[] }>;
