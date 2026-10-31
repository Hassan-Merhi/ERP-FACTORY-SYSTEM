export interface Phase9StagedEvent {
  sequence: string;
  operationId: string;
  companyId: number;
  actorUserId: string;
  kind: string;
  localRef: number;
  payload: Record<string, unknown>;
  payloadSha256: string;
}
export type Phase9ApplyOutcome = "cloud-applied" | "already-present" | "rejected-conflict";
export const EDGE_EVENT_STAGE_PATH: "/api/edge/sync/events/stage";
export const EDGE_EVENT_STAGE_PROTOCOL: "factory-lan-event-stage/v1";
export const EDGE_EVENT_STAGE_RECEIPT_PROTOCOL: "factory-lan-event-stage-receipt/v1";
export const EDGE_EVENT_RECEIPT_QUERY_PATH: "/api/edge/sync/events/applied-receipts";
export const EDGE_EVENT_RECEIPT_QUERY_PROTOCOL: "factory-lan-event-applied-query/v1";
export const EDGE_EVENT_RECEIPT_PROTOCOL: "factory-lan-event-applied-receipts/v1";
export const EDGE_EVENT_STAGE_LIMIT: number;
export const EVENT_APPLY_OUTCOMES: readonly Phase9ApplyOutcome[];
export function phase9EventStreams(): string[];
export function isPhase9EventStream(stream: unknown): stream is string;
export function validatePhase9Event(stream: string, event: unknown): Phase9StagedEvent;
export function validatePhase9EventStageEnvelope(body: unknown, expectedSiteId: string): Phase9StagedEvent[];
export function validatePhase9ReceiptQuery(
  body: unknown,
  expectedSiteId: string
): { protocol: string; siteId: string; stream: string; fromSequence: string };
