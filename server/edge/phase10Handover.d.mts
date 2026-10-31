import type { PoolClient } from "pg";
import type { Phase10SyncControlState } from "./phase10SyncControl.mjs";

export interface Phase10StreamEvidence {
  stream: string;
  installed: boolean;
  captured: number;
  pending: number;
  notStaged?: number;
  stagedNotApplied?: number;
  applied?: number;
  rejectedByOperator?: number;
  lastSequence?: string;
}
export function summarizeLanEvidence(
  client: Pick<PoolClient, "query">,
  siteId: string
): Promise<{
  siteId: string;
  generatedAt: string;
  relayPaused: boolean;
  relayControl: Phase10SyncControlState;
  streams: Phase10StreamEvidence[];
  pendingTotal: number;
  handoverReady: boolean;
}>;
