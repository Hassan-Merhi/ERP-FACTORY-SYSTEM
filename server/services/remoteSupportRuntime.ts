export type RemoteSupportFlagName =
  | "screenFeedEnabled"
  | "fastScreenFeed"
  | "remoteControl"
  | "keyboardControl"
  | "sensitiveActionProtection";

export interface RemoteSupportFlags {
  screenFeedEnabled: boolean;
  fastScreenFeed: boolean;
  remoteControl: boolean;
  keyboardControl: boolean;
  sensitiveActionProtection: boolean;
}

export interface RemoteSupportLatencySummary {
  count: number;
  averageMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  lastMs: number | null;
}

export interface RemoteSupportLatencySnapshot {
  captureDurationMs: RemoteSupportLatencySummary;
  frameIntervalMs: RemoteSupportLatencySummary;
  clientToServerMs: RemoteSupportLatencySummary;
  serverToViewerMs: RemoteSupportLatencySummary;
  clientToViewerMs: RemoteSupportLatencySummary;
  commandSentToExecutedMs: RemoteSupportLatencySummary;
  commandExecutedToVisibleFrameMs: RemoteSupportLatencySummary;
  commandSentToVisibleFrameMs: RemoteSupportLatencySummary;
}

export interface RemoteSupportMetricsSnapshot {
  watcherStatusPolls: number;
  viewerPolls: number;
  liveStatusConnections: number;
  liveViewerConnections: number;
  framesAccepted: number;
  framesRejected: number;
  framesPushed: number;
  totalFrameBytes: number;
  averageFrameBytes: number;
  lastFrameBytes: number | null;
  lastFrameAcceptedAt: string | null;
  lastViewerPollAt: string | null;
  commandsSent: number;
  commandsExecuted: number;
  clickCommandsSent: number;
  clickCommandsExecuted: number;
  clickSuccessRate: number | null;
  latency: RemoteSupportLatencySnapshot;
  startedAt: string;
}

export interface RemoteSupportRuntimeSnapshot {
  flags: RemoteSupportFlags;
  revision: number;
  updatedAt: string;
  updatedBy: string;
  hardDisabled: boolean;
  metrics: RemoteSupportMetricsSnapshot;
}

type RemoteSupportMetric =
  | "watcherStatusPoll"
  | "viewerPoll"
  | "liveStatusConnected"
  | "liveViewerConnected"
  | "frameAccepted"
  | "frameRejected"
  | "framePushed";

type LatencyName = keyof RemoteSupportLatencySnapshot;

interface CommandTiming {
  commandId: string;
  feedKey: string;
  commandType: string;
  sentAt: number;
  executedAt: number | null;
  status: string | null;
}

const HARD_DISABLED = process.env.DISABLE_SCREEN_FEED === "true";
const startedAt = new Date();
const MAX_LATENCY_SAMPLES = 512;
const MAX_FRAME_TIMING_ENTRIES = 2048;
const MAX_COMMAND_TIMING_ENTRIES = 2048;
const MAX_REASONABLE_LATENCY_MS = 5 * 60 * 1000;

function productionFeatureEnabled(environmentKey: string): boolean {
  if (HARD_DISABLED || process.env.NODE_ENV !== "production") return false;
  return process.env[environmentKey]?.trim().toLowerCase() !== "false";
}

function fastScreenFeedBootEnabled(): boolean {
  if (HARD_DISABLED) return false;
  return process.env.REMOTE_SUPPORT_FAST_SCREEN_FEED?.trim().toLowerCase() !== "false";
}

const productionRemoteControlEnabled = productionFeatureEnabled("REMOTE_SUPPORT_REMOTE_CONTROL");
const productionKeyboardControlEnabled =
  productionRemoteControlEnabled && productionFeatureEnabled("REMOTE_SUPPORT_KEYBOARD_CONTROL");

const bootFlags: RemoteSupportFlags = {
  screenFeedEnabled: !HARD_DISABLED,
  // The binary WebSocket transport is the normal screen-view path. Deployments
  // can explicitly opt out, and the Developer runtime switch remains an
  // immediate rollback path.
  fastScreenFeed: fastScreenFeedBootEnabled(),
  remoteControl: productionRemoteControlEnabled,
  keyboardControl: productionKeyboardControlEnabled,
  sensitiveActionProtection: true,
};

let flags: RemoteSupportFlags = { ...bootFlags };
let revision = 1;
let updatedAt = startedAt;
let updatedBy = "system";

