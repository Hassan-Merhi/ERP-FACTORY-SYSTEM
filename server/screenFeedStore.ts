export interface ClickEvent {
  x: number;
  y: number;
  label?: string;
  ts: number;
}

export interface ScreenFeedCursor {
  x: number;
  y: number;
  ts: number;
  visible: boolean;
}

export interface ScreenFeedViewport {
  width: number;
  height: number;
  scrollX: number;
  scrollY: number;
  documentWidth: number;
  documentHeight: number;
  devicePixelRatio: number;
  visualScale: number;
}

export interface ScreenFeedCaptureInfo {
  width: number;
  height: number;
  source: "dom" | "retry" | "fallback";
  quality: number;
  encodedBytes: number;
  durationMs: number;
  failureReason?: string;
}

export type ScreenFeedFailureStage = "capture" | "encode" | "upload" | "capture-or-upload" | "pipeline";

export interface ScreenFeedFailureInfo {
  stage: ScreenFeedFailureStage;
  reason: string;
  occurredAt: Date;
  durationMs?: number;
}

export interface ScreenFrame {
  dataUrl: string;
  capturedAt: Date;
  clientCapturedAt?: Date;
  userId: string;
  username: string;
  tabId: string;
  clicks: ClickEvent[];
  cursor?: ScreenFeedCursor | null;
  viewport?: ScreenFeedViewport;
  capture?: ScreenFeedCaptureInfo;
}

export const LEGACY_SCREEN_FEED_TAB_ID = "legacy";

export function normalizeScreenFeedTabId(value: unknown): string {
  if (typeof value !== "string") return LEGACY_SCREEN_FEED_TAB_ID;
  const clean = value.trim().slice(0, 160);
  return clean || LEGACY_SCREEN_FEED_TAB_ID;
}

export function screenFeedStoreKey(userId: string, tabId: unknown): string {
  return `${String(userId).trim().slice(0, 128)}\u0000${normalizeScreenFeedTabId(tabId)}`;
}

// Recovery-only stores. The primary frame path is the binary WebSocket relay,
// but fallback HTTP/SSE state is still tab-addressed so two ERP tabs can never
// overwrite each other during a reconnect.
export const screenFeedStore = new Map<string, ScreenFrame>();

// Latest sanitized capture/upload failure per user+tab. This contains
// diagnostic metadata only — never image bytes, page text, form values or route contents.
export const screenFeedFailureStore = new Map<string, ScreenFeedFailureInfo>();

// Latest pointer position per user+tab.
export const screenFeedCursorStore = new Map<string, ScreenFeedCursor>();

// Tracks the last time a controller polled a specific user+tab feed.
export const watcherPollStore = new Map<string, number>();

// Evict frames, diagnostics, cursors, and stale watcher polls older than 2 minutes.
setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 1000;
  const cutoffDt = new Date(cutoff);
  for (const [key, frame] of screenFeedStore.entries()) {
    if (frame.capturedAt < cutoffDt) screenFeedStore.delete(key);
  }
  for (const [key, failure] of screenFeedFailureStore.entries()) {
    if (failure.occurredAt < cutoffDt) screenFeedFailureStore.delete(key);
  }
  for (const [key, cursor] of screenFeedCursorStore.entries()) {
    if (cursor.ts < cutoff) screenFeedCursorStore.delete(key);
  }
  for (const [key, ts] of watcherPollStore.entries()) {
    if (ts < cutoff) watcherPollStore.delete(key);
  }
}, 60 * 1000);
