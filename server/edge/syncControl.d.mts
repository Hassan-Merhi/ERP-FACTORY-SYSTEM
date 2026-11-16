import type { PoolClient } from "pg";

type Queryable = Pick<PoolClient, "query">;
export interface Phase10SyncControlState {
  paused: boolean;
  operatorName: string | null;
  reason: string | null;
  recordedAt: string | null;
}
export class Phase10ControlRefusal extends Error {}
export function ensurePhase10SyncControlSchema(queryable: Queryable): Promise<void>;
export function readPhase10SyncControl(queryable: Queryable, siteId: string): Promise<Phase10SyncControlState>;
export function recordPhase10SyncControl(
  queryable: Queryable,
  input: { siteId: string; action: "pause" | "resume"; operatorName: string; reason: string }
): Promise<Phase10SyncControlState>;