const metrics = {
  watcherStatusPolls: 0,
  viewerPolls: 0,
  liveStatusConnections: 0,
  liveViewerConnections: 0,
  framesAccepted: 0,
  framesRejected: 0,
  framesPushed: 0,
  totalFrameBytes: 0,
  lastFrameBytes: null as number | null,
  lastFrameAcceptedAt: null as Date | null,
  lastViewerPollAt: null as Date | null,
  commandsSent: 0,
  commandsExecuted: 0,
  clickCommandsSent: 0,
  clickCommandsExecuted: 0,
};

const latencySamples: Record<LatencyName, number[]> = {
  captureDurationMs: [],
  frameIntervalMs: [],
  clientToServerMs: [],
  serverToViewerMs: [],
  clientToViewerMs: [],
  commandSentToExecutedMs: [],
  commandExecutedToVisibleFrameMs: [],
  commandSentToVisibleFrameMs: [],
};

const lastCapturedAtByFeed = new Map<string, number>();
const frameReceivedAt = new Map<string, number>();
const commandTimings = new Map<string, CommandTiming>();

function normalizeFlags(next: RemoteSupportFlags): RemoteSupportFlags {
  const normalized = { ...next };

  if (HARD_DISABLED || !normalized.screenFeedEnabled) {
    normalized.screenFeedEnabled = false;
    normalized.fastScreenFeed = false;
    normalized.remoteControl = false;
    normalized.keyboardControl = false;
  }

  if (!normalized.remoteControl) {
    normalized.keyboardControl = false;
  }

  if (normalized.remoteControl || normalized.keyboardControl) {
    normalized.sensitiveActionProtection = true;
  }

  return normalized;
}

function finiteTimestamp(value: unknown): number | null {
  const numberValue = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numberValue) && numberValue > 0 ? numberValue : null;
}

function recordLatency(name: LatencyName, value: unknown): void {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric < 0 || numeric > MAX_REASONABLE_LATENCY_MS) return;
  const rounded = Math.round(numeric * 100) / 100;
  const samples = latencySamples[name];
  samples.push(rounded);
  if (samples.length > MAX_LATENCY_SAMPLES) samples.splice(0, samples.length - MAX_LATENCY_SAMPLES);
}

function percentile(sorted: readonly number[], ratio: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index] ?? 0;
}

