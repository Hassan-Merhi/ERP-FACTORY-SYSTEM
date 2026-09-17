/**
 * Controller-side command flow policy.
 *
 * Continuous pointer/scroll samples may be dropped while the transport is
 * under pressure; discrete click and keyboard intent must survive and wait for
 * the gate to reopen. The same gate is also used for a temporarily unavailable
 * audit queue (503), otherwise a fail-closed audit outage becomes an 8+/s retry
 * storm from an otherwise healthy controller.
 */

export type RemoteControlCommandKind = "pointer-move" | "click" | "scroll" | "keyboard";

export interface RemoteControlRateGate {
  /** Epoch ms before which no command may be sent. 0 means "open". */
  blockedUntil: number;
  /** Consecutive refusals, used to grow the fallback backoff. */
  consecutiveRefusals: number;
}

/** No backoff hint from the server: start here and double, capped. */
const FALLBACK_BACKOFF_MS = 250;
const MAX_BACKOFF_MS = 5000;

export function createRemoteControlRateGate(): RemoteControlRateGate {
  return { blockedUntil: 0, consecutiveRefusals: 0 };
}

export function isRemoteControlSendBlocked(gate: RemoteControlRateGate, now: number): boolean {
  return gate.blockedUntil > now;
}

export function remoteControlSendDelayMs(gate: RemoteControlRateGate, now: number): number {
  return Math.max(0, gate.blockedUntil - now);
}

/**
 * Applies server backpressure. `retryAfterMs` is preferred when supplied;
 * otherwise an exponential fallback keeps a blind client from hammering the
 * endpoint/socket when the limiter or audit queue cannot accept work.
 */
export function applyRemoteControlRateLimit(
  gate: RemoteControlRateGate,
  now: number,
  retryAfterMs: number | null | undefined
): RemoteControlRateGate {
  const refusals = gate.consecutiveRefusals + 1;
  const hinted = typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs) && retryAfterMs > 0;
  const backoff = hinted
    ? Math.min(retryAfterMs, MAX_BACKOFF_MS)
    : Math.min(FALLBACK_BACKOFF_MS * 2 ** (refusals - 1), MAX_BACKOFF_MS);
  return { blockedUntil: now + backoff, consecutiveRefusals: refusals };
}

/** A successful send proves the pressure window reopened. */
export function clearRemoteControlRateLimit(gate: RemoteControlRateGate): RemoteControlRateGate {
  return gate.blockedUntil === 0 && gate.consecutiveRefusals === 0 ? gate : createRemoteControlRateGate();
}

/**
 * `supersede` means a newer continuous sample carries all useful state;
 * `defer` means a discrete click/keyboard action must wait; `send` is ordinary.
 */
export function decideRemoteControlCommand(input: {
  kind: RemoteControlCommandKind;
  gate: RemoteControlRateGate;
  now: number;
  /** True when a newer pointer sample has already been recorded locally. */
  hasNewerPointerSample?: boolean;
}): "send" | "supersede" | "defer" {
  if (input.kind === "pointer-move" && input.hasNewerPointerSample) return "supersede";
  if (!isRemoteControlSendBlocked(input.gate, input.now)) return "send";
  return input.kind === "pointer-move" || input.kind === "scroll" ? "supersede" : "defer";
}

/**
 * True when a failed request is transient transport pressure rather than a
 * terminal command rejection. A fail-closed audit queue uses 503 and the
 * REMOTE_SUPPORT_AUDIT_UNAVAILABLE code, so it receives the same quiet backoff
 * behavior as 429 rate limiting.
 */
export function isRemoteControlRateLimitError(error: { status?: number; code?: string | null }): boolean {
  return (
    error.status === 429 ||
    error.status === 503 ||
    error.code === "COMMAND_RATE_LIMITED" ||
    error.code === "KEYBOARD_RATE_LIMITED" ||
    error.code === "REMOTE_SUPPORT_AUDIT_UNAVAILABLE"
  );
}
