// Extracted from ./screen-feed-capture-engineSanitizeClone.ts

export type Html2Canvas = (typeof import("html2canvas-pro"))["default"];

export type CaptureSource = "dom" | "retry" | "fallback";

export type ScreenFeedFailureStage = "render" | "encode" | "upload" | "pipeline";

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

export interface ScrollSnapshotLease {
  snapshot: Map<string, { top: number; left: number }>;
  restore: () => void;
}
