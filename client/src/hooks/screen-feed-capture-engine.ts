import { getRemoteSupportTabId } from "./use-remote-control-session";
import { hashScreenFeedPixels, shouldUploadScreenFrame } from "./screen-feed-capture-policy";
import { sendScreenFeedBinaryFrame } from "@/lib/screen-feed-binary-transport";
import {
  CAPTURE_TIMEOUT_MS,
  CLICK_RETAIN_MS,
  FAST_CAPTURE_WIDTH,
  FAST_MAX_JPEG_BYTES,
  MAX_JPEG_BYTES,
  RETRY_CAPTURE_TIMEOUT_MS,
  SIGNATURE_WIDTH,
  STANDARD_CAPTURE_WIDTH,
  buildFallbackCanvas,
  buildHtml2CanvasOptions,
  errorMessage,
  prepareScrollableSnapshot,
  trace,
  tryCapture,
  type CaptureCanvasResult,
  type CaptureSource,
  type EncodedFrame,
  type ScreenFeedCaptureResult,
  type ScreenFeedClickEvent,
  type ScreenFeedCursorEvent,
} from "./screen-feed-capture-engineSanitizeClone";
export type {
  ScreenFeedCaptureResult,
  ScreenFeedClickEvent,
  ScreenFeedCursorEvent,
  ScreenFeedFailureStage,
} from "./screen-feed-capture-engineSanitizeClone";
const SIGNATURE_HEIGHT = 18;
// Once an unsupported CSS color is observed, recover future frames directly.
let captureNeedsColorCompatibility = false;

function isCaptureTimeout(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("timeout-");
}

function isUnsupportedColorFailure(error: unknown): boolean {
  return /unsupported color function/i.test(errorMessage(error));
}

async function waitForCaptureReady(): Promise<void> {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  try {
    await Promise.race([
      document.fonts?.ready ?? Promise.resolve(),
      new Promise<void>((resolve) => setTimeout(resolve, 500)),
    ]);
  } catch {
    // Font readiness must never block capture.
  }
}

async function withSafeCreatePattern<T>(fn: () => Promise<T>): Promise<T> {
  const original = CanvasRenderingContext2D.prototype.createPattern;
  CanvasRenderingContext2D.prototype.createPattern = function (
    image: CanvasImageSource,
    repetition: string | null
  ): CanvasPattern | null {
    try {
      return original.call(this, image, repetition);
    } catch {
      return null;
    }
  };
  try {
    return await fn();
  } finally {
    CanvasRenderingContext2D.prototype.createPattern = original;
  }
}

function buildFrameSignature(canvas: HTMLCanvasElement): string | null {
  try {
    const sample = document.createElement("canvas");
    sample.width = SIGNATURE_WIDTH;
    sample.height = SIGNATURE_HEIGHT;
    const ctx = sample.getContext("2d", { willReadFrequently: true });
    if (!ctx) return `${canvas.width}x${canvas.height}`;
    ctx.drawImage(canvas, 0, 0, SIGNATURE_WIDTH, SIGNATURE_HEIGHT);
    return hashScreenFeedPixels(ctx.getImageData(0, 0, SIGNATURE_WIDTH, SIGNATURE_HEIGHT).data);
  } catch (error) {
    trace("signature-failed", errorMessage(error));
    return null;
  }
}

function resizeCanvas(source: HTMLCanvasElement, maxWidth: number): HTMLCanvasElement {
  if (source.width <= maxWidth) return source;
  const scale = maxWidth / source.width;
  const target = document.createElement("canvas");
  target.width = maxWidth;
  target.height = Math.max(1, Math.round(source.height * scale));
  const ctx = target.getContext("2d");
  if (!ctx) return source;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0, target.width, target.height);
  return target;
}

function canvasToJpegBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
}

async function encodeFrame(canvas: HTMLCanvasElement, fast: boolean): Promise<EncodedFrame | null> {
  const maxWidth = fast ? FAST_CAPTURE_WIDTH : STANDARD_CAPTURE_WIDTH;
  const quality = fast ? 0.56 : 0.7;
  const limit = fast ? FAST_MAX_JPEG_BYTES : MAX_JPEG_BYTES;
  const candidate = resizeCanvas(canvas, maxWidth);
  const blob = await canvasToJpegBlob(candidate, quality);
  if (!blob || blob.type !== "image/jpeg" || blob.size <= 0 || blob.size > limit) return null;
  return { blob, canvas: candidate, quality };
}

