// Extracted from ./sanitizeRemoteMouseFrameViewport.ts

export type RemoteMouseCommandType = "pointer-move" | "click" | "scroll";

export type RemoteMouseCommandResultStatus = "executed" | "blocked" | "ignored";

export interface RemoteMouseFrameViewport {
  width: number;
  height: number;
  scrollX: number;
  scrollY: number;
  visualScale: number;
}

export interface RemoteMouseCommand {
  id: string;
  sessionId: string;
  targetUserId: string;
  targetTabId: string;
  type: RemoteMouseCommandType;
  sequence: number;
  x: number;
  y: number;
  deltaX?: number;
  deltaY?: number;
  /**
   * Scroll/viewport state of the screen frame the controller clicked on.
   * The target tab remaps the command's normalized point through this
   * snapshot (frame space → document space → live viewport), so viewport
   * drift between capture and execution moves the click with the content
   * the controller aimed at instead of landing on whatever moved under
   * the old position. Scroll commands are exempt from frame staleness —
   * scrolling itself invalidates the captured scroll position — but their
   * anchor point is still remapped. Absent for legacy controllers and
   * pointer-move.
   */
  frameViewport?: RemoteMouseFrameViewport;
  createdAt: number;
}

export interface RemoteMouseCommandResult {
  commandId: string;
  sessionId: string;
  status: RemoteMouseCommandResultStatus;
  reason: string | null;
  completedAt: number;
}

export interface RemoteMouseAuthorization {
  sessionId: string;
  controllerUserId: string;
  authorizedAt: number;
  expiresAt: number;
}

export type CommandListener = (command: RemoteMouseCommand) => void;

export type ResultListener = (result: RemoteMouseCommandResult) => void;

export interface RateWindow {
  startedAt: number;
  counts: Record<RemoteMouseCommandType, number>;
}

export interface RemoteMouseCommandPublication {
  command: RemoteMouseCommand;
  /**
   * Pointer moves this publication made obsolete. They were dropped from the
   * queue before delivery and are reported `ignored`/`superseded-pointer-move`
   * so the controller's in-flight accounting still balances.
   */
  supersededCommandIds: string[];
}