function latencySummary(name: LatencyName): RemoteSupportLatencySummary {
  const samples = latencySamples[name];
  if (samples.length === 0) {
    return { count: 0, averageMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0, lastMs: null };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const total = samples.reduce((sum, value) => sum + value, 0);
  return {
    count: samples.length,
    averageMs: Math.round((total / samples.length) * 100) / 100,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    p99Ms: percentile(sorted, 0.99),
    maxMs: sorted[sorted.length - 1] ?? 0,
    lastMs: samples[samples.length - 1] ?? null,
  };
}

function frameTimingKey(feedKey: string, capturedAt: number): string {
  return `${feedKey}\u0001${Math.round(capturedAt)}`;
}

function trimOldestMapEntries<K, V>(map: Map<K, V>, maximum: number): void {
  while (map.size > maximum) {
    const first = map.keys().next();
    if (first.done) return;
    map.delete(first.value);
  }
}

function latencySnapshot(): RemoteSupportLatencySnapshot {
  return {
    captureDurationMs: latencySummary("captureDurationMs"),
    frameIntervalMs: latencySummary("frameIntervalMs"),
    clientToServerMs: latencySummary("clientToServerMs"),
    serverToViewerMs: latencySummary("serverToViewerMs"),
    clientToViewerMs: latencySummary("clientToViewerMs"),
    commandSentToExecutedMs: latencySummary("commandSentToExecutedMs"),
    commandExecutedToVisibleFrameMs: latencySummary("commandExecutedToVisibleFrameMs"),
    commandSentToVisibleFrameMs: latencySummary("commandSentToVisibleFrameMs"),
  };
}

function metricsSnapshot(): RemoteSupportMetricsSnapshot {
  return {
    watcherStatusPolls: metrics.watcherStatusPolls,
    viewerPolls: metrics.viewerPolls,
    liveStatusConnections: metrics.liveStatusConnections,
    liveViewerConnections: metrics.liveViewerConnections,
    framesAccepted: metrics.framesAccepted,
    framesRejected: metrics.framesRejected,
    framesPushed: metrics.framesPushed,
    totalFrameBytes: metrics.totalFrameBytes,
    averageFrameBytes: metrics.framesAccepted > 0 ? Math.round(metrics.totalFrameBytes / metrics.framesAccepted) : 0,
    lastFrameBytes: metrics.lastFrameBytes,
    lastFrameAcceptedAt: metrics.lastFrameAcceptedAt?.toISOString() ?? null,
    lastViewerPollAt: metrics.lastViewerPollAt?.toISOString() ?? null,
    commandsSent: metrics.commandsSent,
    commandsExecuted: metrics.commandsExecuted,
    clickCommandsSent: metrics.clickCommandsSent,
    clickCommandsExecuted: metrics.clickCommandsExecuted,
    clickSuccessRate:
      metrics.clickCommandsSent > 0
        ? Math.round((metrics.clickCommandsExecuted / metrics.clickCommandsSent) * 10_000) / 10_000
        : null,
    latency: latencySnapshot(),
    startedAt: startedAt.toISOString(),
  };
}

export function getRemoteSupportRuntimeSnapshot(): RemoteSupportRuntimeSnapshot {
  return {
    flags: { ...flags },
    revision,
    updatedAt: updatedAt.toISOString(),
    updatedBy,
    hardDisabled: HARD_DISABLED,
    metrics: metricsSnapshot(),
  };
}

export function isRemoteSupportEnabled(flag: RemoteSupportFlagName): boolean {
  return flags[flag];
}

export function updateRemoteSupportFlags(
  patch: Partial<RemoteSupportFlags>,
  actor: string
): RemoteSupportRuntimeSnapshot {
  const allowedKeys: RemoteSupportFlagName[] = [
    "screenFeedEnabled",
    "fastScreenFeed",
    "remoteControl",
    "keyboardControl",
    "sensitiveActionProtection",
  ];

  const safePatch = Object.fromEntries(
    Object.entries(patch).filter(
      ([key, value]) => allowedKeys.includes(key as RemoteSupportFlagName) && typeof value === "boolean"
    )
  ) as Partial<RemoteSupportFlags>;

  flags = normalizeFlags({ ...flags, ...safePatch });
  revision += 1;
  updatedAt = new Date();
  updatedBy = actor || "unknown";
  return getRemoteSupportRuntimeSnapshot();
}

export function emergencyDisableRemoteSupport(actor: string): RemoteSupportRuntimeSnapshot {
  flags = {
    screenFeedEnabled: false,
    fastScreenFeed: false,
    remoteControl: false,
    keyboardControl: false,
    sensitiveActionProtection: true,
  };
  revision += 1;
  updatedAt = new Date();
  updatedBy = actor || "unknown";
  return getRemoteSupportRuntimeSnapshot();
}

export function restoreRemoteSupportBootDefaults(actor: string): RemoteSupportRuntimeSnapshot {
  flags = normalizeFlags({ ...bootFlags });
  revision += 1;
  updatedAt = new Date();
  updatedBy = actor || "unknown";
  return getRemoteSupportRuntimeSnapshot();
}

export function recordRemoteSupportMetric(metric: RemoteSupportMetric, value?: number): void {
  switch (metric) {
    case "watcherStatusPoll":
      metrics.watcherStatusPolls += 1;
      return;
    case "viewerPoll":
      metrics.viewerPolls += 1;
      metrics.lastViewerPollAt = new Date();
      return;
    case "liveStatusConnected":
      metrics.liveStatusConnections += 1;
      return;
    case "liveViewerConnected":
      metrics.liveViewerConnections += 1;
      return;
    case "frameRejected":
      metrics.framesRejected += 1;
      return;
    case "framePushed":
      metrics.framesPushed += Number.isFinite(value) && (value ?? 0) > 0 ? Math.floor(value as number) : 1;
      return;
    case "frameAccepted": {
      const safeBytes = Number.isFinite(value) && (value ?? 0) > 0 ? Math.floor(value as number) : 0;
      metrics.framesAccepted += 1;
      metrics.totalFrameBytes += safeBytes;
      metrics.lastFrameBytes = safeBytes;
      metrics.lastFrameAcceptedAt = new Date();
      return;
    }
  }
}

/** Records capture cost and producer→server timing for the real binary frame path. */
export function recordRemoteSupportFrameReceived(input: {
  feedKey: string;
  capturedAt: number;
  serverReceivedAt?: number;
  captureDurationMs?: number | null;
}): void {
  const capturedAt = finiteTimestamp(input.capturedAt);
  const serverReceivedAt = finiteTimestamp(input.serverReceivedAt ?? Date.now());
  if (!capturedAt || !serverReceivedAt || !input.feedKey) return;

  recordLatency("clientToServerMs", serverReceivedAt - capturedAt);
  if (input.captureDurationMs != null) recordLatency("captureDurationMs", input.captureDurationMs);

  const previous = lastCapturedAtByFeed.get(input.feedKey);
  if (previous && capturedAt > previous) recordLatency("frameIntervalMs", capturedAt - previous);
  lastCapturedAtByFeed.set(input.feedKey, capturedAt);

  frameReceivedAt.set(frameTimingKey(input.feedKey, capturedAt), serverReceivedAt);
  trimOldestMapEntries(frameReceivedAt, MAX_FRAME_TIMING_ENTRIES);
}

/** Records the time the viewer painted a frame and closes any command→visible samples. */
export function recordRemoteSupportViewerRendered(input: {
  feedKey: string;
  capturedAt: number;
  viewerRenderedAt: number;
}): void {
  const capturedAt = finiteTimestamp(input.capturedAt);
  const viewerRenderedAt = finiteTimestamp(input.viewerRenderedAt);
  if (!capturedAt || !viewerRenderedAt || !input.feedKey) return;

  const frameKey = frameTimingKey(input.feedKey, capturedAt);
  const receivedAt = frameReceivedAt.get(frameKey);
  if (receivedAt) {
    recordLatency("serverToViewerMs", viewerRenderedAt - receivedAt);
    frameReceivedAt.delete(frameKey);
  }
  recordLatency("clientToViewerMs", viewerRenderedAt - capturedAt);

  for (const [commandId, timing] of commandTimings) {
    if (timing.feedKey !== input.feedKey || timing.executedAt == null || timing.status !== "executed") continue;
    // Only a frame captured after execution can contain the result of that
    // command. The viewer paint timestamp closes the full visible-latency span.
    if (capturedAt < timing.executedAt) continue;
    recordLatency("commandExecutedToVisibleFrameMs", viewerRenderedAt - timing.executedAt);
    recordLatency("commandSentToVisibleFrameMs", viewerRenderedAt - timing.sentAt);
    commandTimings.delete(commandId);
  }
}

export function recordRemoteSupportCommandTelemetry(input: {
  event: "sent" | "result";
  commandId: string;
  feedKey: string;
  commandType?: string;
  sentAt?: number;
  executedAt?: number;
  status?: string;
}): void {
  const commandId = String(input.commandId ?? "").trim().slice(0, 128);
  const feedKey = String(input.feedKey ?? "").slice(0, 320);
  if (!commandId || !feedKey) return;

  if (input.event === "sent") {
    const sentAt = finiteTimestamp(input.sentAt);
    if (!sentAt) return;
    const commandType = String(input.commandType ?? "unknown").slice(0, 80);
    const existing = commandTimings.get(commandId);
    if (!existing) {
      metrics.commandsSent += 1;
      if (commandType === "click") metrics.clickCommandsSent += 1;
    }
    commandTimings.set(commandId, {
      commandId,
      feedKey,
      commandType,
      sentAt,
      executedAt: existing?.executedAt ?? null,
      status: existing?.status ?? null,
    });
    trimOldestMapEntries(commandTimings, MAX_COMMAND_TIMING_ENTRIES);
    return;
  }

  const existing = commandTimings.get(commandId);
  const sentAt = finiteTimestamp(input.sentAt) ?? existing?.sentAt ?? null;
  const executedAt = finiteTimestamp(input.executedAt);
  if (!sentAt || !executedAt) return;
  const commandType = String(input.commandType ?? existing?.commandType ?? "unknown").slice(0, 80);
  const status = String(input.status ?? "").slice(0, 40);

  if (!existing) {
    metrics.commandsSent += 1;
    if (commandType === "click") metrics.clickCommandsSent += 1;
  }
  if (status === "executed" && existing?.status !== "executed") {
    metrics.commandsExecuted += 1;
    if (commandType === "click") metrics.clickCommandsExecuted += 1;
  }
  recordLatency("commandSentToExecutedMs", executedAt - sentAt);

  if (status !== "executed") {
    commandTimings.delete(commandId);
    return;
  }

  commandTimings.set(commandId, {
    commandId,
    feedKey,
    commandType,
    sentAt,
    executedAt,
    status,
  });
  trimOldestMapEntries(commandTimings, MAX_COMMAND_TIMING_ENTRIES);
}

export function resetRemoteSupportMetrics(): RemoteSupportRuntimeSnapshot {
  metrics.watcherStatusPolls = 0;
  metrics.viewerPolls = 0;
  metrics.liveStatusConnections = 0;
  metrics.liveViewerConnections = 0;
  metrics.framesAccepted = 0;
  metrics.framesRejected = 0;
  metrics.framesPushed = 0;
  metrics.totalFrameBytes = 0;
  metrics.lastFrameBytes = null;
  metrics.lastFrameAcceptedAt = null;
  metrics.lastViewerPollAt = null;
  metrics.commandsSent = 0;
  metrics.commandsExecuted = 0;
  metrics.clickCommandsSent = 0;
  metrics.clickCommandsExecuted = 0;
  for (const samples of Object.values(latencySamples)) samples.length = 0;
  lastCapturedAtByFeed.clear();
  frameReceivedAt.clear();
  commandTimings.clear();
  return getRemoteSupportRuntimeSnapshot();
}
