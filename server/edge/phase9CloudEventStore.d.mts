import type { Pool, PoolClient } from "pg";
import type { Phase9ApplyOutcome, Phase9StagedEvent } from "./phase9EventProtocol.mjs";

type Queryable = Pick<PoolClient, "query">;
export class Phase9ApplyRefusal extends Error {}
export class Phase9EventConflict extends Error {
  constructor(code: string, detail?: Record<string, unknown>);
  readonly detail: Record<string, unknown>;
}
export class Phase9StageConflict extends Error {}
export interface Phase9ApplyInput {
  siteId: string;
  companyId: number;
  baselineSha256: string;
  cloudEpoch: string | number;
  operatorAck: string;
  stream: string;
  sequence?: string;
}
export interface Phase9EventHandler<E = Phase9StagedEvent> {
  authorize(client: PoolClient, event: E): Promise<void>;
  apply(
    client: PoolClient,
    event: E
  ): Promise<{ outcome: "cloud-applied" | "already-present"; cloudRef: number; businessDate: string }>;
  verify(client: PoolClient, event: E, result: { cloudRef: number; businessDate: string }): Promise<boolean>;
}
export interface Phase9AppliedReceipt {
  stream: string;
  sequence: string;
  operationId: string;
  companyId: number;
  actorUserId: string;
  kind: string;
  localRef: number;
  cloudRef: number | null;
  payloadSha256: string;
  businessDate: string | null;
  outcome: Phase9ApplyOutcome;
  replayed: boolean;
}
export function ensurePhase9CloudEventSchema(queryable: Queryable): Promise<void>;
export function stagePhase9Events(
  pool: Pool,
  body: unknown,
  siteId: string
): Promise<{
  protocol: string;
  siteId: string;
  stream: string;
  state: "staged-not-applied";
  lastSequence: string;
  events: { sequence: string; operationId: string; payloadSha256: string; state: "staged-not-applied" }[];
}>;
// Handlers are typed per event kind by their own modules.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Phase9HandlerMap = Record<string, Phase9EventHandler<any>>;
export function applyStagedEventOnce(
  queryable: Queryable,
  input: Phase9ApplyInput,
  handlers: Phase9HandlerMap
): Promise<Phase9AppliedReceipt>;
export function applyPendingStagedEvents(
  queryable: Queryable,
  input: Phase9ApplyInput,
  handlers: Phase9HandlerMap,
  limit?: number
): Promise<Phase9AppliedReceipt[]>;
export function recordPhase9ConflictDecision(
  queryable: Queryable,
  input: { siteId: string; stream: string; sequence: string; decidedBy: string; reason: string }
): Promise<{ stream: string; sequence: string; decision: "reject-event" }>;
export function getPhase9AppliedReceipts(
  queryable: Queryable,
  body: unknown,
  expectedSiteId: string
): Promise<{
  protocol: string;
  siteId: string;
  stream: string;
  events: Omit<Phase9AppliedReceipt, "replayed">[];
}>;
export function summarizePhase9CloudStreams(
  queryable: Queryable,
  siteId: string
): Promise<{ stream: string; stagedThrough: string; appliedThrough: string; openConflicts: number }[]>;
