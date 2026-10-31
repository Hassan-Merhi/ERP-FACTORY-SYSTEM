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
  Readonly<{ enabled: false }> | Readonly<{ enabled: true; siteId: string; secret: string }>;
export const EDGE_SYNC_STAGE_PATH: string;
export const EDGE_SYNC_STAGE_VERSION: string;
export const EDGE_SYNC_STAGE_LIMIT: number;
export function canonicalEvidence(input: unknown): unknown;
export function hashEvidence(payload: unknown): string;
export function validateStageEnvelope(body: unknown, siteId: string): StagedVoucherEvent[];
export const VOUCHER_STAGE_SIGNATURE_DOMAIN: "ERP_FACTORY_VOUCHER_STAGE_V1";
export const EVENT_STAGE_SIGNATURE_DOMAIN: "ERP_FACTORY_EVENT_STAGE_V1";
export type StageSignatureDomain = typeof VOUCHER_STAGE_SIGNATURE_DOMAIN | typeof EVENT_STAGE_SIGNATURE_DOMAIN;
export function makeStageSignature(
  raw: Buffer,
  timestamp: string,
  secret: string,
  domain?: StageSignatureDomain
): string;
export function verifyStageSignature(
  raw: Buffer,
  timestamp: string,
  signature: string,
  secret: string,
  nowSeconds?: number,
  domain?: StageSignatureDomain
): void;
export function readCloudSyncStageConfiguration(env?: Record<string, string | undefined>): CloudSyncStageConfig;
