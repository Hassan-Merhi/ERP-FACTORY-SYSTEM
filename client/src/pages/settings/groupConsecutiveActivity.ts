// Extracted from ./RemoteSupportWatchDialog.tsx to keep that module under the source-size cap.

export interface RemoteControlTabView {
  userId: string;
  username: string;
  tabId: string;
  companyId: number;
  route: string;
  firstSeenAt: number;
  lastSeenAt: number;
}

export interface CaptureFailure {
  stage: string;
  reason: string;
  occurredAt: string;
  durationMs?: number | null;
}

interface ScreenCaptureInfo {
  source?: "dom" | "retry" | "fallback";
  durationMs?: number;
  failureReason?: string;
}

interface ScreenFrameViewport {
  width: number;
  height: number;
  scrollX: number;
  scrollY: number;
  visualScale: number;
}

export interface ScreenFrame {
  imageUrl: string;
  capturedAt: string;
  capture?: ScreenCaptureInfo | null;
  viewport?: ScreenFrameViewport | null;
}

export interface ActivityEvent {
  id: string | number;
  route: string;
  occurredAt: string;
}

interface GroupedActivityEvent extends ActivityEvent {
  count: number;
}

export type DisplayMode = "fit" | "actual";

export function groupConsecutiveActivity(activity: ActivityEvent[]): GroupedActivityEvent[] {
  const grouped: GroupedActivityEvent[] = [];
  for (const event of activity) {
    const previous = grouped[grouped.length - 1];
    if (previous && previous.route === event.route) {
      previous.count += 1;
      continue;
    }
    grouped.push({ ...event, count: 1 });
  }
  return grouped;
}

export function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function readViewport(value: unknown): ScreenFrameViewport | null {
  const record = objectRecord(value);
  if (!record) return null;
  const width = Number(record.width);
  const height = Number(record.height);
  const scrollX = Number(record.scrollX);
  const scrollY = Number(record.scrollY);
  const visualScale = Number(record.visualScale);
  if (![width, height, scrollX, scrollY, visualScale].every(Number.isFinite)) return null;
  return { width, height, scrollX, scrollY, visualScale };
}

export function readCapture(value: unknown): ScreenCaptureInfo | null {
  const record = objectRecord(value);
  if (!record) return null;
  const source =
    record.source === "dom" || record.source === "retry" || record.source === "fallback" ? record.source : undefined;
  return {
    source,
    durationMs: typeof record.durationMs === "number" ? record.durationMs : undefined,
    failureReason: typeof record.failureReason === "string" ? record.failureReason : undefined,
  };
}

export function captureFailureFromMetadata(
  metadata: Record<string, unknown>,
  capturedAt: string
): CaptureFailure | null {
  const capture = readCapture(metadata.capture);
  if (!capture?.failureReason) return null;
  return {
    stage: capture.source === "fallback" ? "capture" : "encode",
    reason: capture.failureReason,
    occurredAt: capturedAt,
    durationMs: capture.durationMs ?? null,
  };
}

export function byteRangeToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const start = bytes.byteOffset;
  const end = start + bytes.byteLength;
  return bytes.buffer.slice(start, end) as ArrayBuffer;
}
