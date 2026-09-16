/**
 * Phase 10 — controller-side command flow policy.
 *
 * The controller overlay used to hand every coalesced sample to the ordered
 * send queue and only learn it was unwanted from the response. Two things went
 * wrong with that:
 *
 *   - a burst that tripped the server rate limiter kept sending, so each
 *     refusal cost a round trip and the refusals themselves kept the window
 *     saturated;
 *   - pointer moves that were queued behind a slow request were still sent
 *     after a newer position was already known, so the remote cursor replayed
 *     a stale trail.
 *
 * These are pure decisions so they can be tested without a DOM, a session, or
 * a network. The overlay owns the refs and timers; this module owns the rules.
 */

export type RemoteControlCommandKind = "pointer-move" | "click" | "scroll";

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

/**
 * True when the gate is closed. Pointer moves and scrolls are *dropped* while
 * closed — they are samples of a continuous signal and a newer one is always
 * along shortly. Clicks are discrete intent and are never dropped silently;
 * the caller retries them once the gate reopens.
 */
export function isRemoteControlSendBlocked(gate: RemoteControlRateGate, now: number): boolean {
  return gate.blockedUntil > now;
}

export function remoteControlSendDelayMs(gate: RemoteControlRateGate, now: number): number {
  return Math.max(0, gate.blockedUntil - now);
}

/**
 * Applies a 429. `retryAfterMs` is the server's own window remainder when it
 * sent one; otherwise an exponential fallback keeps a blind client from
 * hammering the endpoint.
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

/** A successful send proves the window reopened. */
export function clearRemoteControlRateLimit(gate: RemoteControlRateGate): RemoteControlRateGate {
  return gate.blockedUntil === 0 && gate.consecutiveRefusals === 0 ? gate : createRemoteControlRateGate();
}

/**
 * Decides what to do with a command about to enter the send queue.
 *
 * `supersede` means a newer pointer sample already exists, so this one carries
 * no information; `defer` means the rate gate is closed but the command is
 * discrete and must survive; `send` is the ordinary path.
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

/** True when a failed request means the command was refused for rate, not rejected outright. */
export function isRemoteControlRateLimitError(error: { status?: number; code?: string | null }): boolean {
  return error.status === 429 || error.code === "COMMAND_RATE_LIMITED" || error.code === "KEYBOARD_RATE_LIMITED";
}