interface EncodeOutcome {
  encoded: EncodedFrame | null;
  source: CaptureSource;
  failureReason?: string;
}

async function encodeWithFallback(
  canvas: HTMLCanvasElement,
  fast: boolean,
  source: CaptureSource
): Promise<EncodeOutcome> {
  let reason: string;
  try {
    const encoded = await encodeFrame(canvas, fast);
    if (encoded) return { encoded, source };
    reason = "encode-invalid-or-oversized";
  } catch (error) {
    reason = errorMessage(error);
  }

  trace("encode-fallback", reason);
  try {
    const encoded = await encodeFrame(buildFallbackCanvas(reason), fast);
    if (encoded) return { encoded, source: "fallback", failureReason: reason };
  } catch (error) {
    reason = `${reason}; fallback: ${errorMessage(error)}`;
  }

  return { encoded: null, source: "fallback", failureReason: reason };
}

async function runCaptureAttempt(
  scrollElements: Iterable<HTMLElement>,
  retry: boolean,
  recoverColors: boolean,
  fast: boolean
): Promise<HTMLCanvasElement> {
  const lease = prepareScrollableSnapshot(scrollElements);
  try {
    const options = buildHtml2CanvasOptions(lease.snapshot, recoverColors, fast);
    if (!retry) return await withSafeCreatePattern(() => tryCapture(options, CAPTURE_TIMEOUT_MS));
    return await withSafeCreatePattern(() =>
      tryCapture(
        {
          ...options,
          scale: Math.min(Number(options.scale) || 0.5, 0.5),
          imageTimeout: 700,
          foreignObjectRendering: false,
        },
        RETRY_CAPTURE_TIMEOUT_MS
      )
    );
  } finally {
    lease.restore();
  }
}

async function captureCanvas(scrollElements: Iterable<HTMLElement>, fast: boolean): Promise<CaptureCanvasResult> {
  trace("capture-start");
  await waitForCaptureReady();
  try {
    const canvas = await runCaptureAttempt(scrollElements, false, captureNeedsColorCompatibility, fast);
    trace("capture-ok");
    return { canvas, source: "dom" };
  } catch (error) {
    const firstReason = errorMessage(error);
    trace("capture-fail-p1", firstReason);
    if (isUnsupportedColorFailure(error)) captureNeedsColorCompatibility = true;

    if (isCaptureTimeout(error)) {
      trace("capture-fallback-timeout", firstReason);
      return { canvas: buildFallbackCanvas(firstReason), source: "fallback", failureReason: firstReason };
    }

    try {
      const canvas = await runCaptureAttempt(scrollElements, true, captureNeedsColorCompatibility, fast);
      trace("capture-ok-retry");
      return { canvas, source: "retry", failureReason: firstReason };
    } catch (retryError) {
      const reason = `${firstReason}; retry: ${errorMessage(retryError)}`;
      trace("capture-fallback", reason);
      return { canvas: buildFallbackCanvas(reason), source: "fallback", failureReason: reason };
    }
  }
}

function buildViewportMetadata() {
  const documentElement = document.documentElement;
  const body = document.body;
  return {
    width: Math.max(1, Math.round(window.innerWidth)),
    height: Math.max(1, Math.round(window.innerHeight)),
    scrollX: Math.max(0, Math.round(window.scrollX)),
    scrollY: Math.max(0, Math.round(window.scrollY)),
    documentWidth: Math.max(documentElement.scrollWidth, body?.scrollWidth ?? 0, window.innerWidth),
    documentHeight: Math.max(documentElement.scrollHeight, body?.scrollHeight ?? 0, window.innerHeight),
    devicePixelRatio: Math.max(0.25, window.devicePixelRatio || 1),
    visualScale: Math.max(0.25, window.visualViewport?.scale ?? 1),
  };
}

function cancelledResult(lastUploadedClickTs: number, startedAt = Date.now()): ScreenFeedCaptureResult {
  return {
    uploaded: false,
    unchanged: false,
    failed: false,
    cancelled: true,
    signature: null,
    latestClickTs: lastUploadedClickTs,
    durationMs: Math.max(0, Date.now() - startedAt),
  };
}

