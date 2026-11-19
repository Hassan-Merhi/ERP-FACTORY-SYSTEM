// Extracted from ./getRemoteMouseFrameContentBox.ts

export type RemoteMouseCommandType = "pointer-move" | "click" | "scroll";

export type RemoteMouseExecutionStatus = "executed" | "blocked" | "ignored";

export interface RemoteMouseFrameViewport {
  width: number;
  height: number;
  scrollX: number;
  scrollY: number;
  visualScale: number;
}

export interface RemoteMouseCommandView {
  id: string;
  sessionId: string;
  type: RemoteMouseCommandType;
  sequence: number;
  x: number;
  y: number;
  deltaX?: number;
  deltaY?: number;
  frameViewport?: RemoteMouseFrameViewport;
  createdAt?: string;
}

export interface RemoteMouseExecutionResult {
  status: RemoteMouseExecutionStatus;
  reason: string | null;
  clientX: number;
  clientY: number;
}

export interface RemoteMouseExecutionOptions {
  keyboardEnabled?: boolean;
}

export interface RemoteMouseFrameSize {
  width: number;
  height: number;
}

export interface RemoteMouseViewportMetrics {
  width: number;
  height: number;
  scrollX: number;
  scrollY: number;
}

export interface RemoteMouseFramePointMapping {
  clientX: number;
  clientY: number;
  /** False when the remapped frame point fell outside the live viewport. */
  onScreen: boolean;
}
