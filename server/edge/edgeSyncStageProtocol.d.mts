export interface StagedVoucherEvent {
  sequence: string;
  operationId: string;
  companyId: number;
  actorUserId: string;
  localVoucherId: number;
  kind: "voucher.with-entries.v1";
  payload: { voucher: unknown; entries: unknown[] };
  payloadSha256: string;
}
export type CloudSyncStageConfig =
  | Readonly<{ enabled: false }>
  | Readonly<{ enabled: true; siteId: string; secret: string }>;
export const EDGE_SYNC_STAGE_PATH: string;
export const EDGE_SYNC_STAGE_VERSION: string;
export const EDGE_SYNC_STAGE_LIMIT: number;
export function canonicalEvidence(input: unknown): unknown;
export function hashEvidence(payload: unknown): string;
export function validateStageEnvelope(body: unknown, siteId: string): StagedVoucherEvent[];
export function makeStageSignature(raw: Buffer, timestamp: string, secret: string): string;
export function verifyStageSignature(raw: Buffer, timestamp: string, signature: string, secret: string, nowSeconds?: number): void;
export function readCloudSyncStageConfiguration(env?: Record<string, string | undefined>): CloudSyncStageConfig;
