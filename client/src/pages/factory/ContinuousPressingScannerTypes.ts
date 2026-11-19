// Extracted from ./ContinuousPressingScanner.tsx to keep that module under the source-size cap.

export type PressingScanCapture = {
  barcode: string;
  deviceCapturedAt: string;
  assignmentId: number;
  machineId: number;
};

export type PressingScanOutcome = {
  kind: "confirmed" | "duplicate" | "rejected" | "queued" | "preview";
  message: string;
  confirmedAt?: string;
  confirmationId?: number;
  referenceNumber?: string;
  productionDate?: string;
  timezoneName?: string;
  weightKg?: string;
  machineName?: string;
  scannedBy?: string;
};

export type PressingScannerAssignment = {
  assignmentId: number;
  machineId: number;
  machineCode: string;
  machineName: string;
  machineActive: boolean;
};

export type ScanFeedback = PressingScanOutcome["kind"] | "processing";

export type ScannerStatus = "idle" | "starting" | "scanning" | "manual" | "error";

export type AudioContextLike = AudioContext & { close(): Promise<void> };

export type WebkitAudio = Window & { webkitAudioContext?: typeof AudioContext };

export type ScreenWakeLock = { release(): Promise<void> };

export type ScreenWakeLockNavigator = Navigator & { wakeLock?: { request(type: "screen"): Promise<ScreenWakeLock> } };

export type TorchCapabilities = MediaTrackCapabilities & { torch?: boolean; focusMode?: string[] };

// Schedule only after each decoder call finishes; avoid overlapping ZXing work.
// Native can poll faster because it is hardware accelerated.
export const SCAN_POLL_MS = { native: 70, zxing: 90 } as const;
