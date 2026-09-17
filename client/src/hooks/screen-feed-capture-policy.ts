// Binary transport removed the 650 ms upload limiter and the capture path now
// does one JPEG Blob encode instead of base64/JSON. Keep interaction frames
// responsive while still leaving the watched tab meaningful main-thread time.
export const ACTIVE_CAPTURE_MIN_GAP_MS = 220;
export const DIRTY_SETTLE_MS = 90;
export const MAX_DIRTY_LATENCY_MS = 700;
export const IDLE_REFRESH_MS = 60000;
export const FAILED_CAPTURE_BACKOFF_MS = 3500;

// Keep the legacy exports for tests/older call sites.
export const ACTIVE_CAPTURE_DELAY_MS = ACTIVE_CAPTURE_MIN_GAP_MS;
export const IDLE_CAPTURE_DELAY_MS = 5000;
export const MAX_IDLE_CAPTURE_DELAY_MS = IDLE_REFRESH_MS;
export const FAILED_CAPTURE_DELAY_MS = FAILED_CAPTURE_BACKOFF_MS;

/**
 * Adaptive capture protection now targets roughly a 50% capture duty ceiling:
 * after an expensive render the browser gets one render-duration of idle time.
 * The old factor of 2 was layered on top of an 850 ms hard floor and the old
 * HTTP/base64 upload limiter; keeping all three after the transport rewrite
 * unnecessarily capped the live feed near 1 fps.
 */
export const CAPTURE_DUTY_CYCLE = 1;
export const MAX_ADAPTIVE_CAPTURE_GAP_MS = 8000;
export const MAX_FAILED_CAPTURE_BACKOFF_MS = 60000;

export function adaptiveCaptureGapMs(requestedGapMs: number, lastCaptureDurationMs: number): number {
  if (!Number.isFinite(lastCaptureDurationMs) || lastCaptureDurationMs <= 0) return requestedGapMs;
  return Math.min(MAX_ADAPTIVE_CAPTURE_GAP_MS, Math.max(requestedGapMs, lastCaptureDurationMs * CAPTURE_DUTY_CYCLE));
}

/**
 * Repeated failures mean something structural is wrong. Each consecutive
 * failure widens the gap up to a minute; success resets the counter.
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
