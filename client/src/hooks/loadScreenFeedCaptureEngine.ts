// Extracted from ./use-screen-feed.ts to keep that module under the source-size cap.
import type { ScreenFeedClickEvent, ScreenFeedCursorEvent, ScreenFeedFailureStage } from "./screen-feed-capture-engine";
import { reportScreenFeedModuleLoadFailure } from "./screen-feed-asset-recovery";
import { sendScreenFeedControlMessage } from "@/lib/screen-feed-binary-transport";

let captureEnginePromise: Promise<typeof import("./screen-feed-capture-engine")> | null = null;

export function loadScreenFeedCaptureEngine() {
  captureEnginePromise ??= import("./screen-feed-capture-engine")
    .then((module) => {
      window.dispatchEvent(new Event("erp:screen-feed-module-loaded"));
      return module;
    })
    .catch((error: unknown) => {
      // Do not cache a rejected promise and repeatedly fail every frame.
      captureEnginePromise = null;
      reportScreenFeedModuleLoadFailure(error);
      throw error;
    });
  return captureEnginePromise;
}

export const POLL_INTERVAL_MS = 15000;

export const UNWATCHED_POLL_INTERVAL_MS = 5000;

// Pointer telemetry is now a tiny websocket message rather than an HTTP POST.
// 100 ms is responsive enough for the remote cursor without creating request
// middleware/session-store load.
export const POINTER_INTERVAL_MS = 100;

export const BACKGROUND_MUTATION_MIN_GAP_MS = 4000;

export const INTERACTION_ACTIVE_WINDOW_MS = 2500;

export const CAPTURE_MUTATION_ATTRIBUTE_FILTER = [
  "class",
  "style",
  "value",
  "checked",
  "selected",
  "aria-expanded",
  "aria-checked",
  "data-state",
  "hidden",
];

export type ClickEvent = ScreenFeedClickEvent;

export function trimLabel(el: HTMLElement): string {
  const txt =
    el.getAttribute("aria-label") ||
    el.getAttribute("placeholder") ||
    el.getAttribute("title") ||
    el.textContent?.trim() ||
    el.tagName.toLowerCase();
  return txt.slice(0, 60);
}

export function scheduleCaptureWork(fn: () => void, interactive: boolean): void {
  if (interactive) {
    // Once a watched user interacts, do not wait up to 500ms for an idle slot.
    // Scheduling on the next paint keeps the snapshot current without a busy loop.
    window.requestAnimationFrame(() => fn());
  } else if (typeof window.requestIdleCallback === "function") {
    window.requestIdleCallback(fn, { timeout: 500 });
  } else {
    setTimeout(fn, 0);
  }
}

export function cursorsDiffer(previous: ScreenFeedCursorEvent | null, next: ScreenFeedCursorEvent): boolean {
  if (!previous) return true;
  return (
    previous.visible !== next.visible ||
    Math.abs(previous.x - next.x) > 0.002 ||
    Math.abs(previous.y - next.y) > 0.002 ||
    next.ts - previous.ts > 1000
  );
}

export function compactFailureReason(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim().slice(0, 180);
  return "Unexpected screen capture pipeline failure.";
}

export function reportCaptureFailure(
  tabId: string,
  stage: ScreenFeedFailureStage,
  reason: string,
  durationMs?: number
): void {
  sendScreenFeedControlMessage({
    type: "screen-feed:failure",
    tabId,
    failure: { stage, reason: reason.slice(0, 180), durationMs, occurredAt: new Date().toISOString() },
  });
}

export function ignoredForCapture(node: Node | null): boolean {
  const element = node instanceof Element ? node : node?.parentElement;
  if (!element) return false;
  return !!element.closest(
    "[data-screenfeed-ignore='true'], .html2canvas-container, [data-screenfeed-capture-styles='true']"
  );
}

export function mutationHasVisibleChange(records: MutationRecord[]): boolean {
  for (const record of records) {
    if (ignoredForCapture(record.target)) continue;
    if (record.type === "attributes" || record.type === "characterData") return true;
    if (record.type !== "childList") continue;
    const nodes = [...Array.from(record.addedNodes), ...Array.from(record.removedNodes)];
    if (nodes.length === 0 || nodes.some((node) => !ignoredForCapture(node))) return true;
  }
  return false;
}
