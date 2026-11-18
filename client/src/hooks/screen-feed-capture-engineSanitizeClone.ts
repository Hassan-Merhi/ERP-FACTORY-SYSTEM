// Extracted from ./screen-feed-capture-engine.ts to keep that module under the source-size cap.
import {
  getScreenFeedCaptureScale,
  isSafeScreenFeedAssetUrl,
  shouldPreserveScreenFeedBackground,
} from "./screen-feed-viewing-quality";
import { normalizeUnsupportedScreenFeedColors } from "./screen-feed-color-compat";

export const CAPTURE_TIMEOUT_MS = 9000;

export const RETRY_CAPTURE_TIMEOUT_MS = 5000;

export const CLICK_RETAIN_MS = 8000;

export const MAX_JPEG_BYTES = 900_000;

export const FAST_MAX_JPEG_BYTES = 420_000;

export const SIGNATURE_WIDTH = 32;

export const FAST_CAPTURE_WIDTH = 1120;

export const STANDARD_CAPTURE_WIDTH = 1440;

const MIN_CAPTURE_SCALE = 0.4;

const SCROLL_KEY_ATTRIBUTE = "data-screenfeed-scroll-key";

const isDev = import.meta.env.DEV;

type Html2Canvas = (typeof import("html2canvas-pro"))["default"];

export type CaptureSource = "dom" | "retry" | "fallback";

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

export interface EncodedFrame {
  blob: Blob;
  canvas: HTMLCanvasElement;
  quality: number;
}

export interface CaptureCanvasResult {
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
    html2canvasPromise = import("html2canvas-pro")
      .then((module) => module.default)
      .catch((error) => {
        html2canvasPromise = null;
        throw error;
      });
  }
  return html2canvasPromise;
}

export function trace(event: string, extra?: string): void {
  if (!isDev) return;
  const url = `/api/screen-feed/trace/${encodeURIComponent(event)}${extra ? `?d=${encodeURIComponent(extra)}` : ""}`;
  fetch(url, { credentials: "include" }).catch(() => {});
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 180) : String(error).slice(0, 180);
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

export function prepareScrollableSnapshot(scrollElements: Iterable<HTMLElement>): ScrollSnapshotLease {
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

  doc.querySelectorAll<HTMLElement>("[style]").forEach((element) => {
    const backgroundImage = element.style.backgroundImage;
    if (backgroundImage && backgroundImage !== "none" && !shouldPreserveScreenFeedBackground(backgroundImage, origin)) {
      element.style.backgroundImage = "none";
    }
  });
}

export function buildHtml2CanvasOptions(
  snapshot: Map<string, { top: number; left: number }>,
  recoverColors: boolean,
  fast: boolean
) {
  const nativeScale = getScreenFeedCaptureScale(window.devicePixelRatio);
  // Render directly at the final JPEG size instead of rendering extra pixels
  // and resizing a second canvas on every live frame.
  const targetWidth = fast ? FAST_CAPTURE_WIDTH : STANDARD_CAPTURE_WIDTH;
  const viewportScale = Math.min(1, targetWidth / Math.max(1, window.innerWidth));
  const captureScale = Math.max(MIN_CAPTURE_SCALE, Math.min(nativeScale, viewportScale));

  return {
    scale: captureScale,
    useCORS: true,
    allowTaint: false,
    logging: false,
    // ForeignObject rendering taints Chromium canvases. The regular renderer
    // produces a canvas that can be encoded directly into a JPEG Blob.
    foreignObjectRendering: false,
    imageTimeout: 1800,
    removeContainer: true,
    onclone: (doc: Document) => {
      sanitizeClone(doc, snapshot);
      if (recoverColors) normalizeUnsupportedScreenFeedColors(doc);
    },
    ignoreElements: (element: Element) => element.getAttribute("data-screenfeed-ignore") === "true",
  } as const;
}

export async function tryCapture(opts: Record<string, unknown>, timeoutMs: number): Promise<HTMLCanvasElement> {
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

export function buildFallbackCanvas(reason: string): HTMLCanvasElement {
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
