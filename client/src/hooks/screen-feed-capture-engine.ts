import { hashScreenFeedPixels, shouldUploadScreenFrame } from "./screen-feed-capture-policy";
import {
  approximateDataUrlBytes,
  getScreenFeedCaptureScale,
  isSafeScreenFeedAssetUrl,
  shouldPreserveScreenFeedBackground,
} from "./screen-feed-viewing-quality";

const CAPTURE_TIMEOUT_MS = 9000;
const RETRY_CAPTURE_TIMEOUT_MS = 5000;
const UPLOAD_TIMEOUT_MS = 8000;
const CLICK_RETAIN_MS = 8000;
const MAX_DATA_URL_LEN = 1_300_000;
const FAST_MAX_DATA_URL_LEN = 560_000;
const SIGNATURE_WIDTH = 32;
const SIGNATURE_HEIGHT = 18;
const MAX_CAPTURE_WIDTH = 1536;
const MIN_CAPTURE_SCALE = 0.4;
const SCROLL_KEY_ATTRIBUTE = "data-screenfeed-scroll-key";

const isDev = import.meta.env.DEV;

type Html2Canvas = (typeof import("html2canvas"))["default"];
type CaptureSource = "dom" | "retry" | "fallback";
export type ScreenFeedFailureStage = "render" | "encode" | "upload" | "pipeline";
let html2canvasPromise: Promise<Html2Canvas> | null = null;
let scrollKeySequence = 0;

export interface ScreenFeedClickEvent {
  x: number;
  y: number;
  label: string;
  ts: number;
}

export interface ScreenFeedCursorEvent {
  x: number;
  y: number;
  visible: boolean;
  ts: number;
}

export interface ScreenFeedCaptureResult {
  uploaded: boolean;
  unchanged: boolean;
  failed: boolean;
  cancelled: boolean;
  signature: string | null;
  latestClickTs: number;
  /** Wall-clock cost of the render + encode on the employee's main thread. */
  durationMs: number;
  failureStage?: ScreenFeedFailureStage;
  failureReason?: string;
}

interface EncodedFrame {
  dataUrl: string;
  canvas: HTMLCanvasElement;
  quality: number;
}

interface CaptureCanvasResult {
  canvas: HTMLCanvasElement;
  source: CaptureSource;
  failureReason?: string;
}

interface ScrollSnapshotLease {
  snapshot: Map<string, { top: number; left: number }>;
  restore: () => void;
}

async function loadHtml2Canvas(): Promise<Html2Canvas> {
  if (!html2canvasPromise) {
    html2canvasPromise = import("html2canvas")
      .then((module) => module.default)
      .catch((error) => {
        html2canvasPromise = null;
        throw error;
      });
  }
  return html2canvasPromise;
}

function trace(event: string, extra?: string): void {
  if (!isDev) return;
  const url = `/api/screen-feed/trace/${encodeURIComponent(event)}${extra ? `?d=${encodeURIComponent(extra)}` : ""}`;
  fetch(url, { credentials: "include" }).catch(() => {});
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 180) : String(error).slice(0, 180);
}

