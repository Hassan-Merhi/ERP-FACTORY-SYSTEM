export const ACTIVE_CAPTURE_MIN_GAP_MS = 850;
export const DIRTY_SETTLE_MS = 180;
export const MAX_DIRTY_LATENCY_MS = 1200;
export const IDLE_REFRESH_MS = 60000;
export const FAILED_CAPTURE_BACKOFF_MS = 3500;

// Keep the legacy exports for any tests or older call sites, but map them onto
// the low-impact policy. The optimized hook no longer continuously captures
// unchanged pages just to discover that the frame is identical.
export const ACTIVE_CAPTURE_DELAY_MS = ACTIVE_CAPTURE_MIN_GAP_MS;
export const IDLE_CAPTURE_DELAY_MS = 5000;
export const MAX_IDLE_CAPTURE_DELAY_MS = IDLE_REFRESH_MS;
export const FAILED_CAPTURE_DELAY_MS = FAILED_CAPTURE_BACKOFF_MS;

/**
 * A full-page render costs the employee's main thread. Spacing captures by a
 * multiple of what the last one actually cost keeps the browser mostly idle on
 * heavy ERP screens instead of rendering back-to-back at the nominal cadence.
 *
 * Phase 11 reduced this from 4 to 2: remote clicks are now validated against
 * the frame's captured scroll/viewport state, so fresher frames directly mean
 * fewer stale-frame rejections and more accurate control.
 */
export const CAPTURE_DUTY_CYCLE = 2;
export const MAX_ADAPTIVE_CAPTURE_GAP_MS = 15000;
export const MAX_FAILED_CAPTURE_BACKOFF_MS = 60000;

export function adaptiveCaptureGapMs(requestedGapMs: number, lastCaptureDurationMs: number): number {
  if (!Number.isFinite(lastCaptureDurationMs) || lastCaptureDurationMs <= 0) return requestedGapMs;
  return Math.min(MAX_ADAPTIVE_CAPTURE_GAP_MS, Math.max(requestedGapMs, lastCaptureDurationMs * CAPTURE_DUTY_CYCLE));
}

/**
 * Repeated failures mean something structural is wrong (a rejected payload, a
 * renderer that cannot encode). Retrying at a fixed interval turns that into a
 * permanent load on the watched machine, so each consecutive failure widens the
 * gap up to a minute.
 */
export function failedCaptureBackoffMs(consecutiveFailures: number): number {
  const attempts = Math.max(1, Math.floor(consecutiveFailures));
  return Math.min(MAX_FAILED_CAPTURE_BACKOFF_MS, FAILED_CAPTURE_BACKOFF_MS * 2 ** Math.min(attempts - 1, 4));
}

export interface UploadDecisionInput {
  signature: string;
  lastSignature: string | null;
  latestClickTs: number;
  lastUploadedClickTs: number;
  force?: boolean;
}

export function shouldUploadScreenFrame({
  signature,
  lastSignature,
  latestClickTs,
  lastUploadedClickTs,
  force = false,
}: UploadDecisionInput): boolean {
  return force || signature !== lastSignature || latestClickTs > lastUploadedClickTs;
}

export function nextScreenFeedCaptureDelay(unchangedFrames: number, failed = false): number {
  if (failed) return FAILED_CAPTURE_BACKOFF_MS;
  if (unchangedFrames >= 4) return IDLE_REFRESH_MS;
  if (unchangedFrames >= 2) return IDLE_CAPTURE_DELAY_MS;
  return ACTIVE_CAPTURE_MIN_GAP_MS;
}

export function hashScreenFeedPixels(data: Uint8ClampedArray): string {
  let hash = 2166136261;
  for (let index = 0; index < data.length; index += 4) {
    hash ^= data[index] ?? 0;
    hash = Math.imul(hash, 16777619);
    hash ^= data[index + 1] ?? 0;
    hash = Math.imul(hash, 16777619);
    hash ^= data[index + 2] ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
