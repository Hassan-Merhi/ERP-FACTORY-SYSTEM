/**
 * Parser for the read-only LAN operator report (GET /api/edge/operator/status).
 * Anything that does not match the expected shape is rejected rather than
 * partially rendered, so the panel never shows a misleading "ready" state.
 */
export interface EdgeOperatorStream {
  stream: string;
  installed: boolean;
  captured: number;
  pending: number;
  stagedNotApplied: number;
  applied: number;
  rejectedByOperator: number;
}

export interface EdgeOperatorStatus {
  siteId: string;
  generatedAt: string;
  relayPaused: boolean;
  pausedBy: string | null;
  pausedReason: string | null;
  pendingTotal: number;
  handoverReady: boolean;
  streams: EdgeOperatorStream[];
}

const count = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
const optionalCount = (value: unknown): number | null => (value === undefined ? 0 : count(value));
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function parseStream(value: unknown): EdgeOperatorStream | null {
  if (!isRecord(value) || typeof value.stream !== "string" || typeof value.installed !== "boolean") return null;
  const captured = count(value.captured);
  const pending = count(value.pending);
  const stagedNotApplied = optionalCount(value.stagedNotApplied);
  const applied = optionalCount(value.applied);
  const rejectedByOperator = optionalCount(value.rejectedByOperator);
  if (captured === null || pending === null || stagedNotApplied === null || applied === null) return null;
  if (rejectedByOperator === null) return null;
  return {
    stream: value.stream,
    installed: value.installed,
    captured,
    pending,
    stagedNotApplied,
    applied,
    rejectedByOperator,
  };
}

export function parseEdgeOperatorStatus(body: unknown): EdgeOperatorStatus | null {
  if (!isRecord(body)) return null;
  const { siteId, generatedAt, relayPaused, handoverReady, streams } = body;
  const pendingTotal = count(body.pendingTotal);
  if (typeof siteId !== "string" || typeof generatedAt !== "string") return null;
  if (typeof relayPaused !== "boolean" || typeof handoverReady !== "boolean" || pendingTotal === null) return null;
  if (!Array.isArray(streams)) return null;
  const parsed = streams.map(parseStream);
  if (parsed.some((stream) => stream === null)) return null;
  const control = isRecord(body.relayControl) ? body.relayControl : {};
  return {
    siteId,
    generatedAt,
    relayPaused,
    pausedBy: typeof control.operatorName === "string" ? control.operatorName : null,
    pausedReason: typeof control.reason === "string" ? control.reason : null,
    pendingTotal,
    // Never report ready while anything is still pending, whatever the server says.
    handoverReady: handoverReady && pendingTotal === 0,
    streams: parsed as EdgeOperatorStream[],
  };
}