export async function captureAndUploadScreenFrame(input: {
  fast: boolean;
  lastSignature: string | null;
  lastUploadedClickTs: number;
  cursor: ScreenFeedCursorEvent | null;
  expectedPath: string;
  clicks: readonly ScreenFeedClickEvent[];
  scrollElements: Iterable<HTMLElement>;
  shouldContinue: () => boolean;
}): Promise<ScreenFeedCaptureResult> {
  if (!input.shouldContinue() || document.visibilityState !== "visible") {
    return cancelledResult(input.lastUploadedClickTs);
  }

  const startedAt = Date.now();
  const captured = await captureCanvas(input.scrollElements, input.fast);
  if (
    !input.shouldContinue() ||
    document.visibilityState !== "visible" ||
    window.location.href !== input.expectedPath
  ) {
    trace("capture-discarded");
    return cancelledResult(input.lastUploadedClickTs, startedAt);
  }

  const signature = buildFrameSignature(captured.canvas);
  const cutoff = Date.now() - CLICK_RETAIN_MS;
  const clicks = input.clicks.filter((click) => click.ts >= cutoff);
  const latestClickTs = clicks.reduce((latest, click) => Math.max(latest, click.ts), 0);

  if (
    !shouldUploadScreenFrame({
      signature: signature ?? "",
      lastSignature: input.lastSignature,
      latestClickTs,
      lastUploadedClickTs: input.lastUploadedClickTs,
      force: signature === null,
    })
  ) {
    return {
      uploaded: false,
      unchanged: true,
      failed: false,
      cancelled: false,
      signature,
      latestClickTs,
      durationMs: Math.max(0, Date.now() - startedAt),
    };
  }

  const {
    encoded,
    source,
    failureReason: encodeFailureReason,
  } = await encodeWithFallback(captured.canvas, input.fast, captured.source);
  const failureReason = encodeFailureReason ?? captured.failureReason;

  if (!encoded) {
    const reason = failureReason ?? "Screen frame encoding failed.";
    trace("encode-failed", reason);
    return {
      uploaded: false,
      unchanged: false,
      failed: true,
      cancelled: false,
      signature,
      latestClickTs,
      durationMs: Math.max(0, Date.now() - startedAt),
      failureStage: "encode",
      failureReason: reason,
    };
  }

  if (!input.shouldContinue() || document.visibilityState !== "visible") {
    return cancelledResult(input.lastUploadedClickTs, startedAt);
  }

  const completedAt = Date.now();
  try {
    const uploaded = await sendScreenFeedBinaryFrame(
      {
        type: "screen-feed-frame",
        version: 1,
        tabId: getRemoteSupportTabId(),
        capturedAt: new Date(completedAt).toISOString(),
        metadata: {
          clicks,
          cursor: input.cursor,
          viewport: buildViewportMetadata(),
          capture: {
            width: encoded.canvas.width,
            height: encoded.canvas.height,
            source,
            quality: encoded.quality,
            encodedBytes: encoded.blob.size,
            durationMs: completedAt - startedAt,
            failureReason,
          },
        },
      },
      encoded.blob
    );
    if (!uploaded) trace("upload-rejected", "transport-not-ready");
    return {
      uploaded,
      unchanged: false,
      failed: !uploaded,
      cancelled: false,
      signature,
      latestClickTs,
      durationMs: Math.max(0, Date.now() - startedAt),
      ...(!uploaded
        ? { failureStage: "upload" as const, failureReason: "Screen-feed WebSocket transport is not ready." }
        : {}),
    };
  } catch (error) {
    if (!input.shouldContinue() || document.visibilityState !== "visible") {
      return cancelledResult(input.lastUploadedClickTs, startedAt);
    }
    const reason = errorMessage(error) || "Screen frame upload failed.";
    trace("upload-error", reason);
    return {
      uploaded: false,
      unchanged: false,
      failed: true,
      cancelled: false,
      signature,
      latestClickTs,
      durationMs: Math.max(0, Date.now() - startedAt),
      failureStage: "upload",
      failureReason: reason,
    };
  }
}