function isCaptureTimeout(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("timeout-");
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

function copyLiveFormState(doc: Document): void {
  const originals = Array.from(
    document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input, textarea, select")
  );
  const clones = Array.from(
    doc.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input, textarea, select")
  );

  originals.forEach((original, index) => {
    const clone = clones[index];
    if (!clone) return;
    if (original instanceof HTMLInputElement && clone instanceof HTMLInputElement) {
      clone.value = original.value;
      clone.checked = original.checked;
      clone.setAttribute("value", original.value);
      if (original.checked) clone.setAttribute("checked", "checked");
      else clone.removeAttribute("checked");
    } else if (original instanceof HTMLTextAreaElement && clone instanceof HTMLTextAreaElement) {
      clone.value = original.value;
      clone.textContent = original.value;
    } else if (original instanceof HTMLSelectElement && clone instanceof HTMLSelectElement) {
      clone.value = original.value;
      Array.from(clone.options).forEach((option, optionIndex) => {
        option.selected = original.options[optionIndex]?.selected ?? false;
      });
    }
  });

  const editableOriginals = Array.from(document.querySelectorAll<HTMLElement>("[contenteditable='true']"));
  const editableClones = Array.from(doc.querySelectorAll<HTMLElement>("[contenteditable='true']"));
  editableOriginals.forEach((original, index) => {
    if (editableClones[index]) editableClones[index].innerHTML = original.innerHTML;
  });
}

function prepareScrollableSnapshot(scrollElements: Iterable<HTMLElement>): ScrollSnapshotLease {
  const snapshot = new Map<string, { top: number; left: number }>();
  const candidates = new Set<HTMLElement>();
  candidates.add(document.documentElement);
  if (document.body) candidates.add(document.body);
  for (const element of scrollElements) {
    if (element.isConnected) candidates.add(element);
  }

  const restores: Array<{ element: HTMLElement; previous: string | null }> = [];
  for (const element of candidates) {
    if (element.scrollTop === 0 && element.scrollLeft === 0) continue;
    const key = `sf-scroll-${++scrollKeySequence}`;
    restores.push({ element, previous: element.getAttribute(SCROLL_KEY_ATTRIBUTE) });
    element.setAttribute(SCROLL_KEY_ATTRIBUTE, key);
    snapshot.set(key, { top: element.scrollTop, left: element.scrollLeft });
  }

  return {
    snapshot,
    restore: () => {
      for (const { element, previous } of restores) {
        if (previous === null) element.removeAttribute(SCROLL_KEY_ATTRIBUTE);
        else element.setAttribute(SCROLL_KEY_ATTRIBUTE, previous);
      }
      snapshot.clear();
    },
  };
}

function copyScrollablePositions(doc: Document, snapshot: Map<string, { top: number; left: number }>): void {
  for (const [key, position] of snapshot) {
    const clone = doc.querySelector<HTMLElement>(`[${SCROLL_KEY_ATTRIBUTE}="${key}"]`);
    if (!clone) continue;
    clone.scrollTop = position.top;
    clone.scrollLeft = position.left;
  }
}

function sanitizeClone(doc: Document, snapshot: Map<string, { top: number; left: number }>): void {
  const origin = window.location.origin;
  copyLiveFormState(doc);
  copyScrollablePositions(doc, snapshot);

  // One stylesheet on the clone replaces the old per-element getComputedStyle
  // walk. Filters, blend modes, and pseudo-element decorations are stripped in
  // O(1) instead of forcing layout on every node of a large ERP page.
  const captureOverrides = doc.createElement("style");
  captureOverrides.setAttribute("data-screenfeed-capture-styles", "true");
  captureOverrides.textContent = `
    * {
      caret-color: transparent !important;
      filter: none !important;
      backdrop-filter: none !important;
      mix-blend-mode: normal !important;
    }
    *::before,
    *::after {
      color: inherit !important;
      background-color: transparent !important;
      background-image: none !important;
      border-color: currentColor !important;
      box-shadow: none !important;
      text-shadow: none !important;
      filter: none !important;
      backdrop-filter: none !important;
    }
  `;
  doc.head.appendChild(captureOverrides);

  doc.querySelectorAll<HTMLImageElement>("img").forEach((element) => {
    const src = element.currentSrc || element.getAttribute("src") || "";
    if (src && !isSafeScreenFeedAssetUrl(src, origin)) {
      element.removeAttribute("src");
      element.removeAttribute("srcset");
      element.style.visibility = "hidden";
    }
  });

  doc.querySelectorAll<SVGImageElement>("image").forEach((element) => {
    const href = element.getAttribute("href") || element.getAttribute("xlink:href") || "";
    if (href && !isSafeScreenFeedAssetUrl(href, origin)) element.remove();
  });

  // Inline background URLs only — reading computed style for every element was
  // the capture hot path. Stylesheet `color-mix()` is resolved at build time.
  doc.querySelectorAll<HTMLElement>("[style]").forEach((element) => {
    const backgroundImage = element.style.backgroundImage;
    if (backgroundImage && backgroundImage !== "none" && !shouldPreserveScreenFeedBackground(backgroundImage, origin)) {
      element.style.backgroundImage = "none";
    }
  });
}

function buildHtml2CanvasOptions(snapshot: Map<string, { top: number; left: number }>) {
  const nativeScale = getScreenFeedCaptureScale(window.devicePixelRatio);
  const viewportScale = Math.min(1, MAX_CAPTURE_WIDTH / Math.max(1, window.innerWidth));
  const captureScale = Math.max(MIN_CAPTURE_SCALE, Math.min(nativeScale, viewportScale));

  return {
    scale: captureScale,
    useCORS: true,
    allowTaint: false,
    logging: false,
    // ForeignObject rendering draws the page through an SVG <foreignObject>
    // image. Chromium marks any canvas that consumed such an image as tainted,
    // so the later toDataURL() throws SecurityError and the frame is dropped —
    // silently, forever, while the employee keeps paying for full page renders.
    // The regular renderer is the only one whose output can actually be encoded.
    foreignObjectRendering: false,
    imageTimeout: 1800,
    removeContainer: true,
    onclone: (doc: Document) => sanitizeClone(doc, snapshot),
    ignoreElements: (element: Element) => element.getAttribute("data-screenfeed-ignore") === "true",
  } as const;
}

async function tryCapture(opts: Record<string, unknown>, timeoutMs: number): Promise<HTMLCanvasElement> {
  const html2canvas = await loadHtml2Canvas();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      html2canvas(document.body, {
        ...opts,
        x: window.scrollX,
        y: window.scrollY,
        width: window.innerWidth,
        height: window.innerHeight,
        scrollX: -window.scrollX,
        scrollY: -window.scrollY,
        windowWidth: window.innerWidth,
        windowHeight: window.innerHeight,
      }),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(`timeout-${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function buildFallbackCanvas(reason: string): HTMLCanvasElement {
  const width = Math.max(800, Math.min(1440, window.innerWidth));
  const height = Math.max(480, Math.round(width * (window.innerHeight / Math.max(1, window.innerWidth))));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;
  const dark = document.documentElement.classList.contains("dark");

  ctx.fillStyle = dark ? "#1c1c1e" : "#f0f0f0";
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = dark ? "#e5e5e5" : "#111";
  ctx.font = "bold 18px system-ui, sans-serif";
  ctx.fillText(document.title.slice(0, 90), 24, 48);
  ctx.fillStyle = dark ? "#aaa" : "#555";
  ctx.font = "14px monospace";
  ctx.fillText(window.location.href.slice(0, 120), 24, 80);
  ctx.fillStyle = "#888";
  ctx.font = "12px system-ui, sans-serif";
  ctx.fillText(new Date().toLocaleTimeString(), 24, 110);
  ctx.fillText(`Capture fallback: ${reason.slice(0, 120)}`, 24, 132);

  let y = 170;
  document.querySelectorAll<HTMLElement>("header, nav, h1, h2, h3, button, [role='dialog']").forEach((element) => {
    const text = element.textContent?.replace(/\s+/g, " ").trim().slice(0, 120);
    if (!text || y > height - 24) return;
    ctx.fillStyle = dark ? "#ccc" : "#222";
    ctx.font = element.matches("h1, h2, h3") ? "bold 15px system-ui" : "13px system-ui, sans-serif";
    ctx.fillText(text, 24, y);
    y += 22;
  });

  return canvas;
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

/**
 * Returns null when the pixels cannot be read at all (a tainted canvas throws
 * SecurityError from getImageData). A null signature means "unknown", which
 * makes the caller upload the frame rather than silently dropping it.
 */
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

function encodeFrame(canvas: HTMLCanvasElement, fast: boolean): EncodedFrame | null {
  // One resize + one JPEG encode. The old quality ladder called toDataURL up
  // to five times per frame, each pass re-compressing the whole screenshot.
  const maxWidth = fast ? 1120 : 1440;
  const quality = fast ? 0.56 : 0.7;
  const limit = fast ? FAST_MAX_DATA_URL_LEN : MAX_DATA_URL_LEN;
  const candidate = resizeCanvas(canvas, maxWidth);
  const dataUrl = candidate.toDataURL("image/jpeg", quality);
  if (!dataUrl.startsWith("data:image/") || dataUrl.length > limit) return null;
  return { dataUrl, canvas: candidate, quality };
}

interface EncodeOutcome {
  encoded: EncodedFrame | null;
  source: CaptureSource;
  failureReason?: string;
}

/**
 * Encoding is the last place a capture can die, and it dies for reasons the
 * render itself cannot see: a tainted canvas throws SecurityError, an oversized
 * page encodes past the transport limit. Dropping the frame there leaves the
 * watcher on "waiting for the first frame" with no explanation while the
 * employee's browser keeps re-rendering the page. Falling back to the cheap
 * text canvas keeps the viewer populated and carries the reason across.
 */
function encodeWithFallback(canvas: HTMLCanvasElement, fast: boolean, source: CaptureSource): EncodeOutcome {
  const limit = fast ? FAST_MAX_DATA_URL_LEN : MAX_DATA_URL_LEN;
  let reason: string;
  try {
    const encoded = encodeFrame(canvas, fast);
    if (encoded?.dataUrl.startsWith("data:image/") && encoded.dataUrl.length <= limit) {
      return { encoded, source };
    }
    reason = `encode-invalid-${encoded?.dataUrl.length ?? 0}`;
  } catch (error) {
    reason = errorMessage(error);
  }

  trace("encode-fallback", reason);
  try {
    const encoded = encodeFrame(buildFallbackCanvas(reason), fast);
    if (encoded?.dataUrl.startsWith("data:image/") && encoded.dataUrl.length <= limit) {
      return { encoded, source: "fallback", failureReason: reason };
    }
  } catch (error) {
    reason = `${reason}; fallback: ${errorMessage(error)}`;
  }

  return { encoded: null, source: "fallback", failureReason: reason };
}

async function runCaptureAttempt(scrollElements: Iterable<HTMLElement>, retry: boolean): Promise<HTMLCanvasElement> {
  const lease = prepareScrollableSnapshot(scrollElements);
  try {
    const options = buildHtml2CanvasOptions(lease.snapshot);
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

async function captureCanvas(scrollElements: Iterable<HTMLElement>): Promise<CaptureCanvasResult> {
  trace("capture-start");
  await waitForCaptureReady();
  try {
    const canvas = await runCaptureAttempt(scrollElements, false);
    trace("capture-ok");
    return { canvas, source: "dom" };
  } catch (error) {
    const firstReason = errorMessage(error);
    trace("capture-fail-p1", firstReason);

    // html2canvas cannot be cancelled. If it hits our timeout, starting another
    // html2canvas immediately would create two expensive full-page renderers at
    // once and is worse for the employee. Fall back without a second render.
    if (isCaptureTimeout(error)) {
      trace("capture-fallback-timeout", firstReason);
      return { canvas: buildFallbackCanvas(firstReason), source: "fallback", failureReason: firstReason };
    }

    try {
      const canvas = await runCaptureAttempt(scrollElements, true);
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
  const captured = await captureCanvas(input.scrollElements);
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
      // An unreadable canvas has no comparable signature; always ship it so the
      // watcher sees the page instead of an unexplained empty viewer.
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
  } = encodeWithFallback(captured.canvas, input.fast, captured.source);
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
  const uploadController = new AbortController();
  const uploadTimeout = setTimeout(() => uploadController.abort(), UPLOAD_TIMEOUT_MS);
  try {
    const response = await fetch("/api/screen-feed", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      signal: uploadController.signal,
      body: JSON.stringify({
        dataUrl: encoded.dataUrl,
        clicks,
        cursor: input.cursor,
        viewport: buildViewportMetadata(),
        clientCapturedAt: new Date(completedAt).toISOString(),
        capture: {
          width: encoded.canvas.width,
          height: encoded.canvas.height,
          source,
          quality: encoded.quality,
          encodedBytes: approximateDataUrlBytes(encoded.dataUrl),
          durationMs: completedAt - startedAt,
          failureReason,
        },
      }),
    });
    if (!response.ok) trace("upload-rejected", String(response.status));
    return {
      uploaded: response.ok,
      unchanged: false,
      failed: !response.ok,
      cancelled: false,
      signature,
      latestClickTs,
      durationMs: Math.max(0, Date.now() - startedAt),
      ...(!response.ok
        ? { failureStage: "upload" as const, failureReason: `Screen frame upload rejected (${response.status}).` }
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
  } finally {
    clearTimeout(uploadTimeout);
  }
}
